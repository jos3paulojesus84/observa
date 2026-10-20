import { describe, expect, it } from "vitest";
import { compileRuleset, platformMatches, RulesetError, type RulesetSpec } from "../src/ruleset.js";
import { DEFAULT_RULESET, DEFAULT_THRESHOLDS, resolveThresholds } from "../src/default-ruleset.js";
import { ladderQuantile, rungLowerMs, rungUpperMs, rungOf, SERVICE_RUNGS, clientBucket } from "../src/ladder.js";
import { decodeBatch, encodeBatch, uploadOffsetS, uploadAt, fnv1a } from "../src/batch.js";
import { replay } from "../src/adapters/html5.js";
import { issueMask } from "../src/vocabulary.js";
import { LADDER, T, compiler, minutes, workedExampleLog } from "./fixtures.js";

const TIZEN6 = { os: "tizen", os_version: "6.0" };

describe("§14 rulesets are data, validated before activation", () => {
  it("compiles the known-good pack with threshold parameters resolved", () => {
    const r = compileRuleset(DEFAULT_RULESET, TIZEN6, DEFAULT_THRESHOLDS);
    expect(r.version).toBe(7);
    expect(r.byTrigger.tick.map((x) => x.id)).toEqual(["stall_timeout", "freeze", "quality_deg"]);
  });

  it.each([
    [{ ruleset_version: 8, rules: [{ id: "x", when: ["frame_drop_pct>5"], emit: {} }] }, /unknown observation/],
    [{ ruleset_version: 8, rules: [{ id: "x", when: ["state>PLAYING"], emit: {} }] }, /only supports = and !=/],
    [{ ruleset_version: 8, rules: [{ id: "x", when: [], emit: { bit: "SLOW_ADS" } }] }, /unknown issue code/],
    [{ ruleset_version: 8, rules: [{ id: "x", when: ["startup_ms>$nope"], emit: {} }] }, /unknown threshold parameter/],
    [{ ruleset_version: 8, rules: [{ id: "x", on: "every_frame", when: [], emit: {} }] }, /unknown trigger/],
    [{ ruleset_version: 8, rules: [{ id: "x", when: Array(9).fill("state=PLAYING"), emit: {} }] }, /at most 8/],
    [{ ruleset_version: 8, rules: [{ id: "x", when: [], emit: {} }, { id: "x", when: [], emit: {} }] }, /duplicate/],
  ])("rejects an invalid pack (%#)", (spec, msg) => {
    expect(() => compileRuleset(spec as unknown as RulesetSpec, TIZEN6, DEFAULT_THRESHOLDS)).toThrow(msg);
  });

  it("falls back to the compiled-in pack when the remote one is invalid, and says why", () => {
    const c = compiler({ ruleset: { ruleset_version: 9, rules: [{ id: "bad", when: ["nonsense"], emit: {} }] } });
    expect(c.rulesetVersion).toBe(7);
    expect(c.stats.ruleset_fallback).toMatch(/cannot parse/);
  });

  it("applies per-platform overrides only where the predicate matches", () => {
    expect(platformMatches("tizen<=6.0", TIZEN6)).toBe(true);
    expect(platformMatches("tizen<=6.0", { os: "tizen", os_version: "6.5" })).toBe(false);
    expect(platformMatches("roku", { os: "roku", os_version: "12" })).toBe(true);
    const spec: RulesetSpec = {
      ruleset_version: 8,
      rules: [{ id: "legacy_only", on: "tick", platform: "tizen<5", when: ["state=PLAYING"], emit: { bit: "FREEZE" } }],
    };
    expect(compileRuleset(spec, TIZEN6).byTrigger.tick).toHaveLength(0);
  });

  it("can reclassify without a release: a stricter rebuffer floor changes the bit, not the vocabulary", () => {
    const stricter: RulesetSpec = {
      ruleset_version: 8,
      rules: DEFAULT_RULESET.rules.map((r) =>
        r.id === "rebuffer" ? { ...r, when: r.when.map((w) => w.replace("$rebuffer_min_ms", "6000")) } : r,
      ),
    };
    const c = compiler({ ruleset: stricter });
    const recs = replay(c, workedExampleLog(), { ladder_kbps: LADDER, until: T("2026-09-17T12:12:00Z") });
    const m = minutes(recs).at(-1)!;
    expect(m.ruleset_version).toBe(8);
    expect(m.issue_counters.rebuffer_count).toBe(1); // only the 6,015 ms stall clears a 6 s floor
  });

  it("rejects out-of-range remote thresholds locally (§13.1)", () => {
    const { thresholds, rejected } = resolveThresholds({ startup_slow_ms: 100, freeze_ms: 3000, made_up: 1 });
    expect(rejected.sort()).toEqual(["made_up", "startup_slow_ms"]);
    expect(thresholds.startup_slow_ms).toBe(DEFAULT_THRESHOLDS.startup_slow_ms);
    expect(thresholds.freeze_ms).toBe(3000);
  });
});

