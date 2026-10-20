import { describe, expect, it } from "vitest";
import type { PlayerInput } from "../src/compiler.js";
import { issueMask, RecordFlag, HEADLINE_ISSUE_MASK, IssueBit } from "../src/vocabulary.js";
import { DEFAULT_RULESET } from "../src/default-ruleset.js";
import { T, compiler, minutes, ofKind } from "./fixtures.js";

const M0 = T("2026-09-17T12:00:00Z");
const s = (sec: number) => M0 + sec * 1000;

function run(inputs: PlayerInput[], untilSec: number, over = {}) {
  const c = compiler(over);
  for (const i of inputs) c.push(i);
  c.push({ type: "tick", t: s(untilSec) });
  return { c, recs: c.drain() };
}

const start = (atSec = 0, startupMs = 1000): PlayerInput[] => [
  { type: "initiate", t: s(atSec) },
  { type: "rendition", t: s(atSec), index: 4, max_index: 4, bitrate_kbps: 5800 },
  { type: "state", t: s(atSec) + startupMs, state: "PLAYING" },
];

describe("§6.3 permanent stalls are not rebuffers", () => {
  const { recs } = run([...start(), { type: "state", t: s(10), state: "BUFFERING" }], 120);
  const ms = minutes(recs);

  it("sets STALL_TIMEOUT, clears REBUFFER and ends the playback", () => {
    expect(ms).toHaveLength(1);
    const m = ms[0]!;
    expect(m.content_issue_bitmap & issueMask("STALL_TIMEOUT")).not.toBe(0);
    expect(m.content_issue_bitmap & issueMask("REBUFFER")).toBe(0);
    expect(m.issue_counters.rebuffer_count).toBe(0);
    expect(m.record_flags & (1 << RecordFlag.TERMINAL)).not.toBe(0);
  });

  it("stops accruing intent at the stall threshold, so a spinning player cannot dominate impact", () => {
    // 9 s playing + 30 s buffering, then terminal. Nothing after.
    expect(ms[0]!.content_intent_s).toBe(40);
  });

  it("closes the interval with end_reason STALL_TIMEOUT", () => {
    expect(ofKind(recs, "interval").map((i) => i.end_reason)).toEqual(["STALL_TIMEOUT"]);
  });

  it("caps intent at threshold plus grace even when the stall rule fires late", () => {
    const { recs: r2 } = run([...start(), { type: "state", t: s(10), state: "BUFFERING" }], 120, { tick_ms: 60_000 });
    // With one tick a minute the stall rule fires at :60, 50 s into buffering;
    // intent stops at 30 + 5 s of grace.
    const m = minutes(r2)[0]!;
    expect(m.debug!.intent_ms).toBe(1000 + 9000 + 35_000);
  });
});

describe("rebuffers across a minute boundary", () => {
  const { recs } = run([...start(), { type: "state", t: s(55), state: "BUFFERING" }, { type: "state", t: s(68), state: "PLAYING" }], 120);
  const [a, b] = minutes(recs);

  it("marks the minute it started in, so a spinning minute is never sealed clean", () => {
    expect(a!.content_issue_bitmap & issueMask("REBUFFER")).not.toBe(0);
    expect(a!.issue_counters.rebuffer_count).toBe(0);
  });

  it("counts it once, in the minute it resolved", () => {
    expect(b!.content_issue_bitmap & issueMask("REBUFFER")).not.toBe(0);
    expect(b!.issue_counters.rebuffer_count).toBe(1);
  });

  it("ignores buffering below the minimum duration", () => {
    const { recs: r } = run([...start(), { type: "state", t: s(20), state: "BUFFERING" }, { type: "state", t: s(20) + 300, state: "PLAYING" }], 60);
    expect(minutes(r)[0]!.content_issue_bitmap).toBe(0);
  });

  it("does not call post-seek buffering a rebuffer", () => {
    const { recs: r } = run(
      [...start(), { type: "state", t: s(20), state: "SEEKING" }, { type: "state", t: s(21), state: "BUFFERING" }, { type: "state", t: s(24), state: "PLAYING" }],
      60,
    );
    expect(minutes(r)[0]!.content_issue_bitmap).toBe(0);
  });
});

