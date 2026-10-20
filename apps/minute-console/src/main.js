/* ═══════════════════════════════════════════════════════════════
   Minute Console

   A troubleshooting surface built on one unit: the UTC wall-clock
   minute. Every view is a projection of minute records — per playback
   (the grid), per context (the cube), per service key (the service
   cube) — and every minute carries its own state: open on devices,
   filling as staggered uploads arrive, or sealed and final.
   ═══════════════════════════════════════════════════════════════ */
import { HEADLINE_ISSUE_MASK, IssueBit, ISSUE_CODES, NO_BUCKET, PACKED_LAYOUT, packMinute, unpackMinute, toHex, rungLowerMs, rungUpperMs, RecordFlag, ContextChangeFlag } from "@observa/core";
import { callTool, minuteStatus } from "./tools.js";
import {
  MIN, NMIN, ts, idx, DEFAULT_NOW, MIN_NOW, MAX_NOW, ISSUES, AD_ISSUES, DIMS, BOUNDARY_I, POLICIES, RESTATED, INCIDENTS,
} from "./scenario.js";
import { samplePlaybacks, PER_EDGE } from "./playbacks.js";

const $ = (id) => document.getElementById(id);
const S = {
  now: DEFAULT_NOW,
  lane: "content",
  win: 60,
  filter: { cdn: "edge-b", app: "7.2.0" },
  cohortKey: "cdn=edge-b&app=7.2.0",
  incident: "inc-4471",
  playback: null,
  minute: null,
  playing: null,
};
try {
  const saved = JSON.parse(localStorage.getItem("minute-console") || "{}");
  if (saved.win === 60 || saved.win === 120) S.win = saved.win;
} catch { /* storage unavailable: defaults */ }
const remember = () => { try { localStorage.setItem("minute-console", JSON.stringify({ win: S.win })); } catch { /* ignore */ } };

/* ── formatting ──────────────────────────────────────────────── */
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
const hhmmss = (t) => new Date(t).toISOString().slice(11, 19);
const pct = (x, d = 1) => (x == null || !isFinite(x) ? "–" : `${(x * 100).toFixed(d)}%`);
const pt = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)} pt`;
function compact(n) {
  if (n == null || !isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 1 : 2)} s` : `${Math.round(v)} ms`);
