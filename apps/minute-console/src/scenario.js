/* ═══════════════════════════════════════════════════════════════
   The scenario: a live football match on 2026-09-17, 10:16–12:16 UTC,
   at about a million concurrent playbacks. Everything here generates the
   two cubes a real backend would serve: the minute cube (per minute ×
   context) and the service cube (per minute × service × edge/region).

   Planted, so the page always has the same story to tell:
     A  edge-b in US-IL degrades. The origin shield moves at 12:10, viewers
        at 12:11. Worst on app 7.2.0, which is also mid staged rollout.
     B  Starlink in Montana: worst rate on the page, 0.2% of traffic.
     C  License errors for Web and Android TV in US-NY, 10:52–11:06. Resolved.
     D  Packager latency in us-south1, 11:35–11:41. Viewers never noticed.
     E  Ad-decision errors on Roku, 11:10–11:22. Ads lane only.
   Plus a threshold-profile promotion at 11:20 (a series boundary), a
   legacy-CTV minute restated by a late offline flush, and per-tier loss.
   ═══════════════════════════════════════════════════════════════ */

export const MIN = 60_000;
export const T0 = Date.UTC(2026, 8, 17, 10, 16);
export const NMIN = 121;                       // 10:16 … 12:16
export const ts = (i) => T0 + i * MIN;
export const idx = (hh, mm) => (Date.UTC(2026, 8, 17, hh, mm) - T0) / MIN;
export const DEFAULT_NOW = Date.UTC(2026, 8, 17, 12, 15, 52);
export const MIN_NOW = Date.UTC(2026, 8, 17, 10, 50, 0);
export const MAX_NOW = Date.UTC(2026, 8, 17, 12, 16, 59);

/* Latency budget (§8.7). A minute's records arrive over the 60 s after it
   ends (stagger); the window closes 20 s after that. */
export const STAGGER_S = 60;
export const LATENESS_S = 20;
export const sealedAt = (i) => ts(i) + MIN + (STAGGER_S + LATENESS_S) * 1000;

