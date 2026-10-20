/* ═══════════════════════════════════════════════════════════════
   Sampled playbacks, compiled on "device".

   Each row of the minute grid is one playback. Its player events are
   synthesised from the population model for its context and minute, then
   pushed through @observa/core's MinuteCompiler — the same reference
   state machine, ruleset and sealing the SDK would run. The grid cells are
   the ExperienceMinute records it emits, and the bytes in the inspector are
   those records packed for the wire.
   ═══════════════════════════════════════════════════════════════ */
import { MinuteCompiler, uploadOffsetS } from "@observa/core";
import { CONTEXTS, NMIN, T0, MIN, ts, idx, rnd, hash, rateModel, ISSUES, ctxWeightAt, BOUNDARY_I } from "./scenario.js";

const OS = {
  TizenTV: ["tizen", "6.0", "SamsungTV21"],
  iOS: ["ios", "17.2", "iPhone14"],
  AndroidTV: ["androidtv", "12", "ShieldTV"],
  Web: ["web", "128", "Chrome"],
  Roku: ["roku", "12.5", "RokuUltra"],
  LegacyCTV: ["tizen", "4.0", "SamsungTV19"],
};
const LADDER = [400, 800, 1600, 3200, 5800];
const TOP = LADDER.length - 1;
/** Playbacks kept per served edge. The sample is stratified so every edge is readable. */
export const PER_EDGE = 9;
const POOL = 1400;

function pickContext(seed, i) {
  let tot = 0;
  for (let c = 0; c < CONTEXTS.length; c++) tot += ctxWeightAt(i, c);
  let u = rnd("ctx", seed) * tot;
  for (let c = 0; c < CONTEXTS.length; c++) {
    u -= ctxWeightAt(i, c);
    if (u <= 0) return c;
  }
  return CONTEXTS.length - 1;
}

function pickIssue(mix, u) {
  let acc = 0;
  for (let k = 0; k < mix.length; k++) {
    acc += mix[k];
    if (u < acc) return ISSUES[k].k;
  }
  return "REBUFFER";
}

/** Served edge for a sampled playback at minute i: edge-b3 viewers fail over at 12:10:40. */
function servedEdge(ctx, i) {
  if (ctx.edge === "edge-b3" && i >= idx(12, 10)) return "edge-b7";
  return ctx.edge;
}