const rungRange = (q) => {
  if (!q) return "–";
  if (q.lowerMs >= 1000) return `${(q.lowerMs / 1000).toFixed(2)}–${(q.upperMs / 1000).toFixed(2)} s`;
  return `${Math.round(q.lowerMs)}–${Math.round(q.upperMs)} ms`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cohortLabel = (dims) => Object.entries(dims).map(([k, v]) => `${k}=${v}`).join(" · ");
const keyOf = (dims) => Object.entries(dims).map(([k, v]) => `${k}=${v}`).join("&");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** JSON with sorted keys, so a decoded record compares equal regardless of field order. */
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const issueList = (bits) => ISSUE_CODES.filter((c) => bits & (1 << IssueBit[c]));

/* ── the window ──────────────────────────────────────────────── */
function windowRange() {
  const open = Math.min(NMIN - 1, Math.floor((S.now - ts(0)) / MIN));
  const to = open;
  const from = Math.max(0, to - S.win + 1);
  return { from, to, open };
}
function lastSealed() {
  let i = Math.min(NMIN - 1, Math.floor((S.now - ts(0)) / MIN));
  while (i >= 0 && minuteStatus(i, S.now).status !== "sealed") i--;
  return i;
}

/* ═══════════════════════ header ═══════════════════════════════ */
function renderHeader() {
  $("now").textContent = hhmmss(S.now);
  const sc = $("scrub");
  sc.value = String((S.now - MIN_NOW) / 1000);
  const { open } = windowRange();
  const pills = [];
  const ls = lastSealed();
  pills.push(`<span class="pill"><i class="dot" style="background:var(--good)"></i>Sealed through ${hhmm(ts(ls))}</span>`);
  for (let i = ls + 1; i < open; i++) {
    const st = minuteStatus(i, S.now);
    if (st.status === "filling") pills.push(`<span class="pill"><i class="dot" style="background:var(--warn)"></i>${hhmm(ts(i))} filling · ${Math.round(st.arrived * 100)}% arrived</span>`);
  }
  pills.push(`<span class="pill"><i class="dot" style="background:var(--text-faint)"></i>${hhmm(ts(open))} open on devices</span>`);
  $("pipeline").innerHTML = pills.join("");
  $("play").textContent = S.playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", S.playing ? "Pause the clock" : "Play the clock forward");
  $("lane-content").setAttribute("aria-pressed", String(S.lane === "content"));
  $("lane-ads").setAttribute("aria-pressed", String(S.lane === "ads"));
  $("win-60").setAttribute("aria-pressed", String(S.win === 60));
  $("win-120").setAttribute("aria-pressed", String(S.win === 120));
}

function renderFilter() {
  const has = Object.keys(S.filter).length > 0;
  const chips = Object.entries(S.filter).map(([k, v]) =>
    `<span class="chip">${esc((DIMS.find((d) => d.k === k) || { l: k }).l)} <b>${esc(v)}</b><button data-drop="${esc(k)}" aria-label="Remove ${esc(k)}">×</button></span>`).join("");
  $("filterbar").innerHTML = has
    ? `<span class="faint">Scoped to</span>${chips}<button class="linkbtn" id="clear-filter">Show all traffic</button>`
    : `<span class="faint">All traffic. Pick a cohort below, or an incident, to scope the page to it.</span>`;
}

/* ═══════════════════════ incidents ═══════════════════════════ */
function renderIncidents() {
  const { incidents } = callTool("list_incidents", { now: S.now });
  if (!incidents.length) {
    $("incidents").innerHTML = `<div class="empty">No incidents yet at ${hhmmss(S.now)}. The detector reads sealed windows every 30 s.</div>`;
    return;
  }
  $("incidents").innerHTML = incidents.map((x) => {
    const age = x.state === "resolved" ? `resolved ${hhmm(x.resolvedAt)}` : x.state === "confirming" ? `window 1 of 2 · since ${hhmmss(x.candidateAt)}` : `fired ${hhmmss(x.firedAt)}`;
    const lat = Math.round((x.firedAt - ts(x.onset)) / 1000);
    return `<button class="inc" data-inc="${x.id}" data-state="${x.state}" aria-pressed="${S.incident === x.id}">
      <div class="top"><span class="mono">${x.id} · ${x.sev} · ${x.lane}</span><span class="state ${x.state}">${x.state}</span></div>
      <div class="t">${esc(x.title)}</div>
      <div class="why mono">${esc(cohortLabel(x.cohort))}</div>
      <div class="why">Onset ${hhmm(ts(x.onset))} · ${age}${x.state !== "confirming" ? ` · onset to alert ${lat} s` : ""}</div>
    </button>`;
  }).join("");
}

/* ═══════════════════════ the minute grid ═════════════════════ */
const GRID = { rows: [], geom: null };
const LABEL_W = 118;
const ROW_H = 7;
const GROUP_GAP = 30;
const HEAT_H = 6;

function cellState(p, i) {
  const rec = p.minutes.get(i);
  const init = ts(p.startI);
  if (!rec) {
    // The open minute of a live playback is being measured on the device right now.
    const live = i === Math.floor((S.now - ts(0)) / MIN) && S.now >= init && i < p.endI;
    return live ? "measuring" : null;
  }
  if (S.now < ts(i)) return null;
  const minuteEnd = ts(i) + MIN;
  const terminal = rec.record_flags & (1 << RecordFlag.TERMINAL);
  // A terminal record is flushed as soon as the playback ends (§7.3); the end time is
  // approximated from the intent the minute accrued. Everything else waits for its slot.
  const arrives = terminal
    ? ts(i) + Math.min(MIN, (rec.debug ? rec.debug.intent_ms + rec.debug.ad_intent_ms : 0) + 2_000)
    : minuteEnd + p.uploadS * 1000;
  if (S.now < arrives) return terminal || S.now < minuteEnd ? "measuring" : "inflight";
  const bits = S.lane === "ads" ? rec.ad_issue_bitmap : rec.content_issue_bitmap;
  const intent = S.lane === "ads" ? rec.ad_intent_s : rec.content_intent_s;
  if (bits & (1 << IssueBit.STALL_TIMEOUT)) return "stall";
  if (bits & HEADLINE_ISSUE_MASK) return "impacted";
  if (rec.record_flags & (1 << RecordFlag.INELIGIBLE) || intent === 0) return "idle";
  if (bits & (1 << IssueBit.QUALITY_DEGRADATION)) return "quality";
  return "clean";
}

function matchesFilter(p, i) {
  for (const k in S.filter) {
    const v = k === "edge" ? p.servedEdge(i) : p.ctx[k];
    if (v !== S.filter[k]) return false;
  }
  return true;
}

function renderGrid() {
  const { list, ms: compileMs } = samplePlaybacks();
  const { from, to, open } = windowRange();
  const ref = Math.min(open, NMIN - 1);
  const rows = list.filter((p) => p.startI <= to && p.endI > from && ts(p.startI) <= S.now);
  // Group by the edge that served each playback most recently, so a shared-infrastructure
  // problem shows as a block: unrelated viewers, the same minutes.
  const groups = new Map();
  for (const p of rows) {
    const e = p.servedEdge(Math.min(ref, p.endI - 1));
    const g = `${p.ctx.region} · ${e}`;
    if (!groups.has(g)) groups.set(g, { key: g, region: p.ctx.region, edge: e, rows: [] });
    groups.get(g).rows.push(p);
  }
  const ordered = [...groups.values()].sort((a, b) => a.region.localeCompare(b.region) || a.edge.localeCompare(b.edge));
  for (const g of ordered) g.rows.sort((a, b) => a.startI - b.startI);

  const wrap = $("gridwrap");
  const cols = to - from + 1;
  const avail = Math.max(320, wrap.clientWidth);
  const colW = Math.max(5, Math.floor((avail - LABEL_W) / cols));
  const W = LABEL_W + colW * cols;
  const H = 22 + ordered.reduce((s, g) => s + GROUP_GAP + g.rows.length * ROW_H, 0);
  const cv = $("grid");
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  const g2 = cv.getContext("2d");
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2.clearRect(0, 0, W, H);
  const col = {
    clean: css("--good-cell"), impacted: css("--crit-cell"), stall: css("--crit"), idle: css("--idle-cell"),
    quality: css("--good-cell"), warn: css("--warn"), faint: css("--text-faint"), dim: css("--text-dim"),
    text: css("--text"), grid: css("--grid"), accent: css("--accent"), band: css("--band"),
  };
  g2.font = `11px ${css("--font-ui")}`;
  g2.textBaseline = "middle";

  // Minute states along the top: sealed, filling, open.
  for (let i = from; i <= to; i++) {
    const x = LABEL_W + (i - from) * colW;
    const st = minuteStatus(i, S.now).status;
    g2.fillStyle = st === "sealed" ? col.band : "transparent";
    if (st === "filling") { g2.fillStyle = col.warn; g2.globalAlpha = .35; }
    if (st === "open") { g2.fillStyle = col.faint; g2.globalAlpha = .25; }
    g2.fillRect(x, 14, colW - 1, 4);
    g2.globalAlpha = 1;
    if ((ts(i) / MIN) % 10 === 0) { g2.fillStyle = col.faint; g2.fillText(hhmm(ts(i)), x, 6); }
  }

  let y = 22;
  const geomRows = [];
  const crit = css("--crit");
  for (const g of ordered) {
    y += GROUP_GAP;
    g2.fillStyle = col.dim;
    g2.font = `600 11px ${css("--font-ui")}`;
    g2.fillText(`${g.edge}`, 0, y - 19);
    g2.font = `11px ${css("--font-ui")}`;
    g2.fillStyle = col.faint;
    g2.fillText(`${g.region} · ${g.rows.length} sampled`, 52, y - 19);
    g2.fillText("population", 0, y - 7);
    // Population heat for this edge from the minute cube: impacted rate against its own baseline.
    const conflict = (S.filter.edge && S.filter.edge !== g.edge) || (S.filter.cdn && !g.edge.startsWith(S.filter.cdn)) || (S.filter.region && S.filter.region !== g.region);
    if (!conflict) {
      const heat = callTool("query_minutes", { from, to, now: S.now, filter: { ...S.filter, edge: g.edge }, lane: S.lane }).rows;
      for (const r of heat) {
        if (!r.opp) continue;
        const x = LABEL_W + (r.i - from) * colW;
        const ratio = r.imp / Math.max(1e-9, r.exp);
        g2.fillStyle = ratio > 1.25 ? crit : col.band;
        g2.globalAlpha = (ratio > 1.25 ? Math.min(1, .25 + (ratio - 1.25) / 3) : 1) * (r.status === "filling" ? .5 : 1);
        g2.fillRect(x, y - 10, colW - 1, HEAT_H);
        g2.globalAlpha = 1;
      }
    }
    for (const p of g.rows) {
      const sel = S.playback === p.id;
      if (sel) { g2.fillStyle = col.accent; g2.fillRect(LABEL_W - 6, y, 3, ROW_H - 1); }
      for (let i = Math.max(from, p.startI); i <= Math.min(to, p.endI); i++) {
        const st = cellState(p, i);
        if (!st) continue;
        const x = LABEL_W + (i - from) * colW;
        const dim = !matchesFilter(p, i);
        g2.globalAlpha = dim ? .22 : 1;
        if (st === "measuring" || st === "inflight") {
          g2.strokeStyle = st === "inflight" ? col.dim : col.faint;
          g2.setLineDash(st === "measuring" ? [2, 2] : []);
          g2.strokeRect(x + .5, y + .5, colW - 2, ROW_H - 2);
          g2.setLineDash([]);
        } else {
          g2.fillStyle = col[st];
          g2.fillRect(x, y, colW - 1, ROW_H - 1);
          if (st === "quality") { g2.fillStyle = col.warn; g2.fillRect(x, y + ROW_H - 3, colW - 1, 2); }
          if (st === "stall") { g2.fillStyle = col.text; g2.fillRect(x + colW - 3, y, 2, ROW_H - 1); }
        }
        g2.globalAlpha = 1;
      }
      geomRows.push({ p, y });
      y += ROW_H;
    }
  }
  GRID.geom = { from, to, colW, rows: geomRows };
  // On narrow screens the grid scrolls; keep the newest minutes in view unless the reader scrolled back.
  if (!GRID.pinnedBack) wrap.scrollLeft = wrap.scrollWidth;

  const n = rows.length;
  $("grid-sub").textContent =
    `${n} playbacks, up to ${PER_EDGE} per served edge, so sampling weights differ by edge. Above each group, the population strip is that edge's impacted rate against its baseline from the minute cube. ` +
    `Compiled in this page by the reference SDK in ${Math.round(compileMs)} ms. A dashed outline is a minute still open on the device; a plain outline is sealed but waiting for its upload slot.`;
  $("grid-legend").innerHTML = [
    ["--good-cell", "Issue-free minute"], ["--crit-cell", "Impacted minute"], ["--crit", "Stall-out, playback ended"],
    ["--idle-cell", "Paused or ineligible"],
  ].map(([c, l]) => `<span><i class="sw" style="background:var(${c})"></i>${l}</span>`).join("") +
    `<span><i class="sw" style="background:var(--good-cell);box-shadow:inset 0 -2px 0 var(--warn)"></i>Below peak rendition (not headline)</span>` +
    `<span><i class="sw" style="background:linear-gradient(90deg,var(--band),var(--crit))"></i>Population strip: edge rate above baseline</span>` +
    `<span><i class="sw" style="border:1px solid var(--text-dim)"></i>In flight</span>` +
    `<span><i class="sw" style="border:1px dashed var(--text-faint)"></i>Open on device</span>`;
}

function gridHit(ev) {
  const g = GRID.geom;
  if (!g) return null;
  const r = ev.target.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  if (x < LABEL_W) return null;
  const i = g.from + Math.floor((x - LABEL_W) / g.colW);
  const row = g.rows.find((rw) => y >= rw.y && y < rw.y + ROW_H);
  if (!row || i > g.to) return null;
  return { p: row.p, i };
}

function gridTip(ev) {
  const hit = gridHit(ev);
  const tip = $("tip");
  if (!hit) { tip.hidden = true; return; }
  const { p, i } = hit;
  const rec = p.minutes.get(i);
  const st = cellState(p, i);
  let body = `<div><b class="mono">${p.id}</b> · ${hhmm(ts(i))}</div><div class="k">${p.ctx.device} · app ${p.ctx.app} · ${p.servedEdge(i)} · ${p.ctx.isp}</div>`;
  if (!rec || st === "measuring") body += `<div>Open on the device. Seals at ${hhmm(ts(i) + MIN)}:00.</div>`;
  else if (st === "inflight") body += `<div>Sealed. Uploads at ${hhmmss(ts(i) + MIN + p.uploadS * 1000)} (slot ${p.uploadS} s).</div>`;
  else {
    const bits = S.lane === "ads" ? rec.ad_issue_bitmap : rec.content_issue_bitmap;
    const list = issueList(bits);
    body += `<div>${S.lane === "ads" ? "Ad" : "Content"} intent ${S.lane === "ads" ? rec.ad_intent_s : rec.content_intent_s} s · active ${S.lane === "ads" ? rec.ad_active_s : rec.content_active_s} s</div>`;
    body += `<div>${list.length ? list.join(", ") : "No issues"}${rec.issue_counters.rebuffer_count ? ` · ${rec.issue_counters.rebuffer_count} rebuffer${rec.issue_counters.rebuffer_count > 1 ? "s" : ""}` : ""}</div>`;
    if (rec.context_change_flags & (1 << ContextChangeFlag.CDN_SWITCH)) body += `<div class="k">CDN switch in this minute (context, not an issue)</div>`;
  }
  tip.innerHTML = body;
  placeTip(ev);
}
function placeTip(ev) {
  const tip = $("tip");
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

/* ═══════════════════════ headline charts ═════════════════════ */
const CH = { rows: [], geom: null };

function renderHeadline() {
  const { from, to } = windowRange();
  const { rows } = callTool("query_minutes", { from, to, now: S.now, filter: S.filter, lane: S.lane });
  CH.rows = rows;
  const issues = S.lane === "ads" ? AD_ISSUES : ISSUES;
  $("head-title").textContent = S.lane === "ads" ? "Issue-free ad opportunity, minute by minute" : "Issue-free opportunity, minute by minute";

  // KPIs: the last sealed minute, and the sealed detector window around it.
  const ls = rows.filter((r) => r.status === "sealed").at(-1);
  const win5 = rows.filter((r) => r.status === "sealed").slice(-5);
  const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);
  if (ls) {
    const rate = 1 - ls.imp / ls.opp, exp = 1 - ls.exp / ls.opp;
    const excess = sum(win5, (r) => r.imp - r.exp);
    const compl = sum(win5, (r) => r.recvRecords) / Math.max(1, sum(win5, (r) => r.expRecords));
    $("kpis").innerHTML = `
      <div class="kpi"><div class="l">Issue-free · ${hhmm(ls.ts)}</div><div class="v">${pct(rate, 2)}</div><div class="d ${rate < exp ? "up" : "down"}">${pt(rate - exp)} vs expected ${pct(exp, 1)}</div></div>
      <div class="kpi"><div class="l">Impacted opportunity · ${hhmm(ls.ts)}</div><div class="v">${compact(ls.imp)} s</div><div class="d dim">expected ${compact(ls.exp)} s</div></div>
      <div class="kpi"><div class="l">Excess impact · last ${win5.length} sealed min</div><div class="v ${excess > 0 ? "up" : ""}">${excess > 0 ? "+" : ""}${compact(excess)} s</div><div class="d dim">the quantity cohorts are ranked by</div></div>
      <div class="kpi"><div class="l">Playbacks in ${hhmm(ls.ts)}</div><div class="v">${compact(ls.pb)}</div><div class="d dim">records received ${pct(compl, 1)}</div></div>`;
  } else {
    $("kpis").innerHTML = `<div class="empty">No sealed minutes in this scope yet.</div>`;
  }

  drawRateChart(rows, from, to);
  drawSecsChart(rows, from, to, issues);
  $("chart-legend").innerHTML = issues.map((x) => `<span><i class="sw" style="background:var(${x.c})"></i>${x.l}</span>`).join("") +
    `<span><i class="sw" style="background:none;border-top:2px dashed var(--text-dim);height:0;width:14px"></i>Expected (seasonal, mix-aware baseline)</span>` +
    `<span><i class="sw" style="background:repeating-linear-gradient(135deg,var(--warn) 0 2px,transparent 2px 4px)"></i>Filling</span>`;
}

function xScale(from, to, W, padL, padR) {
  const n = to - from + 1;
  const bw = (W - padL - padR) / n;
  return { bw, x: (i) => padL + (i - from) * bw, n };
}

function boundaryMarkup(from, to, sx, top, bottom, label) {
  let out = "";
  if (BOUNDARY_I > from && BOUNDARY_I <= to) {
    const x = sx.x(BOUNDARY_I) - 0.5;
    out += `<line x1="${x}" x2="${x}" y1="${top}" y2="${bottom}" stroke="var(--accent)" stroke-dasharray="3 3"/>`;
    if (label) out += `<text x="${x + 4}" y="${top + 10}" class="lab">series boundary · profile 11 → 12</text>`;
  }
  if (RESTATED.i >= from && RESTATED.i <= to && S.now >= RESTATED.at && label) {
    const x = sx.x(RESTATED.i) + sx.bw / 2;
    out += `<text x="${x}" y="${top + 22}" text-anchor="middle" class="lab" style="fill:var(--warn)">R</text>`;
  }
  return out;
}

function drawRateChart(rows, from, to) {
  const box = $("chart-rate");
  const W = Math.max(300, box.clientWidth), H = 170, padL = 46, padR = 12, padT = 12, padB = 6;
  const sx = xScale(from, to, W, padL, padR);
  const vals = rows.filter((r) => r.opp > 0);
  let lo = Math.min(...vals.map((r) => Math.min(1 - r.imp / r.opp, 1 - r.exp / r.opp)), 0.95);
  lo = Math.max(0, Math.floor((lo - 0.01) * 50) / 50);
  const hi = 1;
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Issue-free opportunity per minute">`;
  // Grid and labels.
  const ticks = 4;
  for (let k = 0; k <= ticks; k++) {
    const v = lo + ((hi - lo) * k) / ticks;
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`;
    s += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${(v * 100).toFixed(lo > .9 ? 1 : 0)}%</text>`;
  }
  // Expected band, by policy segment so the boundary breaks it.
  const segs = [[from, Math.min(to, BOUNDARY_I - 1)], [Math.max(from, BOUNDARY_I), to]].filter(([a, b]) => a <= b);
  for (const [a, b] of segs) {
    const pts = rows.filter((r) => r.i >= a && r.i <= b && r.opp > 0);
    if (pts.length < 1) continue;
    const up = pts.map((r) => `${sx.x(r.i) + sx.bw / 2},${y(Math.min(1, 1 - r.exp / r.opp + .006))}`);
    const dn = pts.slice().reverse().map((r) => `${sx.x(r.i) + sx.bw / 2},${y(1 - r.exp / r.opp - .006)}`);
    s += `<polygon points="${up.concat(dn).join(" ")}" fill="var(--band)"/>`;
    s += `<polyline points="${pts.map((r) => `${sx.x(r.i) + sx.bw / 2},${y(1 - r.exp / r.opp)}`).join(" ")}" fill="none" stroke="var(--text-dim)" stroke-dasharray="4 3" stroke-width="1"/>`;
    // Observed: solid over sealed minutes, dashed over filling ones.
    const sealed = pts.filter((r) => r.status === "sealed");
    if (sealed.length) s += `<polyline points="${sealed.map((r) => `${sx.x(r.i) + sx.bw / 2},${y(1 - r.imp / r.opp)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`;
    const tail = pts.filter((r) => r.status === "filling");
    if (tail.length && sealed.length) {
      const all = [sealed.at(-1), ...tail];
      s += `<polyline points="${all.map((r) => `${sx.x(r.i) + sx.bw / 2},${y(1 - r.imp / r.opp)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="3 3" opacity=".7"/>`;
    }
    if (sealed.length) {
      const e = sealed.at(-1);
      s += `<circle cx="${sx.x(e.i) + sx.bw / 2}" cy="${y(1 - e.imp / e.opp)}" r="3.5" fill="var(--accent)"/>`;
    }
  }
  s += boundaryMarkup(from, to, sx, padT, H - padB, true);
  s += `<rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" data-hover="1"/>`;
  s += `</svg>`;
  box.innerHTML = s;
  CH.geom = { from, to, sx, padL, padR };
}

function drawSecsChart(rows, from, to, issues) {
  const box = $("chart-secs");
  const W = Math.max(300, box.clientWidth), H = 150, padL = 46, padR = 12, padT = 8, padB = 22;
  const sx = xScale(from, to, W, padL, padR);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.imp, r.exp))) * 1.08;
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Impacted opportunity seconds per minute, by issue">`;
  s += `<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="4" fill="var(--warn)" opacity=".55"/></pattern></defs>`;
  for (let k = 0; k <= 3; k++) {
    const v = (max * k) / 3;
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>`;
    s += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  s += `<text x="${padL}" y="${padT + 2}" class="lab" dy="6" style="font-size:10.5px">impacted opportunity · s per minute</text>`;
  const bw = Math.max(1, sx.bw - (sx.bw > 6 ? 2 : 1));
  for (const r of rows) {
    const x = sx.x(r.i);
    if (r.status === "open") {
      s += `<rect x="${x + .5}" y="${y(max * .98)}" width="${bw - 1}" height="${y(0) - y(max * .98)}" fill="none" stroke="var(--text-faint)" stroke-dasharray="2 2"/>`;
      continue;
    }
    // Per-issue seconds overlap inside a minute; scale them to the impacted total for stacking.
    const tot = r.iss.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    for (let k = 0; k < issues.length; k++) {
      const v = (r.iss[k] / tot) * r.imp;
      if (v <= 0) continue;
      s += `<rect x="${x}" y="${y(acc + v)}" width="${bw}" height="${Math.max(0, y(acc) - y(acc + v))}" fill="var(${issues[k].c})" opacity="${r.status === "filling" ? .45 : .9}"/>`;
      acc += v;
    }
    if (r.status === "filling") s += `<rect x="${x}" y="${y(r.imp)}" width="${bw}" height="${y(0) - y(r.imp)}" fill="url(#hatch)"/>`;
  }
  const segs = [[from, Math.min(to, BOUNDARY_I - 1)], [Math.max(from, BOUNDARY_I), to]].filter(([a, b]) => a <= b);
  for (const [a, b] of segs) {
    const pts = rows.filter((r) => r.i >= a && r.i <= b && r.status === "sealed");
    if (pts.length) s += `<polyline points="${pts.map((r) => `${sx.x(r.i) + sx.bw / 2},${y(r.exp)}`).join(" ")}" fill="none" stroke="var(--text-dim)" stroke-dasharray="4 3"/>`;
  }
  s += boundaryMarkup(from, to, sx, padT, H - padB, false);
  for (let i = from; i <= to; i++) {
    if ((ts(i) / MIN) % 10 === 0) s += `<text x="${sx.x(i)}" y="${H - 6}">${hhmm(ts(i))}</text>`;
  }
  s += `<rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" data-hover="1"/></svg>`;
  box.innerHTML = s;
}

