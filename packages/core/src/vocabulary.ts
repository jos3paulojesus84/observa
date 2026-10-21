/**
 * The fixed vocabulary of the SDK (spec v7 §6, §14.2).
 *
 * Everything in this file is decided at release and cannot be changed by
 * remote configuration: the state machine's states, the semantic issue bits,
 * the context-change flags and the observations a ruleset may reason over.
 * Rulesets (§14) change classification; they never change this file.
 */

/** Player states (§6.1). STALLED_OUT and ENDED are terminal. */
export const PlayerState = {
  NOT_STARTED: "NOT_STARTED",
  STARTING: "STARTING",
  PLAYING: "PLAYING",
  BUFFERING: "BUFFERING",
  PAUSED: "PAUSED",
  SEEKING: "SEEKING",
  ERROR: "ERROR",
  STALLED_OUT: "STALLED_OUT",
  ENDED: "ENDED",
} as const;
export type PlayerState = (typeof PlayerState)[keyof typeof PlayerState];

/** States whose seconds count as playback intent (§3.4). */
export const INTENT_STATES: ReadonlySet<PlayerState> = new Set([
  PlayerState.STARTING,
  PlayerState.PLAYING,
  PlayerState.BUFFERING,
]);

export const TERMINAL_STATES: ReadonlySet<PlayerState> = new Set([
  PlayerState.ERROR,
  PlayerState.STALLED_OUT,
  PlayerState.ENDED,
]);

/**
 * Semantic issue bits (§6.2). Bit positions are part of the wire format and
 * match the cube definitions in the data-flow companion (bit 0 startup,
 * bit 1 rebuffer, bit 3 playback error).
 *
 * A non-zero bitmap means the minute was impacted. CDN_SWITCH is deliberately
 * not here; it is a context change (§6.3).
 */
export const IssueBit = {
  STARTUP_SLOW: 0,
  REBUFFER: 1,
  FREEZE: 2,
  PLAYBACK_ERROR: 3,
  STALL_TIMEOUT: 4,
  DRM_ERROR: 5,
  AD_ERROR: 6,
  QUALITY_DEGRADATION: 7,
} as const;
export type IssueCode = keyof typeof IssueBit;
export const ISSUE_CODES = Object.keys(IssueBit) as IssueCode[];

export const issueMask = (...codes: IssueCode[]): number =>
  codes.reduce((m, c) => m | (1 << IssueBit[c]), 0);

/**
 * Bits that make a minute count as impacted in the headline KPI. Quality
 * degradation is measured, not flagged, for the headline (§20 "Resolved since
 * v4"): soft video and stopped video are different events to a viewer.
 */
export const HEADLINE_ISSUE_MASK = 0xff & ~issueMask("QUALITY_DEGRADATION");

/** Operational transitions. Never an issue (§3.4, §6.3). */
export const ContextChangeFlag = {
  CDN_SWITCH: 0,
  NETWORK_CHANGE: 1,
  LADDER_CHANGE: 2,
  CONTEXT_CHANGE: 3,
} as const;
export type ContextChangeCode = keyof typeof ContextChangeFlag;

/** Per-record flags carried in the packed record's flags byte. */
export const RecordFlag = {
  /** Fails the eligibility policy; kept for sequence continuity, excluded from KPIs. */
  INELIGIBLE: 0,
  /** Sealed before a clock offset was known (§7). */
  CLOCK_UNNORMALIZED: 1,
  /** The playback's last minute; bounds the expected tail for completeness (§7.4). */
  TERMINAL: 2,
} as const;

export const AssetType = {
  CONTENT: "CONTENT",
  LIVE: "LIVE",
  AD: "AD",
  PROMO: "PROMO",
  SLATE: "SLATE",
} as const;
export type AssetType = (typeof AssetType)[keyof typeof AssetType];

export const isAdAsset = (t: AssetType): boolean => t === AssetType.AD;

export type ErrorDomain = "playback" | "drm" | "ad" | "network" | "none";

/**
 * The observation vocabulary (§14.2). A ruleset may only reference these
 * names. Shipped deliberately wider than the default ruleset needs, because
 * this list cannot be extended on devices that never update.
 *
 * Additions beyond the spec's list are marked; each is a value the state
 * machine already computes.
 */
export const OBSERVATIONS = {
  state: "enum",
  prev_state: "enum",
  /** added: the state being entered, available on segment_end triggers */
  next_state: "enum",
  state_duration_ms: "number",
  buffering_ms_continuous: "number",
  buffering_count: "number",
  startup_ms: "number",
  position_delta_ms: "number",
  wallclock_delta_ms: "number",
  /** added: continuous PLAYING time without position advance (freeze detection) */
  progress_stall_ms: "number",
  rendition_index: "number",
  rendition_max_index: "number",
  rendition_ms: "number",
  error_domain: "enum",
  error_code: "string",
  /** added: whether the error ended playback */
  error_fatal: "boolean",
  drm_state: "enum",
  asset_type: "enum",
  is_live: "boolean",
  ad_pod_position: "number",
  network_type: "enum",
  player_version: "string",
} as const;
export type ObservationName = keyof typeof OBSERVATIONS;
export type ObservationValue = string | number | boolean;
export type Observations = { [K in ObservationName]: ObservationValue };
