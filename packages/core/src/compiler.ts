/**
 * The minute compiler: the on-device half of the measurement model
 * (spec v7 §3, §6, §7; data-flow stages 02–03).
 *
 * Player inputs drive a fixed state machine. Exact timings accumulate at full
 * resolution, the classification ruleset turns observations into issue bits,
 * counters and bucketed durations, and at each UTC wall-clock minute boundary
 * the accumulators are sealed into one ExperienceMinute. PlaybackAttempt and
 * PlaybackInterval records are emitted as acquisition and consumption happen.
 *
 * The compiler never sees a cohort, a population statistic or a
 * server-derived dimension. It measures and classifies; everything else
 * happens server-side.
 */
import {
  clientBucket,
  bitrateBucket,
  NO_BUCKET,
} from "./ladder.js";
import {
  AssetType,
  ContextChangeFlag,
  INTENT_STATES,
  IssueBit,
  PlayerState,
  RecordFlag,
  TERMINAL_STATES,
  isAdAsset,
  type ContextChangeCode,
  type ErrorDomain,
  type Observations,
} from "./vocabulary.js";
import {
  BUCKET_SOURCE,
  RulesetError,
  compileRuleset,
  ruleMatches,
  type CompiledRule,
  type CompiledRuleset,
  type RulesetSpec,
  type Trigger,
} from "./ruleset.js";
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_RULESET,
  resolveThresholds,
  type Thresholds,
} from "./default-ruleset.js";
import type {
  ClientDimensions,
  CompiledRecord,
  ContextDefinition,
  ExperienceMinute,
  IntervalEndReason,
  PlaybackAttempt,
  PlaybackInterval,
  TerminalReason,
} from "./records.js";

export const MINUTE_MS = 60_000;

/** Normalised player inputs. Platform adapters map native events onto these. */
export type PlayerInput =
  | { type: "initiate"; t: number; attempt_id?: string }
  | { type: "retry"; t: number }
  | { type: "state"; t: number; state: "PLAYING" | "BUFFERING" | "PAUSED" | "SEEKING"; position_ms?: number }
  | { type: "progress"; t: number; position_ms: number }
  | { type: "rendition"; t: number; index: number; max_index: number; bitrate_kbps: number }
  | {
      type: "asset";
      t: number;
      asset_id: string;
      asset_type: AssetType;
      duration_ms: number | null;
      program_id?: string;
      is_live?: boolean;
      ad_pod_position?: number;
    }
  | { type: "error"; t: number; domain: ErrorDomain; code: string; fatal: boolean }
  | { type: "context_change"; t: number; flag: ContextChangeCode; dimensions?: Partial<ClientDimensions> }
  | { type: "end"; t: number; reason: TerminalReason }
  | { type: "tick"; t: number };

export interface CompilerConfig {
  playback_id: string;
  session_id: string;
  dimensions: ClientDimensions;
  /** Remote ruleset. Invalid or absent → the compiled-in known-good pack. */
  ruleset?: RulesetSpec;
  /** Remote threshold profile values; out-of-range values are rejected locally. */
  thresholds?: Partial<Record<string, unknown>>;
  threshold_profile_id?: number;
  taxonomy_version?: number;
  eligibility_policy_version?: number;
  attempt_policy_version?: number;
  /** A minute is eligible with at least this much intent, or with any observed issue (§3.5). */
  min_intent_s?: number;
  /** Device-to-UTC offset from the upload ACK; null until the first ACK (§7). */
  clock_offset_ms?: number | null;
  /** Tick-rule cadence in player time. */
  tick_ms?: number;
  /** First sequence number; non-zero only when resuming a persisted playback. */
  start_sequence?: number;
  /** Keep exact measurements on each minute record for tests and debug builds. */
  debug?: boolean;
  onRecord?: (r: CompiledRecord) => void;
}