function chartTip(ev) {
  const g = CH.geom;
  if (!g) return;
  const box = ev.currentTarget.getBoundingClientRect();
  const x = ev.clientX - box.left;
  const W = box.width;
  const scale = W / Math.max(300, ev.currentTarget.clientWidth || W);
  const i = g.from + Math.floor((x / scale - g.padL) / g.sx.bw);
  const r = CH.rows.find((row) => row.i === i);
  const tip = $("tip");
  if (!r) { tip.hidden = true; return; }
  const issues = S.lane === "ads" ? AD_ISSUES : ISSUES;
  let body = `<div><b>${hhmm(r.ts)}</b> · ${r.status}${r.status === "filling" ? ` · ${Math.round(r.arrived * 100)}% arrived` : ""}${r.restated ? " · restated" : ""}</div>`;
  if (r.status === "open") body += `<div class="k">Still being measured on devices. Nothing has been sent for this minute yet.</div>`;
  else {
    body += `<div>Issue-free <b>${pct(1 - r.imp / r.opp, 2)}</b> <span class="k">expected ${pct(1 - r.exp / r.opp, 2)}</span></div>`;
    body += `<div>Impacted <b>${compact(r.imp)} s</b> of ${compact(r.opp)} s</div>`;
    const tot = r.iss.reduce((a, b) => a + b, 0) || 1;
    body += issues.map((x, k) => `<div class="k">${x.l}: ${compact((r.iss[k] / tot) * r.imp)} s</div>`).join("");
    body += `<div class="k">${(POLICIES.find((p) => p.key === r.policy) || {}).label}</div>`;
    if (r.restated) body += `<div class="k">A late offline-queue flush restated this minute at ${hhmm(RESTATED.at)}. Alerts read the sealed value; reports show the restated one.</div>`;
  }
  tip.innerHTML = body;
  placeTip(ev);
}

