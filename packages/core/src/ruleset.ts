/**
 * Declarative classification rulesets (spec v7 §14).
 *
 * The SDK ships a fixed evaluator; the rules are data. A ruleset can only
 * reference observations in the shipped vocabulary, can only set the fixed
 * issue bits, and must pass a bounded-complexity check before activation.
 * The evaluator is total: a flat conjunction of comparisons, no loops over
 * rule-controlled data and no allocation on the evaluation path.
 *
 * One extension over the §14.3 example: each rule names its trigger in `on`.
 * A rebuffer can only be judged when the buffering segment ends ("recovered
 * within the stall threshold"), while a stall-out has to fire while the
 * player is still buffering. Without a trigger, the same rule would have to
 * both wait and not wait.
 */
import {
  IssueBit,
  OBSERVATIONS,
  type IssueCode,
  type ObservationName,
  type Observations,
  type ObservationValue,
} from "./vocabulary.js";

/**
 * When a rule is evaluated.
 * - segment_end: a state segment just closed (state = the segment that ended, next_state = the one entered)
 * - tick: once per second of player time while the playback is live
 * - seal: once at each minute boundary, before the minute is sealed
 * - error: on each error observation
 *
 * Context-change flags (CDN switch, network change) are not classified; the
 * state machine records them as facts, so they have no trigger here.
 */
export type Trigger = "segment_end" | "tick" | "seal" | "error";
export const TRIGGERS: readonly Trigger[] = ["segment_end", "tick", "seal", "error"];

export type CounterName = "rebuffer_count" | "freeze_count" | "error_count";
export type BucketName = "rebuffer_ms" | "freeze_ms" | "startup_ms";

/** Which observation feeds each bucketed duration. */
export const BUCKET_SOURCE: Record<BucketName, ObservationName> = {
  rebuffer_ms: "state_duration_ms",
  freeze_ms: "progress_stall_ms",
  startup_ms: "startup_ms",
};

export interface RuleEmit {
  bit?: IssueCode;
  clear_bit?: IssueCode;
  count?: CounterName;
  bucket?: BucketName;
  /** End the playback in a terminal state. */
  terminal?: "STALLED_OUT";
  /** Stop accruing intent seconds past the stall threshold plus grace (§6.3). */
  cap_intent?: boolean;
  /** Report this bit in the ad bitmap whatever is playing. */
  ad?: boolean;
}

export interface RuleSpec {
  id: string;
  on?: Trigger;
  /** Optional platform predicate, e.g. "tizen<=6.0" or "roku". */
  platform?: string;
  when: string[];
  emit: RuleEmit;
}

export interface RulesetSpec {
  ruleset_version: number;
  rules: RuleSpec[];
}

type Op = "=" | "!=" | ">=" | "<=" | ">" | "<";

interface Condition {
  field: ObservationName;
  op: Op;
  /** Pre-parsed comparand: a number for numeric fields, otherwise a string. */
  value: number | string | boolean;
  /** Set when the right-hand side names another numeric observation. */
  ref?: ObservationName;
}

export interface CompiledRule {
  id: string;
  on: Trigger;
  conditions: Condition[];
  emit: RuleEmit;
}

export interface CompiledRuleset {
  version: number;
  /** Rules grouped by trigger, in declaration order. */
  byTrigger: Record<Trigger, CompiledRule[]>;
}

/** Bounded-complexity limits (§14.6). */
export const RULESET_LIMITS = { maxRules: 64, maxConditions: 8, maxIdLength: 48 } as const;

export class RulesetError extends Error {
  constructor(
    message: string,
    readonly ruleId: string | null = null,
  ) {
    super(ruleId ? `${ruleId}: ${message}` : message);
    this.name = "RulesetError";
  }
}

const COND_RE = /^([a-z_]+)\s*(>=|<=|!=|=|>|<)\s*(.+)$/;
const PLATFORM_RE = /^([a-z0-9_-]+)\s*(?:(>=|<=|=|>|<)\s*([0-9]+(?:\.[0-9]+)*))?$/i;

/** Threshold-profile parameters (tier 1, §13) that rule conditions reference as `$name`. */
export type ThresholdParams = Readonly<Record<string, number>>;

