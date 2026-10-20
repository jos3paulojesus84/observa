import { MinuteCompiler, type CompilerConfig } from "../src/compiler.js";
import type { NativeEvent } from "../src/adapters/html5.js";
import type { ClientDimensions, CompiledRecord, ExperienceMinute } from "../src/records.js";

export const T = (iso: string): number => Date.parse(iso);

export const SAMSUNG_TV: ClientDimensions = {
  device_class: "SamsungTV21",
  os: "tizen",
  os_version: "6.0",
  app_version: "7.2.0",
  player_version: "4.1.2",
  protocol: "hls",
  drm_system: "widevine",
  cdn_requested: "edge-b",
  connection_type: "ethernet",
};

export const LADDER = [400, 800, 1600, 3200, 5800];

export function compiler(over: Partial<CompilerConfig> = {}): MinuteCompiler {
  return new MinuteCompiler({
    playback_id: "8f2c41a9e7b3",
    session_id: "4d1e77b2",
    dimensions: SAMSUNG_TV,
    clock_offset_ms: 0,
    debug: true,
    ...over,
  });
}

export const minutes = (recs: CompiledRecord[]): ExperienceMinute[] =>
  recs.filter((r): r is Extract<CompiledRecord, { kind: "minute" }> => r.kind === "minute").map((r) => r.record);

type RecordOf<K extends CompiledRecord["kind"]> = Extract<CompiledRecord, { kind: K }>["record"];

export const ofKind = <K extends CompiledRecord["kind"]>(recs: CompiledRecord[], kind: K): RecordOf<K>[] =>
  recs.filter((r) => r.kind === kind).map((r) => r.record as RecordOf<K>);

/**
 * Playback 8f2c41a9e7b3 from the data-flow companion: initiated 12:08:14,
 * first frame after 1,840 ms at the top rung, then the stage-01 event log for
 * 12:11:00–12:11:59 verbatim (22 events).
 */
export function workedExampleLog(): NativeEvent[] {
  const at = (hms: string) => T(`2026-09-17T${hms}Z`);
  const ev = (hms: string, name: string, data?: Record<string, unknown>): NativeEvent => ({ t: at(hms), name, ...(data ? { data } : {}) });
  return [
    ev("12:08:14.000", "loadstart"),
    ev("12:08:14.000", "asset", { asset_id: "match-0917", asset_type: "LIVE", duration_s: 6300 }),
    ev("12:08:15.840", "bitratechange", { from: 0, to: 5_800_000 }),
    ev("12:08:15.840", "playing", { pos: 1673.8 }),

    ev("12:11:00.104", "timeupdate", { pos: 1854.2, buf: 12.4, br: 5_800_000 }),
    ev("12:11:03.212", "timeupdate", { pos: 1857.3, buf: 9.1, br: 5_800_000 }),
    ev("12:11:06.318", "timeupdate", { pos: 1860.4, buf: 5.8, br: 5_800_000 }),
    ev("12:11:09.421", "timeupdate", { pos: 1863.5, buf: 2.2, br: 5_800_000 }),
    ev("12:11:12.004", "bitratechange", { from: 5_800_000, to: 3_200_000, reason: "abr" }),
    ev("12:11:15.530", "timeupdate", { pos: 1869.6, buf: 1.1, br: 3_200_000 }),
    ev("12:11:19.002", "waiting", { pos: 1873.1, buf: 0.0 }),
    ev("12:11:19.640", "progress"),
    ev("12:11:22.118", "progress"),
    ev("12:11:24.060", "playing", { pos: 1873.1, buf: 2.8 }),
    ev("12:11:27.166", "timeupdate", { pos: 1876.2, buf: 3.4 }),
    ev("12:11:30.271", "timeupdate", { pos: 1879.3, buf: 2.0 }),
    ev("12:11:33.377", "timeupdate", { pos: 1882.4, buf: 0.9 }),
    ev("12:11:36.010", "bitratechange", { from: 3_200_000, to: 1_600_000, reason: "abr" }),
    ev("12:11:38.004", "waiting", { pos: 1886.9, buf: 0.0 }),
    ev("12:11:40.552", "progress"),
    ev("12:11:42.330", "cdnfailover", { from: "edge-b3", to: "edge-b7" }),
    ev("12:11:44.019", "playing", { pos: 1886.9, buf: 3.1 }),
    ev("12:11:47.124", "timeupdate", { pos: 1890.0, buf: 2.7 }),
    ev("12:11:50.230", "timeupdate", { pos: 1893.1, buf: 1.4 }),
    ev("12:11:57.898", "waiting", { pos: 1900.7, buf: 0.0 }),
    ev("12:11:59.941", "playing", { pos: 1900.7, buf: 1.9 }),
  ];
}
