/* ═══════════════════════════════════════════════════════════════
   The data seam.

   Every panel reads through callTool(name, input), the same shape the QoE
   Explorer was built against. Here the tools are answered from the
   generated cubes; pointed at a real query service they would be the
   minute cube, the service cube and the coverage table in ClickHouse.
   No tool ever reads the raw minute tier for a dashboard (invariant 26).
   ═══════════════════════════════════════════════════════════════ */
import {
  CUBE, CONTEXTS, NMIN, MIN, ts, sealedAt, ISSUES, SERVICES, SERVICE_ROWS, INCIDENTS, AGENT_CLUSTERS,
  RESTATED, TIERS, DIMS, policyAt, POLICIES, LATENESS_S,
} from "./scenario.js";
import { ladderQuantile } from "@observa/core";

const NC = CUBE.nc;
const NI = ISSUES.length;

/* ── minute status at a given wall-clock "now" ───────────────── */
export function minuteStatus(i, now) {
  const end = ts(i) + MIN;
  if (now < ts(i)) return { status: "future", arrived: 0 };
  if (now < end) return { status: "open", arrived: 0 };
  if (now < sealedAt(i)) return { status: "filling", arrived: Math.max(0, Math.min(1, (now - end) / 1000 / 60)) };
  return { status: "sealed", arrived: 1 };
}

const matches = (c, filter) => {
  for (const k in filter) if (filter[k] != null && c[k] !== filter[k]) return false;
  return true;
};
const ctxIndex = (filter) => {
  const out = [];
  for (let c = 0; c < NC; c++) if (matches(CONTEXTS[c], filter || {})) out.push(c);
  return out;
};

/** Received share for a cube row as the backend would see it at `now`. */
function received(i, c, now, arrived) {
  let r = CUBE.recv[i * NC + c];
  if (i === RESTATED.i && CONTEXTS[c].tier === RESTATED.tier && now < RESTATED.at) r = RESTATED.sealedFraction;
  return r * arrived;
}

/* ── query_minutes ───────────────────────────────────────────── */
function queryMinutes({ from, to, now, filter = {}, lane = "content" }) {
  const cs = ctxIndex(filter);
  const rows = [];
  for (let i = Math.max(0, from); i <= Math.min(NMIN - 1, to); i++) {
    const st = minuteStatus(i, now);
    const row = { i, ts: ts(i), ...st, opp: 0, imp: 0, exp: 0, iss: new Array(NI).fill(0), qd: 0, pb: 0, recvRecords: 0, expRecords: 0,
      policy: policyAt(i), restated: i === RESTATED.i && now >= RESTATED.at };
    if (st.status === "open" || st.status === "future") { rows.push(row); continue; }
    for (const c of cs) {
      const r = i * NC + c;
      const k = received(i, c, now, st.arrived);
      row.expRecords += CUBE.pb[r] * st.arrived;
      row.recvRecords += CUBE.pb[r] * k;
      row.pb += CUBE.pb[r] * k;
      if (lane === "ads") {
        row.opp += CUBE.adOpp[r] * k;
        row.imp += CUBE.adImp[r] * k;
        row.exp += CUBE.adExp[r] * k;
        row.iss[0] += CUBE.adErr[r] * k;
        row.iss[1] += (CUBE.adImp[r] - CUBE.adErr[r]) * k;
      } else {
        row.opp += CUBE.opp[r] * k;
        row.imp += CUBE.imp[r] * k;
        row.exp += CUBE.exp[r] * k;
        row.qd += CUBE.qd[r] * k;
        for (let b = 0; b < NI; b++) row.iss[b] += CUBE.iss[r * NI + b] * k;
      }
    }
    rows.push(row);
  }
  return { rows, policies: POLICIES, restated: RESTATED };
}