/** Allowed transitions of the fixed state machine (§6.1). ERROR is reachable from anywhere. */
const TRANSITIONS: Record<string, ReadonlySet<PlayerState>> = {
  [PlayerState.STARTING]: new Set([PlayerState.PLAYING, PlayerState.PAUSED, PlayerState.SEEKING]),
  [PlayerState.PLAYING]: new Set([PlayerState.BUFFERING, PlayerState.PAUSED, PlayerState.SEEKING]),
  [PlayerState.BUFFERING]: new Set([PlayerState.PLAYING, PlayerState.PAUSED, PlayerState.SEEKING]),
  [PlayerState.PAUSED]: new Set([PlayerState.PLAYING, PlayerState.BUFFERING, PlayerState.SEEKING]),
  [PlayerState.SEEKING]: new Set([PlayerState.PLAYING, PlayerState.BUFFERING, PlayerState.PAUSED]),
};

/** Lag between wall clock and media position below this is jitter, not a stall. */
const PROGRESS_JITTER_MS = 250;

interface MinuteAcc {
  intentMs: number;
  activeMs: number;
  adIntentMs: number;
  adActiveMs: number;
  contentBits: number;
  adBits: number;
  rebufferCount: number;
  rebufferMs: number;
  adRebufferCount: number;
  adRebufferMs: number;
  freezeCount: number;
  freezeMs: number;
  startupMs: number | null;
  errorCount: number;
  adErrorCount: number;
  kbpsMs: number;
  peakMs: number;
  ctxFlags: number;
}

const emptyMinute = (): MinuteAcc => ({
  intentMs: 0, activeMs: 0, adIntentMs: 0, adActiveMs: 0, contentBits: 0, adBits: 0,
  rebufferCount: 0, rebufferMs: 0, adRebufferCount: 0, adRebufferMs: 0,
  freezeCount: 0, freezeMs: 0, startupMs: null, errorCount: 0, adErrorCount: 0,
  kbpsMs: 0, peakMs: 0, ctxFlags: 0,
});

interface IntervalAcc {
  start_ts: number;
  asset_id: string;
  program_id: string | null;
  asset_type: AssetType;
  duration_asset_ms: number | null;
  context_id: number;
  activeMs: number;
  kbpsMs: number;
  issues: number;
  maxPositionMs: number;
}

export interface CompilerStats {
  /** Inputs that asked for a transition the fixed state machine does not allow. */
  rejected_transitions: number;
  /** Set when the remote ruleset failed validation and the known-good pack is in force. */
  ruleset_fallback: string | null;
  /** Remote threshold keys rejected by sanity bounds (§13.1). */
  rejected_thresholds: string[];
  minutes_sealed: number;
}

export class MinuteCompiler {
  readonly playbackId: string;
  readonly sessionId: string;
  readonly thresholds: Thresholds;
  readonly stats: CompilerStats;

  private readonly cfg: Required<
    Pick<CompilerConfig, "taxonomy_version" | "eligibility_policy_version" | "attempt_policy_version" | "min_intent_s" | "tick_ms" | "threshold_profile_id" | "debug">
  >;
  private readonly rules: CompiledRuleset;
  private readonly capIntent: boolean;
  private readonly onRecord: ((r: CompiledRecord) => void) | undefined;
  private readonly out: CompiledRecord[] = [];

  private clockOffset: number | null;
  private now: number | null = null;
  private minuteStart: number | null = null;
  private sequence: number;

  private state: PlayerState = PlayerState.NOT_STARTED;
  private prevState: PlayerState = PlayerState.NOT_STARTED;
  private stateSince = 0;
  private segmentId = 0;
  private bufferingCount = 0;

  private renditionIndex = 0;
  private renditionMax = 0;
  private kbps = 0;
  private renditionSince = 0;
  private renditionEpisode = 0;

  private lastPosition: number | null = null;
  private lastProgressAt = 0;
  private progressStall = 0;
  private progressEpisode = 0;

  private errorDomain: ErrorDomain = "none";
  private errorCode = "";
  private errorFatal = false;