describe("§3.3 attempts: a failed start is never invisible", () => {
  it("writes a provisional record at initiation and resolves it at first frame", () => {
    const { recs } = run(start(0, 2500), 60);
    const a = ofKind(recs, "attempt");
    expect(a.map((x) => [x.result, x.provisional])).toEqual([["UNKNOWN", true], ["STARTED", false]]);
    expect(a[1]!.startup_duration_ms).toBe(2500);
  });

  it("resolves to ABANDONED when the viewer leaves during startup", () => {
    const { recs } = run([{ type: "initiate", t: s(0) }, { type: "end", t: s(3), reason: "USER_EXIT" }], 60);
    expect(ofKind(recs, "attempt").at(-1)!.result).toBe("ABANDONED");
    // The startup minute still exists: 3 s of intent, no issue, so it is ineligible but counted for completeness.
    const m = minutes(recs)[0]!;
    expect(m.content_intent_s).toBe(3);
    expect(m.record_flags & (1 << RecordFlag.INELIGIBLE)).not.toBe(0);
  });

  it("resolves to FAILED on a fatal DRM error, and the minute carries DRM_ERROR", () => {
    const { recs } = run([{ type: "initiate", t: s(0) }, { type: "retry", t: s(1) }, { type: "error", t: s(2), domain: "drm", code: "6004", fatal: true }], 60);
    const final = ofKind(recs, "attempt").at(-1)!;
    expect(final).toMatchObject({ result: "FAILED", failure_type: "DRM_ERROR", retry_count: 1 });
    const m = minutes(recs)[0]!;
    expect(m.content_issue_bitmap).toBe(issueMask("DRM_ERROR"));
    // Two seconds of intent, but an observed issue: eligible and impacted (§3.5).
    expect(m.record_flags & (1 << RecordFlag.INELIGIBLE)).toBe(0);
  });

  it("flags slow startups and buckets startup in the minute it completes", () => {
    const { recs } = run(start(0, 6000), 60);
    expect(minutes(recs)[0]!.content_issue_bitmap & issueMask("STARTUP_SLOW")).not.toBe(0);
  });
});

describe("§3.4 content and ads are scored separately", () => {
  const { recs } = run(
    [
      ...start(),
      { type: "asset", t: s(10), asset_id: "ad-1", asset_type: "AD", duration_ms: 15_000 },
      { type: "error", t: s(12), domain: "ad", code: "VAST-303", fatal: false },
      { type: "progress", t: s(25), position_ms: 15_000 },
      { type: "asset", t: s(25), asset_id: "show-1", asset_type: "CONTENT", duration_ms: 1_800_000 },
    ],
    60,
  );
  const m = minutes(recs)[0]!;

  it("puts ad seconds and ad issues on the ad side only", () => {
    expect(m.ad_intent_s).toBe(15);
    expect(m.ad_issue_bitmap).toBe(issueMask("AD_ERROR"));
    expect(m.content_issue_bitmap).toBe(0);
    expect(m.issue_counters.ad_error_count).toBe(1);
  });

  it("keeps content intent for the content portion", () => {
    expect(m.content_intent_s).toBe(45);
  });

  it("splits intervals at asset boundaries and records completion", () => {
    const iv = ofKind(recs, "interval");
    expect(iv.map((i) => [i.asset_type, i.end_reason])).toEqual([["CONTENT", "SWITCHED"], ["AD", "COMPLETED"]]);
    expect(iv[1]!.issue_summary).toBe(issueMask("AD_ERROR"));
  });
});

describe("§3.5 eligibility", () => {
  it("excludes paused time from intent", () => {
    const { recs } = run([...start(), { type: "state", t: s(10), state: "PAUSED" }, { type: "state", t: s(50), state: "PLAYING" }], 60);
    expect(minutes(recs)[0]!.content_intent_s).toBe(20);
  });

  it("marks a near-empty minute ineligible but still sends it, so sequences have no gaps", () => {
    const { recs } = run([...start(), { type: "state", t: s(58), state: "PAUSED" }], 180);
    const ms = minutes(recs);
    expect(ms.map((m) => m.sequence_no)).toEqual([0, 1, 2]);
    expect(ms[1]!.record_flags & (1 << RecordFlag.INELIGIBLE)).not.toBe(0);
  });
});

