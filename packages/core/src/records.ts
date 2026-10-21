/**
 * The three semantic primitives and their supporting records (spec v7 §3, §5).
 *
 * Field names follow the specification and the wire/table vocabulary
 * (snake_case), so a record printed in a test reads the same as the record in
 * the documents.
 */
import type { AssetType } from "./vocabulary.js";

/** Policy versions carried by every record so a KPI series cannot silently change meaning (§13.2). */
export interface PolicyVersions {
  taxonomy_version: number;
  threshold_profile_id: number;
  eligibility_policy_version: number;
  ruleset_version: number;
}

export type AttemptResult = "UNKNOWN" | "STARTED" | "FAILED" | "ABANDONED";

/** §3.3 — one logical, user-visible playback initiation. */
export interface PlaybackAttempt {
  attempt_id: string;
  playback_id: string;
  session_id: string;
  context_id: number;
  initiation_ts: number;
  terminal_ts: number | null;
  result: AttemptResult;
  failure_type: string | null;
  /** Initiation to first rendered frame, inclusive of retries. Exact, not bucketed. */
  startup_duration_ms: number | null;
  retry_count: number;
  attempt_policy_version: number;
  /** True for the record written at initiation, before the outcome is known. */
  provisional: boolean;
}

/** Bounded counts and bucketed durations, split by content and ad (§3.4). */
export interface IssueCounters {
  rebuffer_count: number;
  /** Client ladder bucket of summed rebuffer time, or NO_BUCKET. */
  rebuffer_ms_bucket: number;
  freeze_count: number;
  freeze_ms_bucket: number;
  /** Bucketed startup, so cohorts compare startup inside the cube. */
  startup_ms_bucket: number;
  error_count: number;
  ad_rebuffer_count: number;
  ad_rebuffer_ms_bucket: number;
  ad_error_count: number;
}

/** §3.4 — was this minute of playback opportunity healthy, and what degraded it? */
export interface ExperienceMinute extends PolicyVersions {
  /** UTC wall-clock minute start, epoch ms. */
  minute_ts: number;
  playback_id: string;
  session_id: string;
  context_id: number;
  sequence_no: number;
  content_intent_s: number;
  content_active_s: number;
  content_issue_bitmap: number;
  ad_intent_s: number;
  ad_active_s: number;
  ad_issue_bitmap: number;
  issue_counters: IssueCounters;
  /** Bitrate bucket of the time-weighted mean over active seconds. */
  bitrate_bucket: number;
  /** Seconds at the best rendition available for this ladder and device (0–60). */
  peak_rendition_seconds: number;
  context_change_flags: number;
  /** RecordFlag bits: ineligible, clock un-normalized, terminal. */
  record_flags: number;
  /** Exact measurements kept for debug builds and tests; never on the wire. */
  debug?: {
    intent_ms: number;
    active_ms: number;
    rebuffer_ms: number;
    ad_intent_ms: number;
    mean_kbps: number | null;
  };
}

export type IntervalEndReason =
  | "COMPLETED"
  | "USER_EXIT"
  | "ERROR"
  | "SWITCHED"
  | "SESSION_END"
  | "STALL_TIMEOUT";

/** §3.6 — what was playing, for exactly how long. The accounting layer. */
export interface PlaybackInterval {
  playback_id: string;
  start_ts: number;
  duration_ms: number;
  active_ms: number;
  asset_id: string;
  program_id: string | null;
  asset_type: AssetType;
  context_id: number;
  issue_summary: number;
  max_position_pct: number;
  watched_pct: number;
  bitrate_bucket: number;
  end_reason: IntervalEndReason;
}

/** Client-observable dimensions only (§5.1). Server-derived ones never appear here. */
export interface ClientDimensions {
  device_class: string;
  os: string;
  os_version: string;
  app_version: string;
  player_version: string;
  protocol: string;
  drm_system: string;
  cdn_requested: string;
  connection_type: string;
}

/** §5 — emitted once per new context; records reference it by a 1-byte local id. */
export interface ContextDefinition {
  session_scope_id: string;
  local_context_id: number;
  dimensions: ClientDimensions;
  context_version: number;
}

export type TerminalReason =
  | "COMPLETED"
  | "USER_EXIT"
  | "ERROR"
  | "STALL_TIMEOUT"
  | "NAVIGATION";

/** Everything the compiler hands to the uploader. */
export type CompiledRecord =
  | { kind: "attempt"; record: PlaybackAttempt }
  | { kind: "minute"; record: ExperienceMinute }
  | { kind: "interval"; record: PlaybackInterval }
  | { kind: "context"; record: ContextDefinition };