/* ═══════════════════════ attribution ═════════════════════════ */
let ATTR = null;
function renderAttribution() {
  const ls = lastSealed();
  const res = callTool("query_attribution", { from: ls - 4, to: ls, now: S.now, lane: S.lane });
  ATTR = res;
  if (!res.window.minutes) { $("attr").innerHTML = `<div class="empty">Waiting for a sealed window.</div>`; return; }
  $("attr-sub").textContent = `Sealed window ${hhmm(ts(res.window.from))}–${hhmm(ts(res.window.to))}. Excess = (rate − baseline) × opportunity.`;
  const maxEx = Math.max(1, ...res.ranked.map((r) => r.excess));
  const row = (r, extra = "") => `<tr data-cohort="${esc(r.key)}" aria-selected="${S.cohortKey === r.key}">
      <td><span class="cohort">${esc(cohortLabel(r.dims))}</span>${extra}</td>
      <td>${pct(r.rate)}</td><td class="faint">${pct(r.baseline)}</td>
      <td class="bar-cell"><i style="width:${Math.max(2, (Math.max(0, r.excess) / maxEx) * 70)}px"></i><span>${compact(r.excess)} s</span></td>
      <td>${pct(r.share, 0)}</td><td class="faint">${pct(r.traffic, 1)}</td></tr>`;
  let body = res.ranked.map((r) => row(r)).join("");
  const w = res.worstRate;
  const inRanked = w && res.ranked.some((r) => r.key === w.key);
  if (w && !inRanked) body += `<tr><td colspan="6" class="faint" style="text-align:left;padding-top:10px">Worst rate on the page, outside the ranking:</td></tr>` + row(w, `<span class="tag warn">worst rate</span>`);
  $("attr").innerHTML = `<table><thead><tr><th>Cohort</th><th>Rate</th><th>Baseline</th><th style="text-align:left;padding-left:16px">Excess impact</th><th>Of excess</th><th>Traffic</th></tr></thead><tbody>${body}</tbody></table>`;
  const top = res.ranked[0];
  $("attr-note").innerHTML = top && w && !inRanked
    ? `<b>${esc(cohortLabel(w.dims))}</b> has the worst rate (${pct(w.rate)}) and explains ${pct(w.share, 1)} of the excess. Ranking by rate would send on-call there. <b>${esc(cohortLabel(top.dims))}</b> explains ${pct(top.share, 0)} on ${pct(top.traffic, 1)} of traffic. CDN, region and ISP are correlated, so several rows can be one incident: these are contributing cohorts, not causes.`
    : top ? `Rows can overlap: CDN, region and ISP are correlated, so these are contributing cohorts, not causes.` : `Nothing clears the traffic and excess floors in this window.`;
}