describe("freeze and quality", () => {
  it("detects a freeze from position lag, not from event gaps", () => {
    const inputs: PlayerInput[] = [...start(0, 0)];
    // Position advances normally every 3 s, then stalls for 4 s while PLAYING.
    for (let k = 1; k <= 5; k++) inputs.push({ type: "progress", t: s(3 * k), position_ms: 3000 * k });
    inputs.push({ type: "progress", t: s(19), position_ms: 15_000 });
    const { recs } = run(inputs, 60);
    const m = minutes(recs)[0]!;
    expect(m.content_issue_bitmap & issueMask("FREEZE")).not.toBe(0);
    expect(m.issue_counters.freeze_count).toBe(1);
  });

  it("keeps QUALITY_DEGRADATION out of the headline mask", () => {
    expect(HEADLINE_ISSUE_MASK & (1 << IssueBit.QUALITY_DEGRADATION)).toBe(0);
    expect(HEADLINE_ISSUE_MASK & (1 << IssueBit.REBUFFER)).not.toBe(0);
  });

  it("never sets quality degradation for a single short rendition dip", () => {
    const { recs } = run(
      [...start(), { type: "rendition", t: s(20), index: 2, max_index: 4, bitrate_kbps: 1600 }, { type: "rendition", t: s(25), index: 4, max_index: 4, bitrate_kbps: 5800 }],
      60,
    );
    expect(minutes(recs)[0]!.content_issue_bitmap).toBe(0);
  });
});

describe("§3.2 concurrent players never collide", () => {
  it("keys minutes on playback_id with independent sequences inside one session", () => {
    const a = compiler({ playback_id: "aaaa0000aaaa" });
    const b = compiler({ playback_id: "bbbb0000bbbb" });
    for (const c of [a, b]) {
      for (const i of start()) c.push(i);
      c.push({ type: "tick", t: s(120) });
    }
    const ma = minutes(a.drain());
    const mb = minutes(b.drain());
    expect(ma.map((m) => m.sequence_no)).toEqual([0, 1]);
    expect(mb.map((m) => m.sequence_no)).toEqual([0, 1]);
    expect(new Set([...ma, ...mb].map((m) => `${m.minute_ts}:${m.playback_id}`)).size).toBe(4);
    expect(ma[0]!.session_id).toBe(mb[0]!.session_id);
  });
});

describe("§7 clock", () => {
  it("flags records sealed before a clock offset was known", () => {
    const { recs } = run(start(), 60, { clock_offset_ms: null });
    expect(minutes(recs)[0]!.record_flags & (1 << RecordFlag.CLOCK_UNNORMALIZED)).not.toBe(0);
  });

  it("aligns buckets to corrected UTC, not the device clock", () => {
    // Device clock runs 20 s fast; corrected minute boundaries fall at device :20.
    const c = compiler({ clock_offset_ms: -20_000 });
    for (const i of start(20)) c.push(i);
    c.push({ type: "tick", t: s(80) });
    const m = minutes(c.drain());
    expect(m).toHaveLength(1);
    expect(m[0]!.minute_ts).toBe(M0);
  });
});

describe("the state machine topology is fixed", () => {
  it("rejects transitions it does not allow and counts them", () => {
    // PLAYING before any initiation is not a transition the machine has.
    const { c, recs } = run([{ type: "state", t: s(1), state: "PLAYING" }], 60);
    expect(c.stats.rejected_transitions).toBe(1);
    expect(minutes(recs)).toHaveLength(0);
  });

  it("treats a repeated state and pre-first-frame buffering as no-ops, not errors", () => {
    const c = compiler();
    c.push({ type: "initiate", t: s(0) });
    c.push({ type: "state", t: s(1), state: "BUFFERING" }); // still startup
    for (const i of start().slice(1)) c.push(i);
    c.push({ type: "state", t: s(5), state: "PLAYING" });
    expect(c.stats.rejected_transitions).toBe(0);
    expect(c.currentState).toBe("PLAYING");
    expect(DEFAULT_RULESET.rules.length).toBeGreaterThan(0);
  });
});