function synthesize(k) {
  const seed = `pb${k}`;
  const id = (hash(seed) * 4096 + (hash(seed + "x") & 0xfff)).toString(16).padStart(12, "0").slice(-12);
  // Live-match viewers: many were already watching when the window opened.
  const startI = Math.floor(-40 + rnd("st", seed) * 175);
  const dur = Math.floor(10 + Math.pow(rnd("du", seed), .7) * 110);
  const endI = Math.min(startI + dur, NMIN + 2);
  const cIdx = pickContext(seed, Math.max(0, Math.min(NMIN - 1, startI)));
  const ctx = CONTEXTS[cIdx];
  const inputs = [];
  const at = (i, sec) => ts(i) + Math.round(sec * 1000);

  const s0 = rnd("s0", seed) * 50;
  inputs.push({ type: "initiate", t: at(startI, s0) });
  inputs.push({ type: "asset", t: at(startI, s0), asset_id: "match-0917", asset_type: "LIVE", duration_ms: 6_300_000 });
  inputs.push({ type: "rendition", t: at(startI, s0), index: TOP, max_index: TOP, bitrate_kbps: LADDER[TOP] });

  let endedBy = "USER_EXIT";
  const startModel = rateModel(ctx, Math.max(0, Math.min(NMIN - 1, startI)));
  const startIssue = rnd("si", seed) < startModel.observed * .5 ? pickIssue(startModel.mix, rnd("sk", seed)) : null;
  if (startIssue === "DRM_ERROR" || (startModel.extraDrm > 0 && rnd("dr", seed) < .5)) {
    inputs.push({ type: "retry", t: at(startI, s0 + 1.1) });
    inputs.push({ type: "error", t: at(startI, s0 + 2.4), domain: "drm", code: "6004", fatal: true });
    return { k, id, ctx, cIdx, startI, endI: startI + 1, inputs, endedBy: "ERROR" };
  }
  const startup = startIssue === "STARTUP_SLOW" ? 4.5 + rnd("su", seed) * 4 : 1.1 + rnd("su", seed) * 1.6;
  inputs.push({ type: "state", t: at(startI, s0 + startup), state: "PLAYING" });

  for (let i = startI + 1; i < endI; i++) {
    const mi = Math.max(0, Math.min(NMIN - 1, i));
    const edgeNow = servedEdge(ctx, mi);
    if (edgeNow !== ctx.edge && servedEdge(ctx, mi - 1) === ctx.edge) {
      inputs.push({ type: "context_change", t: at(i, 40.5), flag: "CDN_SWITCH" });
    }
    const model = rateModel(ctx, mi);
    const u = rnd("u", seed, i);
    // Seconds-weighted rate ≈ share of minutes that are impacted. During incident A
    // the damage is not spread evenly: playbacks fetching from the cold cache rebuffer
    // minute after minute while the rest of the cohort is fine. Susceptibility is per
    // playback, sized so the cohort average still matches the population rate.
    let p = model.observed;
    if (ctx.region === "US-IL" && edgeNow.startsWith("edge-b") && mi >= idx(12, 11)) {
      const q = ctx.app === "7.2.0" ? .3 : .1;
      p = rnd("sus", seed) < q ? Math.min(.95, (model.observed - (1 - q) * model.expected) / q) : model.expected;
    }
    if (u < p) {
      let issue = pickIssue(model.mix, rnd("k", seed, i));
      if (issue === "STARTUP_SLOW" || issue === "DRM_ERROR") issue = "REBUFFER";
      // Most mid-stream errors are recovered by the player, and most long stalls end
      // before the stall threshold. Only a share end the playback here; the rest show
      // as rebuffering, so the minute is still impacted and the rates still match the cube.
      if (issue === "PLAYBACK_ERROR" && rnd("fe", seed, i) > .25) issue = "REBUFFER";
      if (issue === "STALL_TIMEOUT" && rnd("fs", seed, i) > .35) issue = "REBUFFER";
      const s = 3 + rnd("at", seed, i) * 40;
      if (issue === "REBUFFER") {
        const n = 1 + Math.floor(rnd("n", seed, i) * (model.mix[0] > .6 ? 3 : 2));
        let t = s;
        for (let j = 0; j < n && t < 57; j++) {
          const d = 1.2 + rnd("d", seed, i, j) * 7;
          inputs.push({ type: "state", t: at(i, t), state: "BUFFERING" });
          inputs.push({ type: "state", t: at(i, Math.min(59.5, t + d)), state: "PLAYING" });
          t += d + 3 + rnd("g", seed, i, j) * 10;
        }
      } else if (issue === "STALL_TIMEOUT") {
        inputs.push({ type: "state", t: at(i, s), state: "BUFFERING" });
        endedBy = "STALL_TIMEOUT";
        return finish(k, id, ctx, cIdx, startI, i + 1, inputs, endedBy);
      } else if (issue === "PLAYBACK_ERROR") {
        inputs.push({ type: "error", t: at(i, s), domain: "playback", code: "3016", fatal: true });
        endedBy = "ERROR";
        return finish(k, id, ctx, cIdx, startI, i + 1, inputs, endedBy);
      } else if (issue === "FREEZE") {
        // Position stops advancing while the player still reports PLAYING.
        inputs.push({ type: "progress", t: at(i, s), position_ms: 0 });
        inputs.push({ type: "progress", t: at(i, s + 3), position_ms: 3000 });
        inputs.push({ type: "progress", t: at(i, s + 7), position_ms: 3000 });
        inputs.push({ type: "progress", t: at(i, s + 10), position_ms: 6000 });
      }
    } else if (rnd("pz", seed, i) < .035) {
      const s = 5 + rnd("ps", seed, i) * 30;
      inputs.push({ type: "state", t: at(i, s), state: "PAUSED" });
      inputs.push({ type: "state", t: at(i, s + 8 + rnd("pd", seed, i) * 40), state: "PLAYING" });
    }
    // Delivered quality: a sustained dip below peak is QUALITY_DEGRADATION, outside the headline.
    const qdP = (ctx.region === "US-IL" && ctx.cdn === "edge-b" && mi >= idx(12, 11)) ? .3 : .06;
    if (rnd("qd", seed, i) < qdP) {
      inputs.push({ type: "rendition", t: at(i, 44), index: 2, max_index: TOP, bitrate_kbps: LADDER[2] });
      inputs.push({ type: "rendition", t: at(i, 58), index: TOP, max_index: TOP, bitrate_kbps: LADDER[TOP] });
    }
    // An ad pod roughly every twelve minutes.
    if (hash(`${seed}:${i}`) % 12 === 0) {
      const a = 46;
      inputs.push({ type: "asset", t: at(i, a), asset_id: `ad-${i}`, asset_type: "AD", duration_ms: 12_000 });
      const roku = ctx.device === "Roku" && mi >= idx(11, 10) && mi < idx(11, 22);
      if (rnd("ae", seed, i) < (roku ? .7 : .04)) inputs.push({ type: "error", t: at(i, a + 2), domain: "ad", code: "VAST-303", fatal: false });
      inputs.push({ type: "progress", t: at(i, a + 12), position_ms: 12_000 });
      inputs.push({ type: "asset", t: at(i, a + 12), asset_id: "match-0917", asset_type: "LIVE", duration_ms: 6_300_000 });
    }
  }
  return finish(k, id, ctx, cIdx, startI, endI, inputs, endedBy);

  function finish(k2, id2, ctx2, cIdx2, a, b, ins, why) {
    if (why === "USER_EXIT" && b <= NMIN) ins.push({ type: "end", t: at(b - 1, 30 + rnd("ex", seed) * 25), reason: "USER_EXIT" });
    return { k: k2, id: id2, ctx: ctx2, cIdx: cIdx2, startI: a, endI: b, inputs: ins, endedBy: why };
  }
}