/* ═══════════════════════ aligned view ════════════════════════ */
function renderAligned() {
  const ls = lastSealed();
  const dims = S.cohortKey ? Object.fromEntries(S.cohortKey.split("&").map((p) => p.split("="))) : S.filter;
  // The join runs on conformed dimensions only: served edge and region (§12.3).
  let edge = dims.edge || null;
  if (!edge) {
    const cands = [...new Set(samplePlaybacks().list.map((p) => p.ctx.edge)).add("edge-b7")];
    let best = null;
    for (const e of cands) {
      const f = { ...dims, edge: e };
      const { rows } = callTool("query_minutes", { from: ls - 4, to: ls, now: S.now, filter: f, lane: S.lane });
      const ex = rows.reduce((s, r) => s + (r.imp - r.exp), 0);
      if (!best || ex > best.ex) best = { e, ex };
    }
    edge = best && best.ex > 0 ? best.e : null;
  }
  const region = edge ? { "edge-b3": "US-IL", "edge-b7": "US-IL", "edge-a2": "US-IL", "edge-a5": "US-NY", "edge-c1": "US-NY", "edge-a1": "US-CA", "edge-c4": "US-CA", "edge-a3": "US-TX", "edge-b2": "US-TX", "edge-a4": "US-MT" }[edge] : dims.region || null;
  const svcRegion = { "US-IL": "us-central1", "US-NY": "us-east1", "US-CA": "us-west1", "US-TX": "us-south1", "US-MT": "us-central1" }[region] || null;
  if (!edge && !svcRegion) {
    $("align-title").textContent = "Aligned view";
    $("align").innerHTML = `<div class="empty">This cohort carries no excess on any served edge in the sealed window, so there is nothing to line up.</div>`;
    $("align-quad").innerHTML = ""; $("align-note").innerHTML = ""; $("align-sub").textContent = "";
    return;
  }
  const from = Math.max(0, ls - 6), to = Math.min(NMIN - 1, ls + 2);
  const client = callTool("query_minutes", { from, to, now: S.now, filter: { edge }, lane: S.lane }).rows;
  const control = edge && region ? callTool("query_minutes", { from: ls, to: ls, now: S.now, filter: { region, cdn: edge.startsWith("edge-a") ? "edge-b" : "edge-a" }, lane: S.lane }).rows[0] : null;
  const svc = callTool("query_services", { from, to, now: S.now, edge, region: svcRegion }).rows;
  const shieldCtl = control ? callTool("query_services", { from: ls, to: ls, now: S.now, edge: region === "US-IL" ? "edge-a2" : null, region: null }).rows[0] : null;
  $("align-title").textContent = `Aligned view · ${edge} · ${svcRegion}`;
  $("align-sub").textContent = `Joined on minute × served edge × region. App version and device are client-only, so the client column is all apps on ${edge}.`;

  const byI = (service, i) => svc.find((r) => r.service === service && r.i === i);
  const regionFlag = (i) => ["packager", "license", "ad-decision"].map((n) => {
    const r = byI(n, i);
    if (!r) return `<span class="faint" title="${n}: not arrived">·</span>`;
    const bad = r.issue_bits !== 0;
    return `<span title="${n}: p95 ${rungRange(r.p95)}, 5xx ${pct(r.err, 2)}" style="color:${bad ? "var(--crit)" : "var(--text-faint)"}">${n === "packager" ? "P" : n === "license" ? "L" : "A"}${bad ? "!" : ""}</span>`;
  }).join(" ");
  let body = "";
  let firstSvc = null, firstClient = null;
  for (let i = from; i <= to; i++) {
    const c = client.find((r) => r.i === i);
    const sh = byI("origin-shield", i);
    const st = minuteStatus(i, S.now).status;
    const rate = c && c.opp ? c.imp / c.opp : null;
    const base = c && c.opp ? c.exp / c.opp : null;
    if (sh && sh.issue_bits && firstSvc === null) firstSvc = i;
    if (rate != null && st === "sealed" && rate > base * 1.6 && firstClient === null) firstClient = i;
    body += `<tr data-minute="${i}">
      <td class="mono">${hhmm(ts(i))}${st !== "sealed" ? ` <span class="tag ${st === "filling" ? "warn" : ""}">${st}</span>` : ""}</td>
      <td style="color:${rate != null && rate > base * 1.6 ? "var(--crit)" : "inherit"}">${st === "open" ? "–" : pct(rate)}</td>
      <td>${sh ? Math.round(sh.rps) : "–"}</td><td>${sh ? pct(sh.hit) : "–"}</td>
      <td style="color:${sh && sh.issue_bits & 1 ? "var(--crit)" : "inherit"}">${sh ? rungRange(sh.p95) : "–"}</td>
      <td style="color:${sh && sh.err > .01 ? "var(--crit)" : "inherit"}">${sh ? pct(sh.err) : "–"}</td>
      <td style="color:${sh && sh.partial ? "var(--warn)" : "inherit"}" title="${sh && sh.partial ? "Some agents missed this minute; service counts are lower bounds" : ""}">${sh ? `${sh.agents}${sh.partial ? "*" : ""}` : "–"}</td>
      <td class="mono">${regionFlag(i)}</td></tr>`;
  }
  if (control && shieldCtl) {
    body += `<tr><td class="mono faint">${hhmm(ts(ls))} · ${shieldCtl.key}</td><td class="faint">${pct(control.imp / control.opp)}</td><td class="faint">${Math.round(shieldCtl.rps)}</td><td class="faint">${pct(shieldCtl.hit)}</td><td class="faint">${rungRange(shieldCtl.p95)}</td><td class="faint">${pct(shieldCtl.err)}</td><td class="faint">${shieldCtl.agents}</td><td class="faint">control</td></tr>`;
  }
  $("align").innerHTML = `<table><thead><tr><th>Minute</th><th>Viewers impacted</th><th>Shield fetch/s</th><th>Hit ratio</th><th>Shield p95</th><th>5xx</th><th>Agents</th><th title="Packager · License · Ad decisioning in the same region">Region P · L · A</th></tr></thead><tbody>${body}</tbody></table>`;

  // The 2×2 (§12.5).
  const lsClient = client.find((r) => r.i === ls);
  const viewersHit = lsClient && lsClient.opp && lsClient.imp / lsClient.opp > (lsClient.exp / lsClient.opp) * 1.6;
  const svcHit = svc.some((r) => r.i >= ls - 2 && r.i <= ls && r.issue_bits !== 0);
  const cell = (on, text) => `<div class="${on ? "on" : ""}">${text}</div>`;
  $("align-quad").innerHTML = `<div class="quad">
    <div class="h"></div><div class="h">Services degraded, same minute</div><div class="h">Services clean</div>
    <div class="h">Viewers impacted</div>${cell(viewersHit && svcHit, "<b>Delivery-chain candidate.</b> Report the service path as contributing.")}${cell(viewersHit && !svcHit, "<b>Beyond our services.</b> CDN edge, ISP, last mile or device.")}
    <div class="h">Viewers fine</div>${cell(!viewersHit && svcHit, "<b>Absorbed.</b> A service SLO page, never a QoE page.")}${cell(!viewersHit && !svcHit, "Nothing to do.")}
  </div>`;
  const order = firstSvc !== null && firstClient !== null
    ? firstSvc < firstClient ? `Services moved at <b>${hhmm(ts(firstSvc))}</b>, viewers at <b>${hhmm(ts(firstClient))}</b>.` : firstSvc === firstClient ? `Services and viewers moved in the same minute, <b>${hhmm(ts(firstSvc))}</b>.` : `Viewers moved first, at <b>${hhmm(ts(firstClient))}</b>.`
    : "";
  $("align-note").innerHTML = `${svc.some((r) => r.partial) ? "* Some agents missed the minute, so its service counts are lower bounds. " : ""}${order} The services lane corroborates and never pages on viewer experience. The alert says <b>moved with</b>, never <b>caused by</b>.`;
}