function parseCondition(raw: string, ruleId: string, params: ThresholdParams): Condition {
  const m = COND_RE.exec(raw.trim());
  if (!m) throw new RulesetError(`cannot parse condition "${raw}"`, ruleId);
  const [, field, op] = m as unknown as [string, string, Op, string];
  let rawValue = (m[3] ?? "").trim();
  if (rawValue.startsWith("$")) {
    const v = params[rawValue.slice(1)];
    if (v === undefined) throw new RulesetError(`unknown threshold parameter "${rawValue}"`, ruleId);
    rawValue = String(v);
  }
  if (!(field in OBSERVATIONS)) throw new RulesetError(`unknown observation "${field}"`, ruleId);
  const kind = OBSERVATIONS[field as ObservationName];
  if (kind === "number") {
    if (rawValue in OBSERVATIONS) {
      if (OBSERVATIONS[rawValue as ObservationName] !== "number") {
        throw new RulesetError(`"${field}" can only be compared with a numeric observation`, ruleId);
      }
      return { field: field as ObservationName, op, value: 0, ref: rawValue as ObservationName };
    }
    const n = Number(rawValue);
    if (!Number.isFinite(n)) throw new RulesetError(`"${field}" needs a number, got "${rawValue}"`, ruleId);
    return { field: field as ObservationName, op, value: n };
  }
  if (op !== "=" && op !== "!=") {
    throw new RulesetError(`"${field}" is not numeric and only supports = and !=`, ruleId);
  }
  if (kind === "boolean") {
    if (rawValue !== "true" && rawValue !== "false") {
      throw new RulesetError(`"${field}" needs true or false`, ruleId);
    }
    return { field: field as ObservationName, op, value: rawValue === "true" };
  }
  return { field: field as ObservationName, op, value: rawValue };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when a platform predicate such as "tizen<=6.0" matches the device. */
export function platformMatches(predicate: string, platform: { os: string; os_version: string }): boolean {
  const m = PLATFORM_RE.exec(predicate.trim());
  if (!m) return false;
  const [, name, op, version] = m;
  if ((name ?? "").toLowerCase() !== platform.os.toLowerCase()) return false;
  if (!op || !version) return true;
  const d = compareVersions(platform.os_version, version);
  switch (op) {
    case "=": return d === 0;
    case ">=": return d >= 0;
    case "<=": return d <= 0;
    case ">": return d > 0;
    case "<": return d < 0;
    default: return false;
  }
}

/**
 * Validate and compile a ruleset for one device. Rules whose platform
 * predicate does not match are dropped here, once, rather than tested on
 * every evaluation. Throws RulesetError on anything invalid; callers fall back
 * to the known-good pack (§14.6).
 */
export function compileRuleset(
  spec: RulesetSpec,
  platform: { os: string; os_version: string },
  params: ThresholdParams = {},
): CompiledRuleset {
  if (!spec || typeof spec !== "object") throw new RulesetError("ruleset is not an object");
  if (!Number.isInteger(spec.ruleset_version) || spec.ruleset_version < 0 || spec.ruleset_version > 0xffff) {
    throw new RulesetError("ruleset_version must be an integer in 0…65535");
  }
  if (!Array.isArray(spec.rules)) throw new RulesetError("rules must be an array");
  if (spec.rules.length > RULESET_LIMITS.maxRules) {
    throw new RulesetError(`too many rules (${spec.rules.length} > ${RULESET_LIMITS.maxRules})`);
  }
  const byTrigger = Object.fromEntries(TRIGGERS.map((t) => [t, [] as CompiledRule[]])) as Record<
    Trigger,
    CompiledRule[]
  >;
  const seen = new Set<string>();
  for (const rule of spec.rules) {
    const id = String(rule?.id ?? "");
    if (!id || id.length > RULESET_LIMITS.maxIdLength) throw new RulesetError("rule id missing or too long");
    if (seen.has(id)) throw new RulesetError("duplicate rule id", id);
    seen.add(id);
    const on = rule.on ?? "segment_end";
    if (!TRIGGERS.includes(on)) throw new RulesetError(`unknown trigger "${on}"`, id);
    if (!Array.isArray(rule.when) || rule.when.length > RULESET_LIMITS.maxConditions) {
      throw new RulesetError(`when must be an array of at most ${RULESET_LIMITS.maxConditions} conditions`, id);
    }
    const emit = rule.emit ?? {};
    for (const key of ["bit", "clear_bit"] as const) {
      const code = emit[key];
      if (code !== undefined && !(code in IssueBit)) throw new RulesetError(`unknown issue code "${code}"`, id);
    }
    if (emit.bucket !== undefined && !(emit.bucket in BUCKET_SOURCE)) {
      throw new RulesetError(`unknown bucket "${emit.bucket}"`, id);
    }
    if (emit.count !== undefined && !["rebuffer_count", "freeze_count", "error_count"].includes(emit.count)) {
      throw new RulesetError(`unknown counter "${emit.count}"`, id);
    }
    if (emit.terminal !== undefined && emit.terminal !== "STALLED_OUT") {
      throw new RulesetError(`unknown terminal state "${emit.terminal}"`, id);
    }
    const conditions = rule.when.map((c) => parseCondition(String(c), id, params));
    if (rule.platform !== undefined && !PLATFORM_RE.test(rule.platform)) {
      throw new RulesetError(`cannot parse platform "${rule.platform}"`, id);
    }
    if (rule.platform !== undefined && !platformMatches(rule.platform, platform)) continue;
    byTrigger[on].push({ id, on, conditions, emit: { ...emit } });
  }
  return { version: spec.ruleset_version, byTrigger };
}

function test(c: Condition, v: ObservationValue, w: ObservationValue): boolean {
  switch (c.op) {
    case "=": return v === w;
    case "!=": return v !== w;
    case ">=": return (v as number) >= (w as number);
    case "<=": return (v as number) <= (w as number);
    case ">": return (v as number) > (w as number);
    case "<": return (v as number) < (w as number);
  }
}

/** All conditions hold. An empty `when` always matches. */
export function ruleMatches(rule: CompiledRule, obs: Observations): boolean {
  for (let i = 0; i < rule.conditions.length; i++) {
    const c = rule.conditions[i]!;
    if (!test(c, obs[c.field], c.ref ? obs[c.ref] : c.value)) return false;
  }
  return true;
}
