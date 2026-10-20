/**
 * HTML5 media-element adapter and replay harness (spec v7 §19, Phase 0).
 *
 * Raw player event names stay platform-specific (§6.2). An adapter maps them
 * onto the normalised PlayerInput vocabulary; the state machine and ruleset
 * never see a native event. The same adapter replays captured event logs, so
 * semantic output can be checked against trusted reference calculations.
 */
import type { MinuteCompiler, PlayerInput } from "../compiler.js";
import type { CompiledRecord } from "../records.js";
import type { AssetType, ErrorDomain } from "../vocabulary.js";

/** A captured native event, as in the data-flow stage 01 log. */
export interface NativeEvent {
  /** Device time, epoch ms. */
  t: number;
  name: string;
  data?: Record<string, unknown>;
}

export interface Html5AdapterOptions {
  /** The rendition ladder in kbps, lowest first. The top rung is the available peak. */
  ladder_kbps: number[];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Nearest ladder rung for a delivered bitrate. */
function rungFor(ladder: number[], kbps: number): number {
  let best = 0;
  for (let i = 0; i < ladder.length; i++) {
    if (Math.abs((ladder[i] ?? 0) - kbps) < Math.abs((ladder[best] ?? 0) - kbps)) best = i;
  }
  return best;
}

/**
 * Translate one native event into zero or more normalised inputs. Positions
 * arrive in seconds (HTMLMediaElement.currentTime) and leave in ms; bitrates
 * arrive in bps and leave in kbps.
 */
export function translateHtml5(e: NativeEvent, opts: Html5AdapterOptions): PlayerInput[] {
  const d = e.data ?? {};
  const pos = num(d.pos);
  const position_ms = pos !== undefined ? Math.round(pos * 1000) : undefined;
  const maxIndex = opts.ladder_kbps.length - 1;
  switch (e.name) {
    case "loadstart":
    case "play_requested":
      return [{ type: "initiate", t: e.t }];
    case "asset": {
      const type = String(d.asset_type ?? "CONTENT") as AssetType;
      const durS = num(d.duration_s);
      return [{ type: "asset", t: e.t, asset_id: String(d.asset_id ?? "unknown"), asset_type: type, duration_ms: durS !== undefined ? durS * 1000 : null }];
    }
    case "timeupdate":
      return position_ms !== undefined ? [{ type: "progress", t: e.t, position_ms }] : [];
    case "waiting":
    case "stalled":
      return [{ type: "state", t: e.t, state: "BUFFERING", ...(position_ms !== undefined ? { position_ms } : {}) }];
    case "playing":
      return [{ type: "state", t: e.t, state: "PLAYING", ...(position_ms !== undefined ? { position_ms } : {}) }];
    case "pause":
      return [{ type: "state", t: e.t, state: "PAUSED" }];
    case "seeking":
      return [{ type: "state", t: e.t, state: "SEEKING" }];
    case "bitratechange": {
      const to = num(d.to);
      if (to === undefined) return [];
      const kbps = to / 1000;
      return [{ type: "rendition", t: e.t, index: rungFor(opts.ladder_kbps, kbps), max_index: maxIndex, bitrate_kbps: kbps }];
    }
    case "cdnfailover":
      return [{ type: "context_change", t: e.t, flag: "CDN_SWITCH" }];
    case "error":
      return [{ type: "error", t: e.t, domain: (d.domain as ErrorDomain) ?? "playback", code: String(d.code ?? ""), fatal: d.fatal !== false }];
    case "retry":
      return [{ type: "retry", t: e.t }];
    case "ended":
      return [{ type: "end", t: e.t, reason: "COMPLETED" }];
    case "emptied":
    case "unload":
      return [{ type: "end", t: e.t, reason: "USER_EXIT" }];
    default:
      // progress, loadedmetadata and the rest carry nothing the semantic layer uses.
      return [];
  }
}

/**
 * Replay a captured log through a compiler and return everything it emitted.
 * `until` advances the clock past the last event so open minutes seal.
 */
export function replay(
  compiler: MinuteCompiler,
  events: NativeEvent[],
  opts: Html5AdapterOptions & { until?: number },
): CompiledRecord[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  for (const e of sorted) for (const input of translateHtml5(e, opts)) compiler.push(input);
  if (opts.until !== undefined) compiler.push({ type: "tick", t: opts.until });
  return compiler.drain();
}
