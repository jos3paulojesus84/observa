/**
 * Batch envelope and upload scheduling (spec v7 §7.2, §8.1; data-flow stage 05).
 *
 * The first upload of a playback carries a full header with identifiers and
 * policy versions; the ACK returns an upload token that replaces all three
 * identifiers on every later upload. Records are sealed on the wall-clock
 * boundary and uploaded at minute_end + (hash(playback_id) mod 60) s, so
 * buckets stay aligned while collector load flattens to the steady record rate.
 */
import { MINUTE_MS } from "./compiler.js";
import { PACKED_MINUTE_BYTES, packMinute, unpackMinute, PackError, type BatchIdentity } from "./packing.js";
import type { ContextDefinition, ExperienceMinute } from "./records.js";

export const SCHEMA_VERSION = 2;
const HEADER_FULL = 0x01;
const HEADER_TOKEN = 0x02;

/** FNV-1a, 32-bit. Stable across platforms and cheap on weak CPUs. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Upload slot for a playback, in seconds after the minute ends. Derived from
 * playback_id alone and never from a cohort-correlated field: hash the ISP and
 * every subscriber of one provider uploads together, and a collector wobble in
 * one slot becomes indistinguishable from an incident at that ISP.
 */
export const uploadOffsetS = (playbackId: string): number => fnv1a(playbackId) % 60;

/** Device time at which the record for this minute should be uploaded. */
export const uploadAt = (minuteTs: number, playbackId: string): number =>
  minuteTs + MINUTE_MS + uploadOffsetS(playbackId) * 1000;

/**
 * Priority upload for catastrophic signals (§7.3) always carries 0–5 s of
 * jitter. Deterministic per playback so tests can assert it.
 */
export const priorityJitterMs = (playbackId: string, minuteTs: number): number =>
  fnv1a(`${playbackId}:${minuteTs}`) % 5001;