/* ── query_attribution: rank cohorts by absolute excess impacted seconds (§10) ── */
const PAIRS = [["cdn", "app"], ["edge", "app"], ["cdn", "region"], ["isp", "region"], ["device", "app"], ["region", "device"]];
function queryAttribution({ from, to, now, lane = "content", limit = 8 }) {
  const sealed = [];
  for (let i = Math.max(0, from); i <= Math.min(NMIN - 1, to); i++) if (minuteStatus(i, now).status === "sealed") sealed.push(i);
  const groups = new Map();
  let totOpp = 0, totExcess = 0;
  const add = (key, dims, opp, imp, exp) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, dims, opp: 0, imp: 0, exp: 0 }));
    g.opp += opp; g.imp += imp; g.exp += exp;
  };
  for (let c = 0; c < NC; c++) {
    const x = CONTEXTS[c];
    let opp = 0, imp = 0, exp = 0;
    for (const i of sealed) {
      const r = i * NC + c, k = received(i, c, now, 1);
      if (lane === "ads") { opp += CUBE.adOpp[r] * k; imp += CUBE.adImp[r] * k; exp += CUBE.adExp[r] * k; }
      else { opp += CUBE.opp[r] * k; imp += CUBE.imp[r] * k; exp += CUBE.exp[r] * k; }
    }
    totOpp += opp;
    totExcess += Math.max(0, imp - exp);
    for (const d of DIMS) add(`${d.k}=${x[d.k]}`, { [d.k]: x[d.k] }, opp, imp, exp);
    for (const [a, b] of PAIRS) add(`${a}=${x[a]}&${b}=${x[b]}`, { [a]: x[a], [b]: x[b] }, opp, imp, exp);
  }
  const all = [...groups.values()].map((g) => ({
    ...g,
    rate: g.opp ? g.imp / g.opp : 0,
    baseline: g.opp ? g.exp / g.opp : 0,
    excess: g.imp - g.exp,
    share: totExcess ? Math.max(0, g.imp - g.exp) / totExcess : 0,
    traffic: totOpp ? g.opp / totOpp : 0,
  }));
  // Floors (§10): enough traffic to matter, and an excess that is more than noise.
  const floorOpp = totOpp * .001;
  const floorExcess = Math.max(1, totExcess * .02);
  const eligible = all.filter((g) => g.opp >= floorOpp && g.excess >= floorExcess && g.rate > g.baseline * 1.25);
  eligible.sort((a, b) => b.excess - a.excess);
  const ranked = eligible.slice(0, limit);
  const worst = all.filter((g) => g.opp >= floorOpp).sort((a, b) => b.rate - a.rate)[0];
  return { window: { from: sealed[0] ?? null, to: sealed.at(-1) ?? null, minutes: sealed.length }, ranked, worstRate: worst, totExcess, totOpp };
}

/* ── query_mix and query_within: the two independent tests (§9.1) ── */
function queryMix({ from, to, now, dim = "app", filter = {}, step = 10 }) {
  const cs = ctxIndex(filter);
  const values = [...new Set(CONTEXTS.map((c) => c[dim]))].sort();
  const buckets = [];
  for (let a = from; a <= to; a += step) {
    const shares = Object.fromEntries(values.map((v) => [v, 0]));
    let tot = 0;
    for (let i = a; i < Math.min(a + step, to + 1, NMIN); i++) {
      if (minuteStatus(i, now).status !== "sealed") continue;
      for (const c of cs) { const o = CUBE.opp[i * NC + c]; shares[CONTEXTS[c][dim]] += o; tot += o; }
    }
    if (tot > 0) for (const v of values) shares[v] /= tot;
    buckets.push({ from: a, to: Math.min(a + step - 1, to), shares, empty: tot === 0 });
  }
  return { dim, values, buckets };
}

function queryWithin({ from, to, now, dims = ["app", "cdn"] }) {
  const groups = new Map();
  for (let c = 0; c < NC; c++) {
    const x = CONTEXTS[c];
    const key = dims.map((d) => x[d]).join(" · ");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, dims: Object.fromEntries(dims.map((d) => [d, x[d]])), opp: 0, imp: 0, exp: 0 }));
    for (let i = from; i <= to; i++) {
      if (i < 0 || i >= NMIN || minuteStatus(i, now).status !== "sealed") continue;
      const r = i * NC + c;
      g.opp += CUBE.opp[r]; g.imp += CUBE.imp[r]; g.exp += CUBE.exp[r];
    }
  }
  const rows = [...groups.values()].filter((g) => g.opp > 0).map((g) => ({ ...g, rate: g.imp / g.opp, baseline: g.exp / g.opp, delta: (g.imp - g.exp) / g.opp }));
  const tot = rows.reduce((s, r) => s + r.opp, 0);
  rows.forEach((r) => (r.traffic = r.opp / tot));
  rows.sort((a, b) => b.traffic - a.traffic);
  return { rows };
}

