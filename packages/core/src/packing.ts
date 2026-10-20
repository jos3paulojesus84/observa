/**
 * Wire packing (spec v7 §17.1; data-flow stages 04–05).
 *
 * One ExperienceMinute packs to 24 bytes. Identifiers and policy versions are
 * constant across a batch, so they travel once in the batch header rather
 * than on every record. This is the proposed encoding from the data-flow
 * companion, implemented so it can be measured.
 *
 *   offset  size  field
 *   0       1     minute delta from batch base (minutes)
 *   1       2     sequence delta from batch base, big-endian
 *   3       1     local context id
 *   4       3     content intent s, content active s, content issue bitmap
 *   7       3     ad intent s, ad active s, ad issue bitmap
 *   10      8     issue counters, bucketed (see COUNTER_LAYOUT)
 *   18      1     context-change flags
 *   19      2     bitrate bucket, peak-rendition seconds
 *   21      1     record flags (ineligible, clock un-normalized, terminal)
 *   22      2     reserved, zero
 */
import { NO_BUCKET } from "./ladder.js";
import { MINUTE_MS } from "./compiler.js";
import type { ExperienceMinute, IssueCounters, PolicyVersions } from "./records.js";

export const PACKED_MINUTE_BYTES = 24;

/** Byte ranges of the packed record, for tooling that explains the layout. */
export const PACKED_LAYOUT = [
  { name: "time & sequence", start: 0, length: 3 },
  { name: "context ref", start: 3, length: 1 },
  { name: "content seconds & issues", start: 4, length: 3 },
  { name: "ad seconds & issues", start: 7, length: 3 },
  { name: "issue counters, bucketed", start: 10, length: 8 },
  { name: "context-change flags", start: 18, length: 1 },
  { name: "bitrate bucket + peak-rendition seconds", start: 19, length: 2 },
  { name: "record flags", start: 21, length: 1 },
  { name: "reserved", start: 22, length: 2 },
] as const;

/**
 * Counter bytes 10–17:
 *   rebuffer_count, rebuffer_ms_bucket, freeze_ms_bucket, startup_ms_bucket,
 *   ad_rebuffer_count, ad_rebuffer_ms_bucket,
 *   error_count (high nibble) | ad_error_count (low nibble),
 *   freeze_count (low nibble; high nibble reserved)
 */
export interface BatchBase {
  base_minute_ts: number;
  base_sequence: number;
}

export class PackError extends Error {
  override name = "PackError";
}

const u8 = (v: number, field: string): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new PackError(`${field} out of range: ${v}`);
  return v;
};
const nib = (v: number, field: string): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0x0f) throw new PackError(`${field} out of range: ${v}`);
  return v;
};

export function packMinute(m: ExperienceMinute, base: BatchBase, out = new Uint8Array(PACKED_MINUTE_BYTES), offset = 0): Uint8Array {
  const dMin = (m.minute_ts - base.base_minute_ts) / MINUTE_MS;
  const dSeq = m.sequence_no - base.base_sequence;
  if (!Number.isInteger(dMin) || dMin < 0 || dMin > 0xff) throw new PackError(`minute delta out of range: ${dMin}`);
  if (!Number.isInteger(dSeq) || dSeq < 0 || dSeq > 0xffff) throw new PackError(`sequence delta out of range: ${dSeq}`);
  const c = m.issue_counters;
  const b = out;
  let i = offset;
  b[i++] = dMin;
  b[i++] = dSeq >> 8;
  b[i++] = dSeq & 0xff;
  b[i++] = u8(m.context_id, "context_id");
  b[i++] = u8(m.content_intent_s, "content_intent_s");
  b[i++] = u8(m.content_active_s, "content_active_s");
  b[i++] = u8(m.content_issue_bitmap, "content_issue_bitmap");
  b[i++] = u8(m.ad_intent_s, "ad_intent_s");
  b[i++] = u8(m.ad_active_s, "ad_active_s");
  b[i++] = u8(m.ad_issue_bitmap, "ad_issue_bitmap");
  b[i++] = u8(c.rebuffer_count, "rebuffer_count");
  b[i++] = u8(c.rebuffer_ms_bucket, "rebuffer_ms_bucket");
  b[i++] = u8(c.freeze_ms_bucket, "freeze_ms_bucket");
  b[i++] = u8(c.startup_ms_bucket, "startup_ms_bucket");
  b[i++] = u8(c.ad_rebuffer_count, "ad_rebuffer_count");
  b[i++] = u8(c.ad_rebuffer_ms_bucket, "ad_rebuffer_ms_bucket");
  b[i++] = (nib(c.error_count, "error_count") << 4) | nib(c.ad_error_count, "ad_error_count");
  b[i++] = nib(c.freeze_count, "freeze_count");
  b[i++] = u8(m.context_change_flags, "context_change_flags");
  b[i++] = u8(m.bitrate_bucket, "bitrate_bucket");
  b[i++] = u8(m.peak_rendition_seconds, "peak_rendition_seconds");
  b[i++] = u8(m.record_flags, "record_flags");
  b[i++] = 0;
  b[i++] = 0;
  return out;
}

export interface BatchIdentity extends PolicyVersions {
  playback_id: string;
  session_id: string;
}

/** Decode a packed record. Identity and policy come from the batch header. */
export function unpackMinute(bytes: Uint8Array, base: BatchBase, identity: BatchIdentity, offset = 0): ExperienceMinute {
  if (bytes.length - offset < PACKED_MINUTE_BYTES) throw new PackError("truncated record");
  const b = (k: number) => bytes[offset + k] as number;
  const counters: IssueCounters = {
    rebuffer_count: b(10),
    rebuffer_ms_bucket: b(11),
    freeze_ms_bucket: b(12),
    startup_ms_bucket: b(13),
    ad_rebuffer_count: b(14),
    ad_rebuffer_ms_bucket: b(15),
    error_count: b(16) >> 4,
    ad_error_count: b(16) & 0x0f,
    freeze_count: b(17) & 0x0f,
  };
  return {
    minute_ts: base.base_minute_ts + b(0) * MINUTE_MS,
    playback_id: identity.playback_id,
    session_id: identity.session_id,
    context_id: b(3),
    sequence_no: base.base_sequence + ((b(1) << 8) | b(2)),
    content_intent_s: b(4),
    content_active_s: b(5),
    content_issue_bitmap: b(6),
    ad_intent_s: b(7),
    ad_active_s: b(8),
    ad_issue_bitmap: b(9),
    issue_counters: counters,
    context_change_flags: b(18),
    bitrate_bucket: b(19),
    peak_rendition_seconds: b(20),
    record_flags: b(21),
    taxonomy_version: identity.taxonomy_version,
    threshold_profile_id: identity.threshold_profile_id,
    eligibility_policy_version: identity.eligibility_policy_version,
    ruleset_version: identity.ruleset_version,
  };
}

export const isBucketPresent = (bucket: number): boolean => bucket !== NO_BUCKET;

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join(" ");