  private asset: { id: string; type: AssetType; duration_ms: number | null; program_id: string | null; is_live: boolean; pod: number } = {
    id: "unknown", type: AssetType.CONTENT, duration_ms: null, program_id: null, is_live: false, pod: 0,
  };
  private interval: IntervalAcc | null = null;
  private attempt: PlaybackAttempt | null = null;
  private attemptSeq = 0;

  private dims: ClientDimensions;
  private readonly contexts = new Map<string, number>();
  private contextId = 0;

  private acc: MinuteAcc = emptyMinute();
  /** Rule id → episode key of its last application, so a tick rule counts once per episode. */
  private readonly fired = new Map<string, string>();
  private pendingTerminal: TerminalReason | null = null;
  private readonly obs: Observations;

  constructor(config: CompilerConfig) {
    this.playbackId = config.playback_id;
    this.sessionId = config.session_id;
    this.dims = { ...config.dimensions };
    this.onRecord = config.onRecord;
    this.clockOffset = config.clock_offset_ms ?? null;
    this.sequence = config.start_sequence ?? 0;
    this.cfg = {
      taxonomy_version: config.taxonomy_version ?? 3,
      eligibility_policy_version: config.eligibility_policy_version ?? 2,
      attempt_policy_version: config.attempt_policy_version ?? 1,
      min_intent_s: config.min_intent_s ?? 5,
      tick_ms: config.tick_ms ?? 1_000,
      threshold_profile_id: config.threshold_profile_id ?? DEFAULT_PROFILE_ID,
      debug: config.debug ?? false,
    };
    const { thresholds, rejected } = resolveThresholds(config.thresholds);
    this.thresholds = thresholds;
    this.stats = { rejected_transitions: 0, ruleset_fallback: null, rejected_thresholds: rejected, minutes_sealed: 0 };

    const platform = { os: this.dims.os, os_version: this.dims.os_version };
    let rules: CompiledRuleset;
    try {
      rules = compileRuleset(config.ruleset ?? DEFAULT_RULESET, platform, thresholds);
    } catch (err) {
      if (!(err instanceof RulesetError) || !config.ruleset) throw err;
      this.stats.ruleset_fallback = err.message;
      rules = compileRuleset(DEFAULT_RULESET, platform, thresholds);
    }
    this.rules = rules;
    this.capIntent = Object.values(rules.byTrigger).some((list) => list.some((r) => r.emit.cap_intent));

    this.obs = {
      state: PlayerState.NOT_STARTED, prev_state: PlayerState.NOT_STARTED, next_state: PlayerState.NOT_STARTED,
      state_duration_ms: 0, buffering_ms_continuous: 0, buffering_count: 0, startup_ms: 0,
      position_delta_ms: 0, wallclock_delta_ms: 0, progress_stall_ms: 0,
      rendition_index: 0, rendition_max_index: 0, rendition_ms: 0,
      error_domain: "none", error_code: "", error_fatal: false, drm_state: "none",
      asset_type: AssetType.CONTENT, is_live: false, ad_pod_position: 0,
      network_type: this.dims.connection_type, player_version: this.dims.player_version,
    };

    // Context registration never blocks first telemetry (§5): the id is
    // assigned locally and the definition queued with the first records.
    this.contextId = this.registerContext(this.dims);
  }

  get rulesetVersion(): number {
    return this.rules.version;
  }

  get currentState(): PlayerState {
    return this.state;
  }

  get sequenceNo(): number {
    return this.sequence;
  }

  /** Apply the clock offset from an upload ACK. Takes effect from the next minute boundary. */
  setClockOffset(ms: number): void {
    this.clockOffset = ms;
  }

  /** Records produced since the last drain, in emission order. */
  drain(): CompiledRecord[] {
    return this.out.splice(0, this.out.length);
  }

