/**
 * Log-scale buckets (spec v7 §3.7, §12.1).
 *
 * One duration ladder is shared by the player SDK and the services lane, so a
 * segment-download bucket on a device and a response bucket at the origin
 * shield mean the same interval. Rung r covers
 *
 *     [ 12.8 s × 1.28^(r − 11),  12.8 s × 1.28^(r − 10) )
 *
 * which puts 13,040 ms in rung 11 (12.8–16.4 s) as in the data-flow example,
 * and makes the services window, rungs −27…12, span 1.08 ms to 21 s.
 *
 * Buckets are additive and exact values are not: a cube row holds counts per
 * rung and two rows merge by summing. Bucket indices are never averaged.
 */

export const LADDER_RATIO = 1.28;
const ANCHOR_MS = 12_800;
const ANCHOR_RUNG = 11;
const LN_RATIO = Math.log(LADDER_RATIO);

/** The client window: 16 rungs, 0…15 (≈0.85 s to ≈56 s). */
export const CLIENT_RUNGS = { min: 0, max: 15 } as const;
/** The services window: 40 rungs, −27…12 (1.08 ms to 21 s). */
export const SERVICE_RUNGS = { min: -27, max: 12 } as const;

/** Sentinel byte for "no value in this minute". */
export const NO_BUCKET = 0xff;

export function rungLowerMs(rung: number): number {
  return ANCHOR_MS * Math.pow(LADDER_RATIO, rung - ANCHOR_RUNG);
}

export function rungUpperMs(rung: number): number {
  return rungLowerMs(rung + 1);
}

/** Unbounded rung index for a duration. */
export function rungOf(ms: number): number {
  if (!(ms > 0)) return -Infinity;
  // Small epsilon so exact edges land in the rung they open, not the one below.
  return Math.floor(Math.log(ms / ANCHOR_MS) / LN_RATIO + 1e-9) + ANCHOR_RUNG;
}

/**
 * Client bucket for a duration: clamped into 0…15. Values below rung 0
 * (under ~0.85 s) land in 0 and values above rung 15 in 15, so the bucket
 * remains a lower bound at both ends.
 */
export function clientBucket(ms: number): number {
  const r = rungOf(ms);
  if (r === -Infinity) return CLIENT_RUNGS.min;
  return Math.max(CLIENT_RUNGS.min, Math.min(CLIENT_RUNGS.max, r));
}

export function serviceRung(ms: number): number {
  const r = rungOf(ms);
  if (r === -Infinity) return SERVICE_RUNGS.min;
  return Math.max(SERVICE_RUNGS.min, Math.min(SERVICE_RUNGS.max, r));
}

/** Geometric midpoint of a rung; the representative value used in sums. */
export function rungMidMs(rung: number): number {
  return rungLowerMs(rung) * Math.sqrt(LADDER_RATIO);
}

/**
 * A quantile from rung counts. Resolved to a rung, so it returns a range
 * (±12% on any quantile at ratio 1.28), never a single number.
 */
export function ladderQuantile(
  counts: ArrayLike<number>,
  q: number,
  firstRung: number = SERVICE_RUNGS.min,
): { rung: number; lowerMs: number; upperMs: number } | null {
  let total = 0;
  for (let i = 0; i < counts.length; i++) total += counts[i] ?? 0;
  if (total <= 0) return null;
  const target = q * total;
  let run = 0;
  for (let i = 0; i < counts.length; i++) {
    run += counts[i] ?? 0;
    if (run >= target) {
      const rung = firstRung + i;
      return { rung, lowerMs: rungLowerMs(rung), upperMs: rungUpperMs(rung) };
    }
  }
  const rung = firstRung + counts.length - 1;
  return { rung, lowerMs: rungLowerMs(rung), upperMs: rungUpperMs(rung) };
}

/**
 * Delivered-bitrate buckets: kbps = 100 × 1.08^k, k in 0…127. The finer ratio
 * keeps bucket-midpoint error on a population mean near ±4% (§3.7).
 */
export const BITRATE_RATIO = 1.08;
const BITRATE_BASE_KBPS = 100;
export const BITRATE_BUCKETS = 128;

export function bitrateBucket(kbps: number): number {
  if (!(kbps > 0)) return 0;
  const k = Math.floor(Math.log(kbps / BITRATE_BASE_KBPS) / Math.log(BITRATE_RATIO) + 1e-9);
  return Math.max(0, Math.min(BITRATE_BUCKETS - 1, k));
}

export function bitrateBucketMidKbps(k: number): number {
  return BITRATE_BASE_KBPS * Math.pow(BITRATE_RATIO, k) * Math.sqrt(BITRATE_RATIO);
}