/* ═══════════════════════ the two tests ═══════════════════════ */
function renderTests() {
  const ls = lastSealed();
  const { from } = windowRange();
  const mix = callTool("query_mix", { from: Math.max(0, ls - 119), to: ls, now: S.now, dim: "app", step: 10 });
  const box = $("mix");
  const W = Math.max(300, box.clientWidth), H = 150, padL = 40, padR = 52, padT = 8, padB = 22;
  const bs = mix.buckets.filter((b) => !b.empty);
  const bw = (W - padL - padR) / Math.max(1, bs.length);
  const y = (v) => padT + (1 - v) * (H - padT - padB);
  const colors = { "6.8.1": "--i6", "7.0.4": "--i5", "7.2.0": "--i1" };
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Opportunity share by app version">`;
  for (const v of [0, .5, 1]) s += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  bs.forEach((b, k) => {
    let acc = 0;
    for (const v of mix.values) {
      const h = b.shares[v];
      s += `<rect x="${padL + k * bw + 1}" y="${y(acc + h)}" width="${Math.max(1, bw - 2)}" height="${y(acc) - y(acc + h)}" fill="var(${colors[v]})" opacity=".85"/>`;
      if (k === bs.length - 1) s += `<text x="${W - padR + 6}" y="${(y(acc) + y(acc + h)) / 2 + 4}" class="lab">${v} ${Math.round(h * 100)}%</text>`;
      acc += h;
    }
    if (k % 2 === 0 || bs.length < 7) s += `<text x="${padL + k * bw + 2}" y="${H - 6}">${hhmm(ts(b.from))}</text>`;
  });
  s += `</svg>`;
  box.innerHTML = s;
  const a = bs[0], z = bs.at(-1);
  if (a && z) {
    const d72 = z.shares["7.2.0"] - a.shares["7.2.0"];
    $("mix-note").innerHTML = Math.abs(d72) > .05
      ? `<b>Mix shift confirmed.</b> App 7.2.0 went from ${pct(a.shares["7.2.0"], 0)} to ${pct(z.shares["7.2.0"], 0)} of opportunity during a staged rollout. That is a fact about composition, reported alongside Test B, never instead of it.`
      : `No material change in composition across this window.`;
  }
  void from;

  const within = callTool("query_within", { from: ls - 4, to: ls, now: S.now, dims: ["app", "cdn"] });
  const rows = within.rows.slice(0, 9);
  const worst = within.rows.slice().sort((p, q) => q.delta - p.delta)[0];
  $("within").innerHTML = `<table><thead><tr><th>Cohort</th><th>Baseline</th><th>Observed</th><th>Δ</th><th>Traffic</th></tr></thead><tbody>${rows.map((r) =>
    `<tr data-cohort="${esc(keyOf(r.dims))}"><td class="cohort">${esc(r.key)}</td><td class="faint">${pct(r.baseline)}</td><td>${pct(r.rate)}</td><td style="color:${r.delta > .02 ? "var(--crit)" : "inherit"}">${pt(r.delta)}</td><td class="faint">${pct(r.traffic, 1)}</td></tr>`).join("")}</tbody></table>`;
  if (worst && worst.delta > .02) {
    const sameApp = within.rows.filter((r) => r.dims.app === worst.dims.app && r.key !== worst.key);
    const fine = sameApp.filter((r) => r.delta < .01).map((r) => r.dims.cdn);
    $("within-note").innerHTML = `<b>Real regression on ${esc(worst.key)}</b>, ${pt(worst.delta)} against its own baseline.` +
      (fine.length ? ` App ${esc(worst.dims.app)} on ${fine.join(" and ")} is within baseline, so this is not a bad app release.` : "");
  } else {
    $("within-note").textContent = "Every material cohort is within its own baseline.";
  }
}