  push(input: PlayerInput): void {
    if (this.now === null) {
      this.now = input.t;
      this.minuteStart = this.bucketOf(input.t);
    }
    if (input.t < this.now) return; // out-of-order input: the past is already sealed
    this.advanceTo(input.t);
    if (this.isTerminal() && input.type !== "tick") return;

    switch (input.type) {
      case "tick":
        break;
      case "initiate":
        this.initiate(input.t, input.attempt_id);
        break;
      case "retry":
        if (this.attempt && this.state === PlayerState.STARTING) this.attempt.retry_count++;
        break;
      case "state":
        if (input.position_ms !== undefined) this.observeProgress(input.t, input.position_ms);
        this.transition(input.t, input.state);
        break;
      case "progress":
        this.observeProgress(input.t, input.position_ms);
        break;
      case "rendition":
        if (input.index !== this.renditionIndex || input.max_index !== this.renditionMax) {
          this.renditionSince = input.t;
          this.renditionEpisode++;
        }
        this.renditionIndex = input.index;
        this.renditionMax = input.max_index;
        this.kbps = input.bitrate_kbps;
        break;
      case "asset":
        this.switchAsset(input);
        break;
      case "error":
        this.onError(input.t, input.domain, input.code, input.fatal);
        break;
      case "context_change":
        this.acc.ctxFlags |= 1 << ContextChangeFlag[input.flag];
        if (input.dimensions) {
          this.dims = { ...this.dims, ...input.dimensions };
          this.contextId = this.registerContext(this.dims);
          this.acc.ctxFlags |= 1 << ContextChangeFlag.CONTEXT_CHANGE;
        }
        break;
      case "end":
        this.terminate(input.t, input.reason);
        break;
    }
    this.flushPendingTerminal();
  }

  // ── time ─────────────────────────────────────────────────────────────

  private bucketOf(deviceT: number): number {
    const utc = deviceT + (this.clockOffset ?? 0);
    return Math.floor(utc / MINUTE_MS) * MINUTE_MS;
  }

  /** Device time at which the current minute ends. */
  private boundaryDeviceT(): number {
    return (this.minuteStart as number) + MINUTE_MS - (this.clockOffset ?? 0);
  }

  private advanceTo(t: number): void {
    let now = this.now as number;
    const tick = this.cfg.tick_ms;
    while (now < t) {
      const boundary = this.boundaryDeviceT();
      const nextTick = Math.floor(now / tick) * tick + tick;
      const step = Math.min(t, boundary, nextTick);
      this.accrue(now, step);
      now = step;
      this.now = now;
      if (now === nextTick && this.isLive()) {
        this.evaluate("tick", now);
        this.flushPendingTerminal();
      }
      if (now === boundary) this.sealMinute(now, false);
      if (this.isTerminal()) {
        // Nothing accrues after a terminal state; jump to the input time.
        this.now = t;
        if (this.minuteStart !== null && t >= this.boundaryDeviceT()) this.minuteStart = this.bucketOf(t);
        return;
      }
    }
  }

  private isLive(): boolean {
    return this.state !== PlayerState.NOT_STARTED && !TERMINAL_STATES.has(this.state);
  }

  private isTerminal(): boolean {
    return TERMINAL_STATES.has(this.state);
  }

  /** Add the time in [a, b) to the open minute and interval. */
  private accrue(a: number, b: number): void {
    const dt = b - a;
    if (dt <= 0 || !this.isLive()) return;
    const ad = isAdAsset(this.asset.type);
    if (INTENT_STATES.has(this.state)) {
      let intent = dt;
      if (this.capIntent && this.state === PlayerState.BUFFERING) {
        const cap = this.thresholds.stall_timeout_ms + this.thresholds.stall_grace_ms;
        const already = a - this.stateSince;
        intent = Math.max(0, Math.min(dt, cap - already));
      }
      if (ad) this.acc.adIntentMs += intent;
      else this.acc.intentMs += intent;
    }
    if (this.state === PlayerState.PLAYING) {
      if (ad) this.acc.adActiveMs += dt;
      else this.acc.activeMs += dt;
      this.acc.kbpsMs += this.kbps * dt;
      if (this.renditionMax > 0 && this.renditionIndex >= this.renditionMax) this.acc.peakMs += dt;
      if (this.interval) {
        this.interval.activeMs += dt;
        this.interval.kbpsMs += this.kbps * dt;
      }
    }
  }

