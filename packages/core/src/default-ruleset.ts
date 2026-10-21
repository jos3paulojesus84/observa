/**
 * The known-good ruleset compiled into the binary (spec v7 §14.6).
 *
 * If remote configuration is unreachable or every candidate fails validation,
 * the SDK falls back to this pack, so a configuration incident degrades to
 * "the semantics we released", never to "no telemetry". It reproduces the
 * §6.2 taxonomy entirely as data, including the §6.3 stall reclassification.
 */
import type { RulesetSpec } from "./ruleset.js";

/**
 * Threshold profile 11: the tier-1 parameters (§13) the default rules
 * reference as `$name`. Remote config can change these values within sanity
 * bounds without touching the rules.
 */
export const DEFAULT_PROFILE_ID = 11;
export const DEFAULT_THRESHOLDS = {
  /** STARTUP_SLOW above this. */
  startup_slow_ms: 4_000,
  /** Buffering shorter than this after playback is not a rebuffer. */
  rebuffer_min_ms: 500,
  /** Continuous buffering at or past this is STALL_TIMEOUT, not REBUFFER. */
  stall_timeout_ms: 30_000,
  /** Intent keeps accruing for this long past the stall threshold, then stops. */
  stall_grace_ms: 5_000,
  /** PLAYING without position progress for this long is a FREEZE. */
  freeze_ms: 2_000,
  /** Below peak rendition for this long is QUALITY_DEGRADATION. */
  quality_ms: 10_000,
} as const;

export const DEFAULT_RULESET: RulesetSpec = {
  ruleset_version: 7,
  rules: [
    // Acquisition. Startup is measured on the attempt exactly and reflected,
    // bucketed, in the minute where it completes.
    { id: "startup_measure", on: "segment_end",
      when: ["state=STARTING", "next_state=PLAYING"],
      emit: { bucket: "startup_ms" } },
    { id: "startup_slow", on: "segment_end",
      when: ["state=STARTING", "next_state=PLAYING", "startup_ms>=$startup_slow_ms"],
      emit: { bit: "STARTUP_SLOW" } },

    // Rebuffer: buffering entered after active playback, beyond the minimum
    // duration, and recovered within the stall threshold. Judged when the
    // buffering segment ends, because only then is recovery known.
    { id: "rebuffer", on: "segment_end",
      when: ["prev_state=PLAYING", "state=BUFFERING", "state_duration_ms>=$rebuffer_min_ms", "buffering_ms_continuous<$stall_timeout_ms"],
      emit: { bit: "REBUFFER", count: "rebuffer_count", bucket: "rebuffer_ms" } },
    // A rebuffer still open at the minute boundary marks the minute it
    // started in, so the viewer's spinning minute is never sealed as clean.
    { id: "rebuffer_open", on: "seal",
      when: ["prev_state=PLAYING", "state=BUFFERING", "state_duration_ms>=$rebuffer_min_ms"],
      emit: { bit: "REBUFFER" } },

    // §6.3: permanent stalls are not rebuffers. Reclassify, end the
    // playback, and stop accruing intent so walked-away sessions cannot
    // dominate the excess-impact ranking.
    { id: "stall_timeout", on: "tick",
      when: ["state=BUFFERING", "buffering_ms_continuous>=$stall_timeout_ms"],
      emit: { bit: "STALL_TIMEOUT", clear_bit: "REBUFFER", terminal: "STALLED_OUT", cap_intent: true } },

    { id: "freeze", on: "tick",
      when: ["state=PLAYING", "progress_stall_ms>=$freeze_ms"],
      emit: { bit: "FREEZE", count: "freeze_count", bucket: "freeze_ms" } },

    { id: "playback_error", on: "error",
      when: ["error_domain=playback", "error_fatal=true"],
      emit: { bit: "PLAYBACK_ERROR", count: "error_count" } },
    { id: "drm_error", on: "error",
      when: ["error_domain=drm"],
      emit: { bit: "DRM_ERROR", count: "error_count" } },
    { id: "ad_error", on: "error",
      when: ["error_domain=ad"],
      emit: { bit: "AD_ERROR", count: "error_count", ad: true } },

    // Delivered rendition below the available peak for at least 10 s. A
    // single rendition change never sets this bit.
    { id: "quality_deg", on: "tick",
      when: ["state=PLAYING", "rendition_index<rendition_max_index", "rendition_ms>=$quality_ms"],
      emit: { bit: "QUALITY_DEGRADATION" } },
  ],
};

/** Client-side sanity bounds on every remote threshold (§13.1). */
export const THRESHOLD_BOUNDS: Record<keyof typeof DEFAULT_THRESHOLDS, readonly [number, number]> = {
  startup_slow_ms: [1_000, 30_000],
  rebuffer_min_ms: [100, 5_000],
  stall_timeout_ms: [10_000, 120_000],
  stall_grace_ms: [0, 30_000],
  freeze_ms: [500, 10_000],
  quality_ms: [2_000, 60_000],
};

export type Thresholds = { -readonly [K in keyof typeof DEFAULT_THRESHOLDS]: number };

/**
 * Merge a remote threshold profile over the defaults. Out-of-range or
 * non-numeric values are rejected locally and reported, never applied: a
 * startup threshold pushed at 100 ms would otherwise flag every minute
 * worldwide (§13.1).
 */
export function resolveThresholds(remote: Partial<Record<string, unknown>> = {}): {
  thresholds: Thresholds;
  rejected: string[];
} {
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(remote)) {
    if (!(key in THRESHOLD_BOUNDS)) { rejected.push(key); continue; }
    const k = key as keyof Thresholds;
    const [lo, hi] = THRESHOLD_BOUNDS[k];
    if (typeof value !== "number" || !Number.isFinite(value) || value < lo || value > hi) { rejected.push(key); continue; }
    thresholds[k] = value;
  }
  return { thresholds, rejected };
}