/* ═══════════════════════ completeness and coverage ═══════════ */
function renderCompleteness() {
  const ls = lastSealed();
  const row = (r) => {
    const cls = r.ratio < .9 ? "bad" : r.ratio < .97 ? "low" : "";
    const pts = r.minutes.map((m, k) => `${(k / Math.max(1, r.minutes.length - 1)) * 80},${18 - (Math.max(.8, Math.min(1, m.ratio)) - .8) / .2 * 16}`).join(" ");
    return `<tr><td>${esc(r.key)}</td><td><div class="cbar"><i class="${cls}" style="width:${(r.ratio || 0) * 100}%"></i></div></td><td>${pct(r.ratio, 1)}</td>
      <td><svg class="spark" width="82" height="20" viewBox="-1 0 82 20" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--text-dim)" stroke-width="1.2"/></svg></td></tr>`;
  };
  const tiers = callTool("query_completeness", { from: ls - 14, to: ls, now: S.now, by: "tier" }).rows;
  const regions = callTool("query_completeness", { from: ls - 14, to: ls, now: S.now, by: "region" }).rows;
  $("complete").innerHTML = `<table><thead><tr><th>Platform tier</th><th></th><th>Received</th><th>Last 15 min</th></tr></thead><tbody>${tiers.map(row).join("")}</tbody></table>
    <table style="margin-top:10px"><thead><tr><th>Region</th><th></th><th>Received</th><th>Last 15 min</th></tr></thead><tbody>${regions.map(row).join("")}</tbody></table>
    <p class="note">Missing minutes are correlated with bad networks, so a gap on a tier is reported as a gap, never read as health on that tier.${S.now >= RESTATED.at ? ` Legacy CTV ${hhmm(ts(RESTATED.i))} was restated at ${hhmm(RESTATED.at)} when an offline queue flushed.` : ""}</p>`;

  const cov = callTool("query_coverage", { i: ls, now: S.now }).rows;
  $("cover-sub").textContent = `Sealed envelopes per agent for ${hhmm(ts(ls))}. An empty minute is still sent; a missing one is a gap.`;
  $("coverage").innerHTML = `<table><thead><tr><th>Cluster</th><th>Service</th><th>Agents</th><th></th></tr></thead><tbody>${cov.sort((a, b) => a.received / a.expected - b.received / b.expected).map((r) =>
    `<tr><td class="mono">${esc(r.cluster)}</td><td class="faint">${esc(r.service)}</td><td>${r.received}/${r.expected}</td><td>${r.received < r.expected ? `<span class="tag warn">counts are lower bounds</span>` : `<span class="tag good">complete</span>`}</td></tr>`).join("")}</tbody></table>`;
}

/* ═══════════════════════ inspector ═══════════════════════════ */
const LAYOUT_COLORS = ["--i6", "--i5", "--i3", "--i4", "--i1", "--svc", "--good", "--text-faint", "--border"];

function defaultPlayback() {
  const { list } = samplePlaybacks();
  const i11 = idx(12, 11);
  const hit = (p, a, b) => { for (let i = a; i <= b; i++) { const m = p.minutes.get(i); if (m && m.content_issue_bitmap & HEADLINE_ISSUE_MASK) return true; } return false; };
  const onB7 = list.filter((p) => p.servedEdge(i11) === "edge-b7" && p.minutes.get(i11));
  return onB7.find((p) => p.ctx.app === "7.2.0" && hit(p, i11, i11 + 2)) || onB7.find((p) => hit(p, i11, i11 + 2)) || onB7[0] || list[0];
}

function renderInspector() {
  const { list } = samplePlaybacks();
  let p = list.find((x) => x.id === S.playback);
  if (!p) { p = defaultPlayback(); S.playback = p.id; }
  const arrived = [...p.minutes.keys()].filter((i) => { const st = cellState(p, i); return st && st !== "measuring" && st !== "inflight"; });
  if (S.minute == null || !p.minutes.has(S.minute)) S.minute = arrived.find((i) => p.minutes.get(i).content_issue_bitmap & HEADLINE_ISSUE_MASK) ?? arrived.at(-1) ?? null;
  $("insp-title").textContent = `Playback ${p.id}`;
  $("insp-sub").textContent = `Session ${p.id.slice(0, 8)} · ruleset ${p.rulesetVersion} · upload slot ${p.uploadS} s after each minute`;

  const keys = [...p.minutes.keys()].sort((a, b) => a - b);
  const strip = keys.map((i) => {
    const st = cellState(p, i) || "inflight";
    const bg = { clean: "var(--good-cell)", impacted: "var(--crit-cell)", stall: "var(--crit)", idle: "var(--idle-cell)", quality: "var(--good-cell)", inflight: "transparent", measuring: "transparent" }[st];
    return `<button style="background:${bg};${st === "inflight" || st === "measuring" ? "box-shadow:inset 0 0 0 1px var(--text-faint)" : ""}" aria-pressed="${S.minute === i}" data-pm="${i}" title="${hhmm(ts(i))} · ${st}" aria-label="${hhmm(ts(i))} ${st}"></button>`;
  }).join("");

  const attempt = p.attempts.at(-1);
  const ends = { USER_EXIT: "viewer left", STALL_TIMEOUT: "stalled out", ERROR: "failed" }[p.endedBy];
  const ctxDl = `<dl class="kv">
    <dt>Device</dt><dd>${esc(p.ctx.device)} · app ${esc(p.ctx.app)}</dd>
    <dt>Requested CDN</dt><dd>${esc(p.ctx.cdn)} <span class="faint">client-observable</span></dd>
    <dt>Served edge</dt><dd>${esc(p.servedEdge(S.minute ?? p.startI))} <span class="faint">server-derived at ingest</span></dd>
    <dt>ISP · region</dt><dd>${esc(p.ctx.isp)} · ${esc(p.ctx.region)} <span class="faint">server-derived, never sent down</span></dd>
    <dt>Attempt</dt><dd>${attempt ? `${attempt.result}${attempt.startup_duration_ms != null ? ` · startup ${attempt.startup_duration_ms.toLocaleString()} ms exact` : ""}${attempt.retry_count ? ` · ${attempt.retry_count} retry` : ""}` : "–"}</dd>
    <dt>Minutes</dt><dd>${keys.length} sealed${ends && p.endI <= Math.floor((S.now - ts(0)) / MIN) ? ` · ${ends} at ${hhmm(ts(p.endI - 1))}` : ""}</dd>
  </dl>`;

  let recHtml = `<div class="empty">This minute has not arrived yet.</div>`;
  const rec = S.minute != null ? p.minutes.get(S.minute) : null;
  const st = rec ? cellState(p, S.minute) : null;
  if (rec && st && st !== "measuring" && st !== "inflight") {
    const { debug, ...wire } = rec;
    const base = { base_minute_ts: ts(keys[0]), base_sequence: 0 };
    const bytes = packMinute(rec, base);
    const back = unpackMinute(bytes, base, rec);
    const ok = canon(back) === canon(wire);
    const byteSpans = Array.from(bytes, (b, k) => {
      const seg = PACKED_LAYOUT.findIndex((l) => k >= l.start && k < l.start + l.length);
      return `<span class="byte" style="--c:var(${LAYOUT_COLORS[seg]})" title="${esc(PACKED_LAYOUT[seg].name)}">${b.toString(16).padStart(2, "0")}</span>`;
    }).join("");
    const legend = PACKED_LAYOUT.map((l, k) => `<i style="--c:var(${LAYOUT_COLORS[k]})"></i><span>${esc(l.name)} · ${l.length} B</span>`).join("");
    const show = {
      minute_ts: new Date(wire.minute_ts).toISOString(), sequence_no: wire.sequence_no, context_id: wire.context_id,
      content_intent_s: wire.content_intent_s, content_active_s: wire.content_active_s,
      content_issue_bitmap: `0x${wire.content_issue_bitmap.toString(16).padStart(2, "0")} ${issueList(wire.content_issue_bitmap).join(" | ")}`.trim(),
      ad_intent_s: wire.ad_intent_s, ad_active_s: wire.ad_active_s,
      ad_issue_bitmap: `0x${wire.ad_issue_bitmap.toString(16).padStart(2, "0")} ${issueList(wire.ad_issue_bitmap).join(" | ")}`.trim(),
      issue_counters: Object.fromEntries(Object.entries(wire.issue_counters).map(([k, v]) => [k, v === NO_BUCKET && k.endsWith("bucket") ? "none" : v])),
      bitrate_bucket: wire.bitrate_bucket, peak_rendition_seconds: wire.peak_rendition_seconds,
      context_change_flags: wire.context_change_flags, record_flags: wire.record_flags,
      policy: `taxonomy ${wire.taxonomy_version} · profile ${wire.threshold_profile_id} · eligibility ${wire.eligibility_policy_version} · ruleset ${wire.ruleset_version}`,
    };
    const rb = wire.issue_counters.rebuffer_ms_bucket;
    const terminal = wire.record_flags & (1 << RecordFlag.TERMINAL);
    recHtml = `<div class="rec">
      <div><div class="eyebrow" style="margin-bottom:6px">ExperienceMinute · ${hhmm(ts(S.minute))}</div><pre>${esc(JSON.stringify(show, null, 2))}</pre>
        <p class="note">Measured exactly on the device: ${debug ? `${(debug.active_ms / 1000).toFixed(3)} s active, ${debug.rebuffer_ms.toLocaleString()} ms rebuffering` : ""}${rb !== NO_BUCKET ? `, sent as bucket ${rb} (${ms(rungLowerMs(rb))}–${ms(rungUpperMs(rb))})` : ""}. Exact values stay on the device; buckets merge in the cube by summing.</p></div>
      <div><div class="eyebrow" style="margin-bottom:6px">On the wire · ${bytes.length} bytes ${ok ? `<span class="tag good">round-trips</span>` : `<span class="tag crit">decode mismatch</span>`}</div>
        <div class="bytes">${byteSpans}</div>
        <div class="bytelegend">${legend}</div>
        <p class="note">Identifiers and policy versions travel once in the batch header, not on each record. ${terminal ? "Terminal record: flushed immediately on abnormal termination rather than waiting for the slot." : `Sealed at ${hhmm(ts(S.minute) + MIN)}:00, uploaded at ${hhmmss(ts(S.minute) + MIN + p.uploadS * 1000)}. The slot comes from a hash of the playback id alone, so no cohort uploads together.`}</p>
        <p class="note mono" style="font-size:11px">${esc(toHex(bytes))}</p></div>
    </div>`;
  }
  $("inspector").innerHTML = `<div class="cols" style="grid-template-columns:minmax(0,1fr) minmax(0,1.6fr)"><div>${ctxDl}</div><div><div class="eyebrow">Every minute of this playback</div><div class="strip" id="strip">${strip}</div></div></div>${recHtml}`;
}