  // ── state machine ────────────────────────────────────────────────────

  private initiate(t: number, attemptId?: string): void {
    if (this.state !== PlayerState.NOT_STARTED) return;
    this.attempt = {
      attempt_id: attemptId ?? `${this.playbackId}:${++this.attemptSeq}`,
      playback_id: this.playbackId,
      session_id: this.sessionId,
      context_id: this.contextId,
      initiation_ts: this.utc(t),
      terminal_ts: null,
      result: "UNKNOWN",
      failure_type: null,
      startup_duration_ms: null,
      retry_count: 0,
      attempt_policy_version: this.cfg.attempt_policy_version,
      provisional: true,
    };
    // The provisional record is written before the outcome is known, so an
    // app killed during startup still leaves an attempt behind (§3.3).
    this.emit({ kind: "attempt", record: { ...this.attempt } });
    this.enter(t, PlayerState.STARTING);
    if (!this.interval) this.openInterval(t);
  }

  private transition(t: number, next: PlayerState): void {
    if (next === this.state) return;
    // Buffering before the first frame is still startup.
    if (this.state === PlayerState.STARTING && next === PlayerState.BUFFERING) return;
    const allowed = TRANSITIONS[this.state];
    if (!allowed || !allowed.has(next)) {
      this.stats.rejected_transitions++;
      return;
    }
    if (this.state === PlayerState.STARTING && next === PlayerState.PLAYING && this.attempt) {
      this.attempt.startup_duration_ms = this.utc(t) - this.attempt.initiation_ts;
      this.obs.startup_ms = this.attempt.startup_duration_ms;
    }
    this.closeSegment(t, next);
    if (this.state === PlayerState.STARTING && next === PlayerState.PLAYING && this.attempt) {
      this.resolveAttempt(t, "STARTED", null);
    }
    this.enter(t, next);
  }

  private enter(t: number, next: PlayerState): void {
    this.prevState = this.state;
    this.state = next;
    this.stateSince = t;
    this.segmentId++;
    if (next === PlayerState.BUFFERING) this.bufferingCount++;
    if (next === PlayerState.PLAYING) {
      // Progress tracking restarts from the first sample in this segment.
      this.lastPosition = null;
      this.progressStall = 0;
    }
  }

  private closeSegment(t: number, next: PlayerState): void {
    this.fillObservations(t);
    this.obs.next_state = next;
    this.evaluate("segment_end", t);
  }

  private observeProgress(t: number, positionMs: number): void {
    if (this.interval) this.interval.maxPositionMs = Math.max(this.interval.maxPositionMs, positionMs);
    if (this.state !== PlayerState.PLAYING) {
      this.lastPosition = null;
      return;
    }
    if (this.lastPosition !== null) {
      const wall = t - this.lastProgressAt;
      const pos = positionMs - this.lastPosition;
      this.obs.wallclock_delta_ms = wall;
      this.obs.position_delta_ms = pos;
      const lag = wall - pos;
      if (lag > PROGRESS_JITTER_MS) {
        this.progressStall += lag;
      } else if (this.progressStall > 0) {
        this.progressStall = 0;
        this.progressEpisode++;
      }
    }
    this.lastPosition = positionMs;
    this.lastProgressAt = t;
  }

  private onError(t: number, domain: ErrorDomain, code: string, fatal: boolean): void {
    this.errorDomain = domain;
    this.errorCode = code;
    this.errorFatal = fatal;
    this.fillObservations(t);
    this.evaluate("error", t);
    if (fatal) {
      if (this.state === PlayerState.STARTING && this.attempt) {
        this.resolveAttempt(t, "FAILED", `${domain.toUpperCase()}_ERROR`);
      }
      this.pendingTerminal = "ERROR";
    }
  }