function compile(p) {
  const [os, osv, model] = OS[p.ctx.device];
  const c = new MinuteCompiler({
    playback_id: p.id,
    session_id: p.id.slice(0, 8),
    dimensions: {
      device_class: model, os, os_version: osv, app_version: p.ctx.app, player_version: "4.1.2",
      protocol: p.ctx.device === "iOS" ? "hls" : "dash", drm_system: p.ctx.device === "iOS" ? "fairplay" : "widevine",
      cdn_requested: p.ctx.cdn, connection_type: p.ctx.device === "iOS" ? "cellular" : "wifi",
    },
    clock_offset_ms: 0,
    // Profile 12 (STARTUP_SLOW at 3 s) was promoted at 11:20; playbacks that start
    // after it receive it in their first ACK.
    ...(p.startI >= BOUNDARY_I ? { threshold_profile_id: 12, thresholds: { startup_slow_ms: 3000 } } : {}),
    debug: true,
  });
  const sorted = p.inputs.slice().sort((a, b) => a.t - b.t);
  for (const input of sorted) c.push(input);
  // Run the clock far enough for a stall-out to fire, but not past the scenario.
  c.push({ type: "tick", t: Math.min(ts(p.endI) + 90_000, ts(NMIN)) });
  const out = c.drain();
  const minutes = new Map();
  const attempts = [];
  const intervals = [];
  const contexts = [];
  for (const r of out) {
    if (r.kind === "minute") minutes.set((r.record.minute_ts - T0) / MIN, r.record);
    else if (r.kind === "attempt") attempts.push(r.record);
    else if (r.kind === "interval") intervals.push(r.record);
    else contexts.push(r.record);
  }
  return {
    id: p.id, ctx: p.ctx, startI: p.startI, endI: p.endI, endedBy: p.endedBy,
    minutes, attempts, intervals, contexts, uploadS: uploadOffsetS(p.id),
    rulesetVersion: c.rulesetVersion, stats: c.stats,
    servedEdge: (i) => servedEdge(p.ctx, i),
  };
}

let cache = null;
/**
 * Draw a large pool of synthetic playbacks (cheap), keep PER_EDGE per requested
 * edge among those that watch for at least 20 minutes, and compile only those.
 * Population weights differ by edge, which the page discloses.
 */
export function samplePlaybacks() {
  if (cache) return cache;
  const t0 = performance.now();
  // Per edge: two thirds live across the 12:10 incident, the rest from earlier in
  // the window so scrubbing back still has rows to show.
  const live = idx(12, 10);
  const nLive = Math.ceil(PER_EDGE * 2 / 3);
  const kept = new Map();
  for (let k = 0; k < POOL; k++) {
    const p = synthesize(k);
    const lo = Math.max(0, p.startI), hi = Math.min(NMIN, p.endI);
    if (hi - lo < 20) continue;
    const g = kept.get(p.ctx.edge) || { live: [], early: [] };
    kept.set(p.ctx.edge, g);
    if (p.startI <= live && p.endI > live + 2) { if (g.live.length < nLive) g.live.push(p); }
    else if (p.startI < idx(11, 40) && g.early.length < PER_EDGE - nLive) g.early.push(p);
  }
  const list = [...kept.values()].flatMap((g) => [...g.early, ...g.live]).map(compile);
  cache = { list, ms: performance.now() - t0 };
  return cache;
}