describe("§3.7 the shared ladder", () => {
  it("anchors rung 11 at 12.8–16.4 s", () => {
    expect(rungLowerMs(11)).toBeCloseTo(12_800, 6);
    expect(rungUpperMs(11)).toBeCloseTo(16_384, 6);
    expect(rungOf(12_800)).toBe(11);
  });

  it("spans 1.08 ms to 21 s across the 40-rung services window", () => {
    expect(SERVICE_RUNGS.max - SERVICE_RUNGS.min + 1).toBe(40);
    expect(rungLowerMs(SERVICE_RUNGS.min)).toBeCloseTo(1.08, 2);
    expect(rungUpperMs(SERVICE_RUNGS.max) / 1000).toBeCloseTo(21, 0);
  });

  it("clamps client buckets into 0…15", () => {
    expect(clientBucket(10)).toBe(0);
    expect(clientBucket(10 * 60_000)).toBe(15);
  });

  it("returns a quantile as a rung range, never a single number", () => {
    const counts = new Array(40).fill(0);
    counts[20] = 95; // rung −7
    counts[30] = 5; // rung 3
    expect(ladderQuantile(counts, 0.5)!.rung).toBe(-7);
    const p99 = ladderQuantile(counts, 0.99)!;
    expect(p99.rung).toBe(3);
    expect(p99.upperMs / p99.lowerMs).toBeCloseTo(1.28, 6);
  });
});

describe("§7.2 upload stagger", () => {
  it("is stable per playback and spread across the minute", () => {
    expect(uploadOffsetS("8f2c41a9e7b3")).toBe(uploadOffsetS("8f2c41a9e7b3"));
    const slots = new Array(60).fill(0);
    for (let i = 0; i < 60_000; i++) slots[uploadOffsetS(`pb-${i.toString(16)}`)]++;
    expect(Math.min(...slots)).toBeGreaterThan(850);
    expect(Math.max(...slots)).toBeLessThan(1150);
  });

  it("schedules after the minute ends, inside the following minute", () => {
    const m = T("2026-09-17T12:11:00Z");
    const at = uploadAt(m, "8f2c41a9e7b3");
    expect(at).toBeGreaterThanOrEqual(m + 60_000);
    expect(at).toBeLessThan(m + 120_000);
    expect(fnv1a("")).toBe(0x811c9dc5);
  });
});

describe("batch envelope", () => {
  const c = compiler();
  const recs = replay(c, workedExampleLog(), { ladder_kbps: LADDER, until: T("2026-09-17T12:12:00Z") });
  const ms = minutes(recs).map(({ debug: _d, ...m }) => m);
  const ctx = recs.filter((r) => r.kind === "context").map((r) => r.record) as never[];
  const identity = { playback_id: "8f2c41a9e7b3", session_id: "4d1e77b2", taxonomy_version: 3, threshold_profile_id: 11, eligibility_policy_version: 2, ruleset_version: 7 };

  it("round-trips a full-header batch", () => {
    const bytes = encodeBatch({
      header: { kind: "full", ...identity, device_id: "a903f1c8", base_minute_ts: ms[0]!.minute_ts, base_sequence: ms[0]!.sequence_no },
      contexts: ctx,
      minutes: ms,
    });
    const d = decodeBatch(bytes, identity);
    expect(d.header.bytes).toBe(38);
    expect(d.minutes).toEqual(ms);
    expect(d.contexts[0]!.dimensions.cdn_requested).toBe("edge-b");
  });

  it("uses a 14-byte header once the ACK has issued a token", () => {
    const one = ms.at(-1)!;
    const bytes = encodeBatch({
      header: { kind: "token", upload_token: 0x7f22c1a9, base_minute_ts: one.minute_ts, base_sequence: one.sequence_no, policy_ref: 1 },
      contexts: [],
      minutes: [one],
    });
    const d = decodeBatch(bytes, identity);
    expect(d.header.bytes).toBe(14);
    expect(bytes.length).toBe(14 + 1 + 1 + 24);
    expect(d.minutes[0]!.content_issue_bitmap).toBe(issueMask("REBUFFER", "QUALITY_DEGRADATION"));
  });
});