  private terminate(t: number, reason: TerminalReason): void {
    if (!this.isLive()) return;
    if (this.state === PlayerState.STARTING && this.attempt) {
      this.resolveAttempt(t, reason === "ERROR" ? "FAILED" : "ABANDONED", reason === "ERROR" ? "PLAYBACK_ERROR" : null);
    }
    this.fillObservations(t);
    this.obs.next_state = PlayerState.ENDED;
    this.evaluate("segment_end", t);
    const end: PlayerState =
      reason === "STALL_TIMEOUT" ? PlayerState.STALLED_OUT : reason === "ERROR" ? PlayerState.ERROR : PlayerState.ENDED;
    const endReason: IntervalEndReason =
      reason === "NAVIGATION" ? "USER_EXIT" : reason === "COMPLETED" ? "COMPLETED" : reason === "ERROR" ? "ERROR" : reason === "STALL_TIMEOUT" ? "STALL_TIMEOUT" : "USER_EXIT";
    this.closeInterval(t, endReason);
    this.prevState = this.state;
    this.state = end;
    this.stateSince = t;
    // Flush on abnormal termination (§7.3): the final minute is sealed now,
    // flagged terminal, rather than waiting for a boundary the process may not live to see.
    this.sealMinute(t, true);
  }

  private flushPendingTerminal(): void {
    if (!this.pendingTerminal || this.now === null) return;
    const reason = this.pendingTerminal;
    this.pendingTerminal = null;
    this.terminate(this.now, reason);
  }

  private resolveAttempt(t: number, result: "STARTED" | "FAILED" | "ABANDONED", failure: string | null): void {
    if (!this.attempt) return;
    this.attempt.result = result;
    this.attempt.terminal_ts = this.utc(t);
    this.attempt.failure_type = failure;
    this.attempt.provisional = false;
    this.emit({ kind: "attempt", record: { ...this.attempt } });
    this.attempt = null;
  }

  // ── assets and intervals ─────────────────────────────────────────────

  private switchAsset(input: Extract<PlayerInput, { type: "asset" }>): void {
    if (this.interval && this.interval.asset_id !== input.asset_id) {
      const i = this.interval;
      const completed = i.duration_asset_ms !== null && i.maxPositionMs >= 0.98 * i.duration_asset_ms;
      this.closeInterval(input.t, completed ? "COMPLETED" : "SWITCHED");
    }
    this.asset = {
      id: input.asset_id,
      type: input.asset_type,
      duration_ms: input.duration_ms,
      program_id: input.program_id ?? null,
      is_live: input.is_live ?? input.asset_type === AssetType.LIVE,
      pod: input.ad_pod_position ?? 0,
    };
    if (this.isLive() && (!this.interval || this.interval.asset_id !== input.asset_id)) this.openInterval(input.t);
  }

  private openInterval(t: number): void {
    this.interval = {
      start_ts: this.utc(t),
      asset_id: this.asset.id,
      program_id: this.asset.program_id,
      asset_type: this.asset.type,
      duration_asset_ms: this.asset.duration_ms,
      context_id: this.contextId,
      activeMs: 0,
      kbpsMs: 0,
      issues: 0,
      maxPositionMs: 0,
    };
  }

  private closeInterval(t: number, reason: IntervalEndReason): void {
    const i = this.interval;
    if (!i) return;
    this.interval = null;
    const len = i.duration_asset_ms;
    const pct = (ms: number) => (len && len > 0 ? Math.max(0, Math.min(100, Math.round((100 * ms) / len))) : 0);
    const record: PlaybackInterval = {
      playback_id: this.playbackId,
      start_ts: i.start_ts,
      duration_ms: Math.max(0, Math.round(this.utc(t) - i.start_ts)),
      active_ms: Math.round(i.activeMs),
      asset_id: i.asset_id,
      program_id: i.program_id,
      asset_type: i.asset_type,
      context_id: i.context_id,
      issue_summary: i.issues,
      max_position_pct: pct(i.maxPositionMs),
      watched_pct: pct(i.activeMs),
      bitrate_bucket: i.activeMs > 0 ? bitrateBucket(i.kbpsMs / i.activeMs) : 0,
      end_reason: reason,
    };
    this.emit({ kind: "interval", record });
  }