/* ── deterministic noise ─────────────────────────────────────── */
export function hash(s) {
  let h = 0x811c9dc5;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/* FNV-1a alone mixes the last character once, so keys that differ only in a
   trailing minute index share their high bits. The murmur3 finaliser
   decorrelates neighbouring keys. */
function fmix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
export const rnd = (...k) => (fmix(hash(k.join("~"))) >>> 8) / 16777216;     // [0,1)
const jit = (amp, ...k) => 1 + (rnd(...k) - 0.5) * 2 * amp;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ramp = (i, a, b) => clamp((i - a) / (b - a), 0, 1);
const smooth = (x) => x * x * (3 - 2 * x);

/* ── dimensions ──────────────────────────────────────────────── */
export const REGIONS = [
  { k: "US-IL", w: .25, svc: "us-central1", edges: [["edge-b3", .45], ["edge-b7", .20], ["edge-a2", .35]], isps: [["Comcast", .5], ["AT&T", .3], ["T-Mobile", .2]] },
  { k: "US-NY", w: .25, svc: "us-east1",    edges: [["edge-a5", .55], ["edge-c1", .45]],                    isps: [["Verizon", .5], ["Spectrum", .35], ["Comcast", .15]] },
  { k: "US-CA", w: .26, svc: "us-west1",    edges: [["edge-a1", .50], ["edge-c4", .50]],                    isps: [["Comcast", .4], ["AT&T", .35], ["Spectrum", .25]] },
  { k: "US-TX", w: .22, svc: "us-south1",   edges: [["edge-a3", .55], ["edge-b2", .45]],                    isps: [["AT&T", .5], ["Spectrum", .3], ["T-Mobile", .2]] },
  { k: "US-MT", w: .02, svc: "us-central1", edges: [["edge-a4", 1]],                                         isps: [["Spectrum", .55], ["CenturyLink", .35], ["Starlink", .10]] },
];
export const DEVICES = [
  { k: "TizenTV",   w: .18, tier: "Modern CTV", f: 1.00 },
  { k: "iOS",       w: .24, tier: "Mobile",     f: 0.90 },
  { k: "AndroidTV", w: .12, tier: "Modern CTV", f: 1.15 },
  { k: "Web",       w: .20, tier: "Web",        f: 1.00 },
  { k: "Roku",      w: .18, tier: "Modern CTV", f: 1.10 },
  { k: "LegacyCTV", w: .08, tier: "Legacy CTV", f: 1.90 },
];
export const TIERS = ["Mobile", "Web", "Modern CTV", "Legacy CTV"];
export const APPS = ["6.8.1", "7.0.4", "7.2.0"];
export const DIMS = [
  { k: "cdn", l: "CDN" }, { k: "edge", l: "Served edge" }, { k: "region", l: "Region" },
  { k: "isp", l: "ISP" }, { k: "device", l: "Device" }, { k: "app", l: "App version" }, { k: "tier", l: "Platform tier" },
];
export const SERVICES = [
  { k: "origin-shield", key: "edge",   op: "GET media.m3u8",   base: { rps: 40, p50: -11, miss: .02, err: .001 } },
  { k: "packager",      key: "region", op: "GET /seg/{n}.m4s", base: { rps: 900, p50: -13, miss: 0, err: .0005 } },
  { k: "license",       key: "region", op: "POST /widevine",   base: { rps: 120, p50: -10, miss: 0, err: .002 } },
  { k: "ad-decision",   key: "region", op: "POST /vast",       base: { rps: 260, p50: -8,  miss: 0, err: .004 } },
];

/* Headline issue bits (§6.2). Order is the stacking order on the page. */
export const ISSUES = [
  { k: "REBUFFER",       l: "Rebuffering",    c: "--i1" },
  { k: "STALL_TIMEOUT",  l: "Stall-out",      c: "--i2" },
  { k: "STARTUP_SLOW",   l: "Slow startup",   c: "--i3" },
  { k: "PLAYBACK_ERROR", l: "Playback error", c: "--i4" },
  { k: "DRM_ERROR",      l: "DRM error",      c: "--i5" },
  { k: "FREEZE",         l: "Freeze",         c: "--i6" },
];
export const AD_ISSUES = [
  { k: "AD_ERROR", l: "Ad error", c: "--i4" },
  { k: "REBUFFER", l: "Ad rebuffering", c: "--i1" },
];
const NI = ISSUES.length;
const BASE_MIX = [.55, .05, .15, .10, .06, .09];
const INCIDENT_MIX = [.70, .12, .06, .06, .01, .05];

/* Edge share inside US-IL moves as edge-b3 fails and edge-b7 inherits its viewers. */
function edgeWeights(region, i) {
  if (region.k !== "US-IL") return region.edges;
  const shift = ramp(i, idx(12, 9.6), idx(12, 11));
  return [["edge-b3", .45 - .37 * shift], ["edge-b7", .20 + .37 * shift], ["edge-a2", .35]];
}
function appWeights(i) {
  const s72 = .04 + .27 * smooth(clamp(i / 120, 0, 1));
  return [(1 - s72) * .635, (1 - s72) * .365, s72];
}
export const concurrency = (i) => 620_000 + 400_000 * smooth(clamp(i / 105, 0, 1)) + 12_000 * Math.sin(i / 7);

/* Policy keys: threshold profile 11 → 12 promoted at 11:20 after shadow
   evaluation. STARTUP_SLOW moves from 4 s to 3 s. */
export const BOUNDARY_I = idx(11, 20);
export const POLICIES = [
  { key: 1, label: "taxonomy 3 · profile 11 · ruleset 7", from: 0 },
  { key: 2, label: "taxonomy 3 · profile 12 · ruleset 7", from: BOUNDARY_I, note: "STARTUP_SLOW 4 s → 3 s. Shadow disagreement factor 1.31 on startup impact." },
];
export const policyAt = (i) => (i >= BOUNDARY_I ? 2 : 1);

/* A legacy-CTV offline queue flushes late: minute 11:52 is restated at 12:05. */
export const RESTATED = { i: idx(11, 52), at: Date.UTC(2026, 8, 17, 12, 5, 10), tier: "Legacy CTV", sealedFraction: .70 };

/* ── contexts ────────────────────────────────────────────────── */
export const CONTEXTS = [];
for (const r of REGIONS) for (const [edge] of r.edges) for (const [isp] of r.isps) for (const d of DEVICES) for (const app of APPS) {
  CONTEXTS.push({ key: 40_000 + CONTEXTS.length, region: r.k, svc: r.svc, edge, cdn: edge.slice(0, 6), isp, device: d.k, tier: d.tier, app });
}
const NC = CONTEXTS.length;

/* ── the minute cube, columnar ───────────────────────────────── */
// Per row r = i * NC + c
export const CUBE = {
  opp: new Float64Array(NMIN * NC),          // content opportunity (intent) seconds
  imp: new Float64Array(NMIN * NC),          // content impacted opportunity seconds
  exp: new Float64Array(NMIN * NC),          // expected impacted seconds (baseline rate × opportunity)
  iss: new Float64Array(NMIN * NC * NI),     // impacted seconds per headline issue bit
  qd: new Float64Array(NMIN * NC),           // seconds in minutes carrying QUALITY_DEGRADATION (not headline)
  adOpp: new Float64Array(NMIN * NC),
  adImp: new Float64Array(NMIN * NC),
  adExp: new Float64Array(NMIN * NC),
  adErr: new Float64Array(NMIN * NC),
  pb: new Float64Array(NMIN * NC),           // distinct playbacks (sketch estimate in a real cube)
  recv: new Float64Array(NMIN * NC),         // share of expected minute records received when sealed
  nc: NC,
};

const ctxWeight = new Float64Array(NMIN * NC);

/** Content rate model for one context and minute: observed, expected, and the issue mix. */
export function rateModel(c, i) {
  const dev = DEVICES.find((d) => d.k === c.device);
  const ispF = c.isp === "Starlink" ? 1.5 : c.isp === "T-Mobile" ? 1.08 : 1;
  const season = 1 + .06 * Math.sin((i + 20) / 19);
  const policyF = policyAt(i) === 2 ? 1.05 : 1;
  const expected = .040 * dev.f * ispF * (c.region === "US-MT" ? 1.1 : 1) * season * policyF;
  let observed = expected * jit(.07, "o", c.key, i);
  let mix = BASE_MIX;
  let extraDrm = 0;

  // A — edge-b in US-IL.
  if (c.region === "US-IL" && c.cdn === "edge-b") {
    const on = ramp(i, idx(12, 10.4), idx(12, 11));
    if (on > 0) {
      const target = c.app === "7.2.0" ? .224 : .082;
      observed = observed + (target * jit(.05, "a", c.key, i) - observed) * on;
      mix = INCIDENT_MIX;
    }
  }
  // 7.2.0 is fine elsewhere, within a hair of baseline.
  if (c.app === "7.2.0") observed *= 1.08;
  // B — Starlink in Montana.
  if (c.isp === "Starlink") observed = Math.max(observed, .31 * ramp(i, idx(11, 46), idx(11, 50)) * jit(.06, "s", i));
  // C — license errors for Web and Android TV in US-NY.
  if (c.region === "US-NY" && (c.device === "Web" || c.device === "AndroidTV") && i >= idx(10, 52) && i < idx(11, 6)) {
    extraDrm = .085 * jit(.1, "c", c.key, i);
    observed += extraDrm;
  }
  return { observed, expected, mix, extraDrm };
}

for (let i = 0; i < NMIN; i++) {
  const apps = appWeights(i);
  const C = concurrency(i);
  for (const r of REGIONS) {
    const ew = edgeWeights(r, i);
    for (let c = 0; c < NC; c++) {
      const x = CONTEXTS[c];
      if (x.region !== r.k) continue;
      const e = ew.find((p) => p[0] === x.edge)[1];
      const isp = r.isps.find((p) => p[0] === x.isp)[1];
      const dev = DEVICES.find((d) => d.k === x.device).w;
      const app = apps[APPS.indexOf(x.app)];
      ctxWeight[i * NC + c] = r.w * e * isp * dev * app;
    }
  }
  for (let c = 0; c < NC; c++) {
    const x = CONTEXTS[c];
    const row = i * NC + c;
    const pb = C * ctxWeight[row] * jit(.03, "pb", c, i);
    const opp = pb * 52 * jit(.02, "opp", c, i);
    const { observed, expected, mix, extraDrm } = rateModel(x, i);
    const imp = Math.min(opp, opp * observed);
    CUBE.pb[row] = pb;
    CUBE.opp[row] = opp;
    CUBE.imp[row] = imp;
    CUBE.exp[row] = opp * expected;
    // Bits overlap inside a minute, so per-issue seconds sum to a little more than the total.
    const drmShare = extraDrm > 0 ? extraDrm / observed : 0;
    for (let k = 0; k < NI; k++) {
      const share = ISSUES[k].k === "DRM_ERROR" ? mix[k] * (1 - drmShare) + drmShare : mix[k] * (1 - drmShare);
      CUBE.iss[row * NI + k] = imp * share * 1.06;
    }
    CUBE.qd[row] = opp * .07 * (x.region === "US-IL" && x.cdn === "edge-b" && i >= idx(12, 11) ? 3.1 : 1) * jit(.1, "qd", c, i);

    // Ads: separate denominator, separate bitmap.
    const adOpp = pb * 4.5 * jit(.08, "ad", c, i);
    let adRate = .030 * jit(.1, "ar", c, i);
    let adErr = .55;
    if (x.device === "Roku" && i >= idx(11, 10) && i < idx(11, 22)) { adRate = .21 * jit(.06, "e", c, i); adErr = .92; }
    CUBE.adOpp[row] = adOpp;
    CUBE.adImp[row] = adOpp * adRate;
    CUBE.adExp[row] = adOpp * .030;
    CUBE.adErr[row] = adOpp * adRate * adErr;

    // Completeness is non-uniform, and worse exactly where playback is worse.
    let recv = { Mobile: .996, Web: .984, "Modern CTV": .975, "Legacy CTV": .862 }[x.tier] * jit(.006, "rv", c, i);
    if (x.region === "US-IL" && x.cdn === "edge-b" && i >= idx(12, 11)) recv *= x.tier === "Legacy CTV" ? .88 : .94;
    CUBE.recv[row] = Math.min(1, recv);
  }
}

/* ── the service cube ────────────────────────────────────────── */
// One row per minute × service × key (edge for the shield, service region otherwise).
export const SERVICE_ROWS = [];
const RUNGS = 40, R0 = -27;
function ladderCounts(n, p50, spread, seed) {
  const out = new Array(RUNGS).fill(0);
  if (n <= 0) return out;
  // A skewed bump around p50: most mass within ±2 rungs, a tail to the right.
  const w = [];
  let tot = 0;
  for (let r = 0; r < RUNGS; r++) {
    const d = r + R0 - p50;
    const v = Math.exp(-(d * d) / (2 * spread * spread)) * (d > 0 ? 1.25 : 1);
    w.push(v); tot += v;
  }
  let left = Math.round(n);
  for (let r = 0; r < RUNGS; r++) {
    const k = r === RUNGS - 1 ? left : Math.min(left, Math.round((n * w[r]) / tot * jit(.04, seed, r)));
    out[r] = k; left -= k;
  }
  return out;
}

const SERVICE_KEYS = [];
for (const s of SERVICES) {
  if (s.key === "edge") for (const r of REGIONS) for (const [e] of r.edges) SERVICE_KEYS.push({ service: s, key: e, region: r.svc, edge: e });
  else for (const reg of [...new Set(REGIONS.map((r) => r.svc))]) SERVICE_KEYS.push({ service: s, key: reg, region: reg, edge: null });
}
export const AGENT_CLUSTERS = {};
for (const k of SERVICE_KEYS) {
  const cluster = k.service.k === "origin-shield" ? `shield-${k.edge.slice(5, 6)}` : `${k.service.k}-${k.region}`;
  k.cluster = cluster;
  AGENT_CLUSTERS[cluster] = AGENT_CLUSTERS[cluster] || { cluster, service: k.service.k, expected: k.service.k === "origin-shield" ? 40 : 12 };
}

for (let i = 0; i < NMIN; i++) {
  for (const k of SERVICE_KEYS) {
    const b = k.service.base;
    let rps = b.rps * (k.service.key === "edge" ? 1 : 3.2) * (concurrency(i) / 900_000) * jit(.05, "rps", k.key, k.service.k, i);
    let p50 = b.p50, spread = 1.2, miss = b.miss, err = b.err, timeouts = .0002;
    let issue = 0, change = 0;
    const t = i;
    // A — the shield in front of edge-b inherits a cold cache at 12:10:40.
    if (k.service.k === "origin-shield" && (k.edge === "edge-b7" || k.edge === "edge-b3")) {
      const on = k.edge === "edge-b7" ? ramp(t, idx(12, 9.3), idx(12, 11)) : ramp(t, idx(12, 9.3), idx(12, 10));
      if (k.edge === "edge-b7") {
        rps = rps + (690 - rps) * on * (t >= idx(12, 11) ? 1 : .26) * jit(.04, "x", t);
        if (t === idx(12, 10)) rps = 212;
        if (t === idx(12, 11)) rps = 690;
        if (t === idx(12, 12)) rps = 710;
      }
      if (on > 0) {
        miss = miss + (.29 - miss) * on * (t >= idx(12, 11) ? 1 : .32);
        p50 = t >= idx(12, 11) ? 1 : t === idx(12, 10) ? -6 : p50;
        spread = t >= idx(12, 10) ? 1.6 : spread;
        err = t >= idx(12, 11) ? .041 * jit(.08, "er", t) : t === idx(12, 10) ? .006 : err;
        timeouts = t >= idx(12, 11) ? .008 : timeouts;
        if (t >= idx(12, 10)) issue = 0b11;               // LATENCY_SLO | ERROR_RATE
      }
    }
    // C — license 5xx in us-east1.
    if (k.service.k === "license" && k.region === "us-east1" && t >= idx(10, 51) && t < idx(11, 6)) {
      err = .061 * jit(.1, "lic", t); issue = 0b10; p50 = -8;
    }
    if (k.service.k === "license" && k.region === "us-east1" && t === idx(11, 6)) change = 0b0001;   // deploy (the fix)
    // D — packager latency in us-south1; buffers absorb it.
    if (k.service.k === "packager" && k.region === "us-south1" && t >= idx(11, 35) && t < idx(11, 42)) {
      p50 = -9; spread = 1.5; issue = 0b01;
    }
    if (k.service.k === "packager" && k.region === "us-south1" && t === idx(11, 34)) change = 0b0100;   // config push
    // E — ad decisioning errors (Roku traffic lands everywhere).
    if (k.service.k === "ad-decision" && t >= idx(11, 9) && t < idx(11, 22)) { err = .074 * jit(.1, "ad", k.key, t); issue = 0b10; }

    const n = Math.round(rps * 60);
    const cl = AGENT_CLUSTERS[k.cluster];
    let agents = cl.expected;
    if (k.cluster === "shield-b" && t === idx(12, 11)) agents = 38;
    if (k.cluster === "shield-b" && t >= idx(12, 12)) agents = 39;
    SERVICE_ROWS.push({
      i, service: k.service.k, op: k.service.op, key: k.key, edge: k.edge, region: k.region, cluster: k.cluster,
      requests: n, cache_miss: Math.round(n * miss), errors_5xx: Math.round(n * err), timeouts: Math.round(n * timeouts),
      rungs: ladderCounts(n, p50, spread, `${k.key}${k.service.k}${t}`), issue_bits: issue, change_flags: change,
      agents_expected: cl.expected, agents_received: agents,
    });
  }
}

/* ── incidents (what the detector concluded, and when) ───────── */
export const INCIDENTS = [
  {
    id: "inc-4471", sev: "high", lane: "content",
    cohort: { cdn: "edge-b", app: "7.2.0" }, edge: "edge-b7", region: "US-IL", svcRegion: "us-central1",
    onset: idx(12, 11), candidateAt: Date.UTC(2026, 8, 17, 12, 13, 30), firedAt: DEFAULT_NOW, resolvedAt: null,
    title: "Rebuffering on edge-b, app 7.2.0",
  },
  {
    id: "inc-4466", sev: "medium", lane: "ads",
    cohort: { device: "Roku" }, edge: null, region: null, svcRegion: null,
    onset: idx(11, 10), candidateAt: Date.UTC(2026, 8, 17, 11, 12, 30), firedAt: Date.UTC(2026, 8, 17, 11, 14, 52),
    resolvedAt: Date.UTC(2026, 8, 17, 11, 24, 20),
    title: "Ad errors on Roku",
  },
  {
    id: "inc-4462", sev: "high", lane: "content",
    cohort: { region: "US-NY", device: "Web" }, edge: null, region: "US-NY", svcRegion: "us-east1",
    onset: idx(10, 52), candidateAt: Date.UTC(2026, 8, 17, 10, 54, 30), firedAt: Date.UTC(2026, 8, 17, 10, 56, 52),
    resolvedAt: Date.UTC(2026, 8, 17, 11, 8, 20),
    title: "DRM errors on Web in US-NY",
  },
];

export const ctxWeightAt = (i, c) => ctxWeight[i * NC + c];
