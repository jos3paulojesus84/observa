import { describe, expect, it } from "vitest";
import { replay } from "../src/adapters/html5.js";
import { bitrateBucket, clientBucket, NO_BUCKET } from "../src/ladder.js";
import { PACKED_MINUTE_BYTES, packMinute, unpackMinute } from "../src/packing.js";
import { ContextChangeFlag, issueMask, RecordFlag } from "../src/vocabulary.js";
import { LADDER, T, compiler, minutes, ofKind, workedExampleLog } from "./fixtures.js";

/**
 * Data-flow stage 03: 22 events become one record. The expected values are
 * computed from the stage-01 event log itself. The document rounds two of
 * them: it prints active 46,960 ms and rebuffer 13,040 ms, while the log's
 * own timestamps give 46,884 ms and 13,116 ms. Both land in the same seconds
 * and the same bucket.
 */
describe("worked example · playback 8f2c41a9e7b3 · minute 12:11", () => {
  const c = compiler();
  const recs = replay(c, workedExampleLog(), { ladder_kbps: LADDER, until: T("2026-09-17T12:12:00.000Z") });
  const all = minutes(recs);
  const m = all.find((r) => r.minute_ts === T("2026-09-17T12:11:00Z"))!;

  it("seals one record per wall-clock minute, with a monotonic sequence", () => {
    expect(all.map((r) => new Date(r.minute_ts).toISOString().slice(11, 16))).toEqual(["12:08", "12:09", "12:10", "12:11"]);
    expect(all.map((r) => r.sequence_no)).toEqual([0, 1, 2, 3]);
  });

  it("measures intent and active seconds exactly before reducing them", () => {
    expect(m.content_intent_s).toBe(60);
    expect(m.debug!.active_ms).toBe(46_884);
    expect(m.content_active_s).toBe(47);
    expect(m.ad_intent_s).toBe(0);
  });

  it("counts three rebuffers and buckets their total into rung 11 (12.8–16.4 s)", () => {
    expect(m.issue_counters.rebuffer_count).toBe(3);
    expect(m.debug!.rebuffer_ms).toBe(5_058 + 6_015 + 2_043);
    expect(m.issue_counters.rebuffer_ms_bucket).toBe(11);
    expect(clientBucket(13_040)).toBe(11); // the document's rounded figure, same bucket
  });

  it("sets REBUFFER, and also QUALITY_DEGRADATION under the v7 taxonomy", () => {
    // The companion document prints content_issues 0x02. Under §6.2 this minute
    // also qualifies for QUALITY_DEGRADATION: 48 s below the 5.8 Mbps peak. That
    // bit sits outside the headline mask, so headline impact is unchanged.
    expect(m.content_issue_bitmap).toBe(issueMask("REBUFFER", "QUALITY_DEGRADATION"));
    expect(m.ad_issue_bitmap).toBe(0);
  });

  it("records the CDN failover as a context change, never an issue", () => {
    expect(m.context_change_flags).toBe(1 << ContextChangeFlag.CDN_SWITCH);
  });

  it("carries delivered quality: time at peak and a time-weighted bitrate", () => {
    expect(m.peak_rendition_seconds).toBe(12);
    const kbpsMs = 5800 * 12_004 + 3200 * (6_998 + 11_950) + 1600 * (1_994 + 13_879 + 59);
    expect(m.debug!.mean_kbps).toBeCloseTo(kbpsMs / 46_884, 6);
    expect(m.bitrate_bucket).toBe(bitrateBucket(kbpsMs / 46_884));
  });

  it("is eligible, normalised and not terminal", () => {
    expect(m.record_flags).toBe(0);
  });

  it("carries startup bucketed in the minute it completed, and exact on the attempt", () => {
    const first = all[0]!;
    expect(first.issue_counters.startup_ms_bucket).toBe(clientBucket(1_840));
    expect(m.issue_counters.startup_ms_bucket).toBe(NO_BUCKET);
    const attempts = ofKind(recs, "attempt");
    expect(attempts.map((a) => a.result)).toEqual(["UNKNOWN", "STARTED"]);
    expect(attempts[1]!.startup_duration_ms).toBe(1_840);
  });

  it("packs to 24 bytes and unpacks to the same record", () => {
    const base = { base_minute_ts: T("2026-09-17T12:08:00Z"), base_sequence: 0 };
    const bytes = packMinute(m, base);
    expect(bytes.length).toBe(PACKED_MINUTE_BYTES);
    const { debug: _debug, ...wire } = m;
    expect(unpackMinute(bytes, base, m)).toEqual(wire);
  });

  it("emits the context definition before any record that references it", () => {
    expect(recs[0]!.kind).toBe("context");
    expect(ofKind(recs, "context")).toHaveLength(1);
  });

  it("keeps the record flags clean of policy: versions travel on every record", () => {
    expect(m).toMatchObject({ taxonomy_version: 3, threshold_profile_id: 11, eligibility_policy_version: 2, ruleset_version: 7 });
    expect(RecordFlag.TERMINAL).toBe(2);
  });
});