  // ── context dictionary ───────────────────────────────────────────────

  private registerContext(d: ClientDimensions): number {
    const key = JSON.stringify(d, Object.keys(d).sort());
    const existing = this.contexts.get(key);
    if (existing !== undefined) return existing;
    const id = this.contexts.size;
    if (id > 0xff) return this.contextId; // dictionary full: keep the last id rather than block
    this.contexts.set(key, id);
    const def: ContextDefinition = {
      session_scope_id: this.sessionId,
      local_context_id: id,
      dimensions: { ...d },
      context_version: 1,
    };
    this.emit({ kind: "context", record: def });
    return id;
  }

  // ── classification ───────────────────────────────────────────────────

  private fillObservations(t: number): void {
    const o = this.obs;
    o.state = this.state;
    o.prev_state = this.prevState;
    o.next_state = this.state;
    o.state_duration_ms = t - this.stateSince;
    o.buffering_ms_continuous = this.state === PlayerState.BUFFERING ? t - this.stateSince : 0;
    o.buffering_count = this.bufferingCount;
    o.progress_stall_ms = this.state === PlayerState.PLAYING ? this.progressStall : 0;
    o.rendition_index = this.renditionIndex;
    o.rendition_max_index = this.renditionMax;
    o.rendition_ms = t - this.renditionSince;
    o.error_domain = this.errorDomain;
    o.error_code = this.errorCode;
    o.error_fatal = this.errorFatal;
    o.asset_type = this.asset.type;
    o.is_live = this.asset.is_live;
    o.ad_pod_position = this.asset.pod;
    o.network_type = this.dims.connection_type;
  }

  private evaluate(trigger: Trigger, t: number): void {
    const list = this.rules.byTrigger[trigger];
    if (list.length === 0) return;
    if (trigger === "tick" || trigger === "seal") this.fillObservations(t);
    for (let i = 0; i < list.length; i++) {
      const rule = list[i]!;
      if (ruleMatches(rule, this.obs)) this.apply(rule, trigger);
    }
  }

  private apply(rule: CompiledRule, trigger: Trigger): void {
    const e = rule.emit;
    const ad = e.ad === true || isAdAsset(this.asset.type);
    if (e.bit !== undefined) {
      const bit = 1 << IssueBit[e.bit];
      if (ad) this.acc.adBits |= bit;
      else this.acc.contentBits |= bit;
      if (this.interval) this.interval.issues |= bit;
    }
    if (e.clear_bit !== undefined) {
      const mask = ~(1 << IssueBit[e.clear_bit]);
      if (ad) this.acc.adBits &= mask;
      else this.acc.contentBits &= mask;
    }
    // Bits are idempotent and re-applied on every match, so a persisting
    // condition marks each minute it spans. Counts, buckets and terminal
    // actions from tick rules happen once per episode.
    if (trigger === "tick") {
      const key = `${this.segmentId}:${this.progressEpisode}:${this.renditionEpisode}`;
      if (this.fired.get(rule.id) === key) return;
      this.fired.set(rule.id, key);
    }
    if (e.count === "rebuffer_count") {
      if (ad) this.acc.adRebufferCount++;
      else this.acc.rebufferCount++;
    } else if (e.count === "freeze_count") {
      this.acc.freezeCount++;
    } else if (e.count === "error_count") {
      if (ad) this.acc.adErrorCount++;
      else this.acc.errorCount++;
    }
    if (e.bucket !== undefined) {
      const v = Number(this.obs[BUCKET_SOURCE[e.bucket]]) || 0;
      if (e.bucket === "rebuffer_ms") {
        if (ad) this.acc.adRebufferMs += v;
        else this.acc.rebufferMs += v;
      } else if (e.bucket === "freeze_ms") {
        this.acc.freezeMs += v;
      } else {
        this.acc.startupMs = v;
      }
    }
    if (e.terminal === "STALLED_OUT") this.pendingTerminal = "STALL_TIMEOUT";
  }