/** Pseudonymous ids on the wire are 8 bytes. Longer ids are hashed down. */
function id8(id: string): Uint8Array {
  const out = new Uint8Array(8);
  const hex = id.replace(/[^0-9a-f]/gi, "");
  if (hex.length === 16 || hex.length === 12 || hex.length === 8) {
    const padded = hex.padStart(16, "0");
    for (let i = 0; i < 8; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const a = fnv1a(id);
  const b = fnv1a(`~${id}`);
  new DataView(out.buffer).setUint32(0, a);
  new DataView(out.buffer).setUint32(4, b);
  return out;
}

export interface FullHeader extends BatchIdentity {
  kind: "full";
  device_id: string;
  base_minute_ts: number;
  base_sequence: number;
}

export interface TokenHeader {
  kind: "token";
  upload_token: number;
  base_minute_ts: number;
  base_sequence: number;
  /** Policy versions are re-sent as one 2-byte reference into the token's registered set. */
  policy_ref: number;
}

export type BatchHeader = FullHeader | TokenHeader;

export interface Batch {
  header: BatchHeader;
  contexts: ContextDefinition[];
  minutes: ExperienceMinute[];
}

/**
 * Encode a batch. Layout:
 *   full header  (38 B): kind, schema, playback_id 8, session_id 8, device_id 8,
 *                        base_minute (u32, epoch minutes), base_sequence u16,
 *                        taxonomy u8, eligibility u8, threshold_profile u16, ruleset u16
 *   token header (14 B): kind, schema, upload_token u32, base_minute u32, base_sequence u16,
 *                        policy_ref u16
 *   then: context count u8, each context as u8 id + u16 length + JSON dimensions,
 *         minute count u8, minutes × 24 B
 */
export function encodeBatch(batch: Batch): Uint8Array {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push((v >> 8) & 0xff, v & 0xff);
  const u32 = (v: number) => parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const h = batch.header;
  const baseMinute = Math.floor(h.base_minute_ts / MINUTE_MS);
  if (h.kind === "full") {
    parts.push(HEADER_FULL, SCHEMA_VERSION);
    parts.push(...id8(h.playback_id), ...id8(h.session_id), ...id8(h.device_id));
    u32(baseMinute);
    u16(h.base_sequence);
    parts.push(h.taxonomy_version & 0xff, h.eligibility_policy_version & 0xff);
    u16(h.threshold_profile_id);
    u16(h.ruleset_version);
  } else {
    parts.push(HEADER_TOKEN, SCHEMA_VERSION);
    u32(h.upload_token);
    u32(baseMinute);
    u16(h.base_sequence);
    u16(h.policy_ref);
  }
  if (batch.contexts.length > 0xff || batch.minutes.length > 0xff) throw new PackError("batch too large");
  parts.push(batch.contexts.length);
  const enc = new TextEncoder();
  for (const c of batch.contexts) {
    const json = enc.encode(JSON.stringify(c.dimensions));
    parts.push(c.local_context_id & 0xff);
    u16(json.length);
    for (const byte of json) parts.push(byte);
  }
  parts.push(batch.minutes.length);
  const head = Uint8Array.from(parts);
  const out = new Uint8Array(head.length + batch.minutes.length * PACKED_MINUTE_BYTES);
  out.set(head, 0);
  const base = { base_minute_ts: baseMinute * MINUTE_MS, base_sequence: h.base_sequence };
  batch.minutes.forEach((m, k) => packMinute(m, base, out, head.length + k * PACKED_MINUTE_BYTES));
  return out;
}

export interface DecodedBatch {
  header: { kind: "full" | "token"; base_minute_ts: number; base_sequence: number; bytes: number };
  contexts: { local_context_id: number; dimensions: Record<string, string> }[];
  minutes: ExperienceMinute[];
}

/** Decode a full-header batch (what a collector does before resolving context ids). */
export function decodeBatch(bytes: Uint8Array, identity: BatchIdentity): DecodedBatch {
  let i = 0;
  const need = (n: number) => {
    if (i + n > bytes.length) throw new PackError("truncated batch");
  };
  const r8 = () => (need(1), bytes[i++] as number);
  const r16 = () => (r8() << 8) | r8();
  const r32 = () => ((r16() << 16) >>> 0) + r16();
  const kind = r8();
  const schema = r8();
  if (schema !== SCHEMA_VERSION) throw new PackError(`unsupported schema ${schema}`);
  let baseMinute: number;
  let baseSeq: number;
  if (kind === HEADER_FULL) {
    need(24);
    i += 24;
    baseMinute = r32();
    baseSeq = r16();
    i += 6;
  } else if (kind === HEADER_TOKEN) {
    i += 4;
    baseMinute = r32();
    baseSeq = r16();
    i += 2;
  } else {
    throw new PackError(`unknown header kind ${kind}`);
  }
  const headerBytes = i;
  const dec = new TextDecoder();
  const contexts: DecodedBatch["contexts"] = [];
  const nCtx = r8();
  for (let k = 0; k < nCtx; k++) {
    const id = r8();
    const len = r16();
    need(len);
    contexts.push({ local_context_id: id, dimensions: JSON.parse(dec.decode(bytes.subarray(i, i + len))) });
    i += len;
  }
  const nMin = r8();
  const base = { base_minute_ts: baseMinute * MINUTE_MS, base_sequence: baseSeq };
  const minutes: ExperienceMinute[] = [];
  for (let k = 0; k < nMin; k++) {
    need(PACKED_MINUTE_BYTES);
    minutes.push(unpackMinute(bytes, base, identity, i));
    i += PACKED_MINUTE_BYTES;
  }
  return {
    header: { kind: kind === HEADER_FULL ? "full" : "token", base_minute_ts: base.base_minute_ts, base_sequence: baseSeq, bytes: headerBytes },
    contexts,
    minutes,
  };
}