/* ── query_services: the service cube, keyed on conformed dimensions (§12) ── */
const serviceArrives = (i) => ts(i) + MIN + 20_000;
function queryServices({ from, to, now, edge = null, region = null }) {
  const out = [];
  for (const r of SERVICE_ROWS) {
    if (r.i < from || r.i > to) continue;
    if (now < serviceArrives(r.i)) continue;
    const keyed = r.service === "origin-shield" ? edge && r.edge === edge : region && r.region === region;
    if (!keyed) continue;
    const q50 = ladderQuantile(r.rungs, .5);
    const q95 = ladderQuantile(r.rungs, .95);
    out.push({
      i: r.i, service: r.service, op: r.op, key: r.key, cluster: r.cluster,
      rps: r.requests / 60, hit: r.requests ? 1 - r.cache_miss / r.requests : 1,
      err: r.requests ? r.errors_5xx / r.requests : 0, timeouts: r.requests ? r.timeouts / r.requests : 0,
      p50: q50, p95: q95, issue_bits: r.issue_bits, change_flags: r.change_flags,
      agents: `${r.agents_received}/${r.agents_expected}`, partial: r.agents_received < r.agents_expected,
    });
  }
  return { rows: out, services: SERVICES.map((s) => s.k) };
}

/* ── query_completeness: per tier and per region, never pooled (§7.4) ── */
function queryCompleteness({ from, to, now, by = "tier" }) {
  const keys = by === "tier" ? TIERS : [...new Set(CONTEXTS.map((c) => c[by]))].sort();
  const res = Object.fromEntries(keys.map((k) => [k, { key: k, expected: 0, received: 0, minutes: [] }]));
  for (let i = from; i <= to; i++) {
    if (i < 0 || i >= NMIN) continue;
    const st = minuteStatus(i, now);
    if (st.status !== "sealed") continue;
    const per = Object.fromEntries(keys.map((k) => [k, [0, 0]]));
    for (let c = 0; c < NC; c++) {
      const k = CONTEXTS[c][by];
      const pb = CUBE.pb[i * NC + c];
      per[k][0] += pb; per[k][1] += pb * received(i, c, now, 1);
    }
    for (const k of keys) {
      res[k].expected += per[k][0]; res[k].received += per[k][1];
      res[k].minutes.push({ i, ratio: per[k][0] ? per[k][1] / per[k][0] : 1 });
    }
  }
  return { by, rows: keys.map((k) => ({ ...res[k], ratio: res[k].expected ? res[k].received / res[k].expected : null })) };
}

function queryCoverage({ i, now }) {
  const rows = [];
  for (const cl of Object.values(AGENT_CLUSTERS)) {
    const r = SERVICE_ROWS.find((x) => x.i === i && x.cluster === cl.cluster);
    if (!r || now < serviceArrives(i)) continue;
    rows.push({ cluster: cl.cluster, service: cl.service, expected: r.agents_expected, received: r.agents_received });
  }
  return { i, rows };
}

/* ── list_incidents ──────────────────────────────────────────── */
function listIncidents({ now }) {
  return {
    incidents: INCIDENTS.filter((x) => now >= x.candidateAt).map((x) => ({
      ...x,
      state: now < x.firedAt ? "confirming" : x.resolvedAt && now >= x.resolvedAt ? "resolved" : "open",
    })),
  };
}

const TOOLS = {
  query_minutes: queryMinutes,
  query_attribution: queryAttribution,
  query_mix: queryMix,
  query_within: queryWithin,
  query_services: queryServices,
  query_completeness: queryCompleteness,
  query_coverage: queryCoverage,
  list_incidents: listIncidents,
};

export function callTool(name, input) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`The scenario does not answer ${name}.`);
  return fn(input || {});
}

export { LATENESS_S };