  // ── sealing ──────────────────────────────────────────────────────────

  private sealMinute(t: number, terminal: boolean): void {
    if (this.minuteStart === null) return;
    const started = this.state !== PlayerState.NOT_STARTED;
    // Before initiation, and after the terminal record, boundaries pass silently.
    if (!started || (!terminal && this.isTerminal())) {
      this.acc = emptyMinute();
      this.minuteStart = this.bucketOf(t);
      return;
    }
    if (!terminal) this.evaluate("seal", t);
    const a = this.acc;
    const minuteTs = this.minuteStart;
    this.acc = emptyMinute();
    if (!terminal) this.minuteStart = this.bucketOf(t);

    const contentIntentS = Math.min(60, Math.round(a.intentMs / 1000));
    const adIntentS = Math.min(60, Math.round(a.adIntentMs / 1000));
    const activeMs = a.activeMs + a.adActiveMs;
    const anyIssue = a.contentBits !== 0 || a.adBits !== 0;
    const eligible = contentIntentS + adIntentS >= this.cfg.min_intent_s || anyIssue;
    let flags = 0;
    if (!eligible) flags |= 1 << RecordFlag.INELIGIBLE;
    if (this.clockOffset === null) flags |= 1 << RecordFlag.CLOCK_UNNORMALIZED;
    if (terminal) flags |= 1 << RecordFlag.TERMINAL;

    const meanKbps = activeMs > 0 ? a.kbpsMs / activeMs : null;
    const record: ExperienceMinute = {
      minute_ts: minuteTs,
      playback_id: this.playbackId,
      session_id: this.sessionId,
      context_id: this.contextId,
      sequence_no: this.sequence++,
      content_intent_s: contentIntentS,
      content_active_s: Math.min(contentIntentS, Math.round(a.activeMs / 1000)),
      content_issue_bitmap: a.contentBits,
      ad_intent_s: adIntentS,
      ad_active_s: Math.min(adIntentS, Math.round(a.adActiveMs / 1000)),
      ad_issue_bitmap: a.adBits,
      issue_counters: {
        rebuffer_count: Math.min(255, a.rebufferCount),
        rebuffer_ms_bucket: a.rebufferMs > 0 ? clientBucket(a.rebufferMs) : NO_BUCKET,
        freeze_count: Math.min(15, a.freezeCount),
        freeze_ms_bucket: a.freezeMs > 0 ? clientBucket(a.freezeMs) : NO_BUCKET,
        startup_ms_bucket: a.startupMs !== null ? clientBucket(a.startupMs) : NO_BUCKET,
        error_count: Math.min(15, a.errorCount),
        ad_rebuffer_count: Math.min(255, a.adRebufferCount),
        ad_rebuffer_ms_bucket: a.adRebufferMs > 0 ? clientBucket(a.adRebufferMs) : NO_BUCKET,
        ad_error_count: Math.min(15, a.adErrorCount),
      },
      bitrate_bucket: meanKbps !== null ? bitrateBucket(meanKbps) : 0,
      peak_rendition_seconds: Math.min(60, Math.round(a.peakMs / 1000)),
      context_change_flags: a.ctxFlags,
      record_flags: flags,
      taxonomy_version: this.cfg.taxonomy_version,
      threshold_profile_id: this.cfg.threshold_profile_id,
      eligibility_policy_version: this.cfg.eligibility_policy_version,
      ruleset_version: this.rules.version,
    };
    if (this.cfg.debug) {
      record.debug = {
        intent_ms: a.intentMs,
        active_ms: a.activeMs,
        rebuffer_ms: a.rebufferMs,
        ad_intent_ms: a.adIntentMs,
        mean_kbps: meanKbps,
      };
    }
    this.stats.minutes_sealed++;
    this.emit({ kind: "minute", record });
  }

  private utc(t: number): number {
    return t + (this.clockOffset ?? 0);
  }

  private emit(r: CompiledRecord): void {
    this.out.push(r);
    this.onRecord?.(r);
  }
}