/* ═══════════════════════ footer ══════════════════════════════ */
function renderFooter() {
  const { list, ms: t } = samplePlaybacks();
  const nMin = list.reduce((s, p) => s + p.minutes.size, 0);
  $("foot").innerHTML = `Scenario data, not measurements. The grid's ${list.length} playbacks and ${nMin.toLocaleString()} minute records were compiled in this page by @observa/core (${Math.round(t)} ms). The cubes are generated at population scale. The figures in the spec are planning arithmetic until the shadow phase measures them.`;
}

/* ═══════════════════════ render loop and events ══════════════ */
let pending = false;
function render() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    renderHeader();
    renderFilter();
    renderIncidents();
    renderGrid();
    renderHeadline();
    renderAttribution();
    renderAligned();
    renderTests();
    renderCompleteness();
    renderInspector();
  });
}

function setNow(t) {
  S.now = Math.max(MIN_NOW, Math.min(MAX_NOW, t));
  render();
}

function selectCohort(key) {
  S.cohortKey = key;
  S.filter = Object.fromEntries(key.split("&").map((p) => p.split("=")));
  render();
}

function bind() {
  const sc = $("scrub");
  sc.min = "0";
  sc.max = String((MAX_NOW - MIN_NOW) / 1000);
  sc.step = "1";
  sc.addEventListener("input", () => setNow(MIN_NOW + Number(sc.value) * 1000));
  $("reset").addEventListener("click", () => { stop(); setNow(DEFAULT_NOW); });
  $("play").addEventListener("click", () => (S.playing ? stop() : play()));
  $("lane-content").addEventListener("click", () => { S.lane = "content"; render(); });
  $("lane-ads").addEventListener("click", () => { S.lane = "ads"; render(); });
  $("win-60").addEventListener("click", () => { S.win = 60; remember(); render(); });
  $("win-120").addEventListener("click", () => { S.win = 120; remember(); render(); });

  $("filterbar").addEventListener("click", (e) => {
    const drop = e.target.closest("[data-drop]");
    if (drop) { delete S.filter[drop.dataset.drop]; S.cohortKey = keyOf(S.filter) || null; render(); }
    if (e.target.id === "clear-filter") { S.filter = {}; S.cohortKey = null; S.incident = null; render(); }
  });
  $("incidents").addEventListener("click", (e) => {
    const b = e.target.closest("[data-inc]");
    if (!b) return;
    const inc = INCIDENTS.find((x) => x.id === b.dataset.inc);
    S.incident = inc.id;
    S.lane = inc.lane === "ads" ? "ads" : "content";
    // A resolved incident is shown as it was when it fired; the reset button returns to now.
    if (b.dataset.state === "resolved") { stop(); S.now = inc.firedAt; }
    selectCohort(keyOf(inc.cohort));
  });
  for (const id of ["attr", "within"]) {
    $(id).addEventListener("click", (e) => {
      const tr = e.target.closest("[data-cohort]");
      if (tr) selectCohort(tr.dataset.cohort);
    });
  }
  $("align").addEventListener("click", (e) => {
    const tr = e.target.closest("[data-minute]");
    if (!tr) return;
    const i = Number(tr.dataset.minute);
    const p = samplePlaybacks().list.find((x) => x.id === S.playback);
    if (p && p.minutes.has(i)) { S.minute = i; render(); $("inspector-panel").scrollIntoView({ behavior: "smooth", block: "start" }); }
  });

  const cv = $("grid");
  $("gridwrap").addEventListener("scroll", (e) => {
    const w = e.currentTarget;
    GRID.pinnedBack = w.scrollLeft + w.clientWidth < w.scrollWidth - 4;
  }, { passive: true });
  cv.addEventListener("mousemove", gridTip);
  cv.addEventListener("mouseleave", () => ($("tip").hidden = true));
  cv.addEventListener("click", (e) => {
    const hit = gridHit(e);
    if (!hit) return;
    S.playback = hit.p.id;
    S.minute = hit.p.minutes.has(hit.i) ? hit.i : null;
    render();
  });
  for (const id of ["chart-rate", "chart-secs"]) {
    $(id).addEventListener("mousemove", chartTip);
    $(id).addEventListener("mouseleave", () => ($("tip").hidden = true));
  }
  $("inspector").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pm]");
    if (b) { S.minute = Number(b.dataset.pm); render(); }
  });
  let rt = null;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });
}

function play() {
  if (S.now >= MAX_NOW) S.now = MIN_NOW + 40 * 60_000;
  S.playing = setInterval(() => {
    if (S.now >= MAX_NOW) { stop(); return; }
    setNow(S.now + 4000);
  }, 100);
  render();
}
function stop() {
  if (S.playing) clearInterval(S.playing);
  S.playing = null;
  render();
}

bind();
render();
