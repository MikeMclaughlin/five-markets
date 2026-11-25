(() => {
  "use strict";
  const DATA_URL = "data/markets.json";
  const LS_ON = "fm.autoUpdate", LS_PERIOD = "fm.period", LS_CUSTOM = "fm.customMinutes", LS_VIEW = "fm.view";
  let VIEW = "price", lastMs = null, lastDom = null;
  // Settings store (v1.12.1): stable keys (never tied to build/version), every access guarded, and an
  // in-memory copy so the page keeps working (and remembers within the visit) if storage is blocked or full.
  const store = (() => {
    const mem = {};
    let ls = null;
    try { ls = window.localStorage; const k = "fm.__t"; ls.setItem(k, "1"); ls.removeItem(k); } catch (_) { ls = null; }
    return {
      get(k) { if (k in mem) return mem[k]; try { return ls ? ls.getItem(k) : null; } catch (_) { return null; } },
      set(k, v) { mem[k] = String(v); try { if (ls) ls.setItem(k, String(v)); } catch (_) {} },
    };
  })();
  const LS_COLLAPSED = "fm.collapsed";
  const collapsed = new Set();
  try { (JSON.parse(store.get(LS_COLLAPSED) || "[]") || []).forEach((id) => typeof id === "string" && collapsed.add(id)); } catch (_) {}
  if (store.get(LS_VIEW) === "pct") VIEW = "pct";
  const ORDER = ["stocks", "qqq", "tnx", "bonds", "dollar", "gold"];
  const PLACEHOLDER = [
    ["Stocks", "S&P 500 Equal Weight"], ["QQQ", "Invesco QQQ (Nasdaq-100)"], ["10-Year Yield", "US Treasury yield"],
    ["Bonds", "30-Year Treasury bond futures"], ["US Dollar", "Dollar index"], ["Gold", "Gold futures"]];
  const COLORS = { bullish: "#2ee6a0", bearish: "#ff4d6a", mixed: "#ff8a2b" };
  const NS = "http://www.w3.org/2000/svg";

  const $ = (id) => document.getElementById(id);
  const panelsEl = $("panels"), statusEl = $("status"), toggle = $("autoToggle"),
        sel = $("periodSelect"), custom = $("customMinutes"), btn = $("refreshBtn");

  let data = null, timer = null, inflight = null;

  // ---------- formatting ----------
  const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric",
    year: "numeric", hour: "numeric", minute: "2-digit" });
  const etTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const fmtNum = (v, d, unit) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) + (unit || "");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const toT = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

  // ---------- placeholders (first load only) ----------
  function renderSkeleton() {
    panelsEl.innerHTML = PLACEHOLDER.map(([n, s]) => `
      <article class="card skeleton"><div class="info"><div class="name">${n}</div><div class="sub">${s}</div>
      <div class="vals"><span>Last</span><b>—</b><span>150 SMA</span><b>—</b></div></div>
      <div class="chart"><div class="shimmer"></div></div></article>`).join("");
  }

  // ---------- chart drawing ----------
  // Shared trading-day axis (v1.9): the union of all panels' trading dates, one slot per day,
  // so weekends never take space and price line, % bars, volume bars and month labels all align.
  function domain(markets) {
    const set = new Set();
    markets.forEach((m) => m.dates.forEach((d) => set.add(toT(d))));
    const ts = [...set].sort((a, b) => a - b);
    return { ts, N: ts.length };
  }
  function xScale(dom, W) {
    const a = dom.ts, N = Math.max(dom.N, 1);
    return (t) => {
      let pos;
      if (t <= a[0]) pos = 0;
      else if (t >= a[N - 1]) pos = N - 1;
      else {
        let lo = 0, hi = N - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid] <= t) lo = mid; else hi = mid; }
        pos = a[lo] === t ? lo : lo + (t - a[lo]) / (a[hi] - a[lo]);
      }
      return ((pos + 0.5) / N) * W;
    };
  }

  // Flush bar edges (v1.11): each trading day owns exactly one slot of width W/N; bars span the whole
  // slot, snapped to whole pixels so neighbours share an edge (no hairline gaps, no overlaps).
  function slotEdges(x, t, W, N) {
    const slot = W / Math.max(N, 1), k = Math.round(x(t) / slot - 0.5); // slot index, immune to float noise
    const l = Math.round(k * slot), r = Math.round((k + 1) * slot);
    return [l, Math.max(1, r - l)];
  }

  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function smoothPath(pts) {
    // Catmull-Rom -> cubic Bezier for a smooth SMA line
    if (pts.length < 3) return "M" + pts.map((p) => p.join(",")).join("L");
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  }

  // first trading day of every 2nd month (Jan, Mar, May...), every 3rd on phones (Jan, Apr, Jul, Oct) so the
  // 18-month axis (v1.12) stays readable
  function monthTicks(dom) {
    const step = window.matchMedia("(max-width:760px)").matches ? 3 : 2, out = [];
    dom.ts.forEach((t, i) => {
      const mo = new Date(t).getUTCMonth();
      if (i > 0 && mo !== new Date(dom.ts[i - 1]).getUTCMonth() && mo % step === 0) out.push(t);
    });
    return out;
  }

  function drawChart(svg, m, dom) {
    const W = Math.max(svg.clientWidth || svg.parentNode.clientWidth, 120);
    const H = Math.max(svg.clientHeight, 110);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";
    const top = window.matchMedia("(max-width:760px)").matches ? 10 : 50;
    const STRIP = Math.round(Math.min(64, Math.max(46, H * 0.27))), GAP = 14;
    const bot = STRIP + GAP;
    const vals = m.close.concat(m.sma150);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const x = xScale(dom, W);
    const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bot);
    if (VIEW === "pct") return drawPct(svg, m, dom, x, W, H, top, bot, STRIP);
    const color = COLORS[m.trend] || COLORS.mixed;
    const fid = "glow-" + m.id;
    const defs = el("defs", {}, svg);
    const f = el("filter", { id: fid, x: "-5%", y: "-30%", width: "110%", height: "160%" }, defs);
    el("feGaussianBlur", { stdDeviation: "4" }, f);

    const g = el("g", { class: "grid" }, svg);
    monthTicks(dom).forEach((t) => el("line", { x1: x(t), x2: x(t), y1: 0, y2: H }, g));

    const ts = m.dates.map(toT);
    const pricePts = ts.map((t, i) => [x(t), y(m.close[i])]);
    const pd = "M" + pricePts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L");
    el("path", { d: pd, fill: "none", stroke: color, "stroke-width": 6, opacity: 0.55, filter: `url(#${fid})`, "stroke-linejoin": "round" }, svg);
    el("path", { d: pd, fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linejoin": "round" }, svg);

    const smaPts = ts.map((t, i) => [x(t), y(m.sma150[i])]);
    const sd = smoothPath(smaPts);
    el("path", { d: sd, fill: "none", stroke: "#ffe600", "stroke-width": 7, opacity: 0.35, filter: `url(#${fid})` }, svg);
    el("path", { d: sd, fill: "none", stroke: "#ffe600", "stroke-width": 3.4, "stroke-linecap": "round" }, svg);

    // label the gold line
    const lp = smaPts[Math.floor(smaPts.length * 0.06)];
    const lbl = el("text", { x: lp[0] + 4, y: lp[1] < top + 16 ? lp[1] + 16 : lp[1] - 7, class: "sma-label" }, svg);
    lbl.textContent = "150 SMA";

    const lastP = pricePts[pricePts.length - 1];
    el("circle", { cx: lastP[0], cy: lastP[1], r: 3.5, fill: color }, svg);

    drawVolume(svg, m.volume, x, H - STRIP, STRIP, W, dom.N);
  }

  // ---------- % from 150 SMA histogram (v1.9) ----------
  function niceStep(range) {
    const raw = range / 5, p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / p;
    return (f <= 1.5 ? 1 : f <= 3 ? 2 : f <= 7 ? 5 : 10) * p;
  }
  function drawPct(svg, m, dom, x, W, H, top, bot, STRIP) {
    const pct = m.close.map((c, i) => (c / m.sma150[i] - 1) * 100);
    let lo = Math.min(0, ...pct), hi = Math.max(0, ...pct);
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bot);
    const g = el("g", { class: "grid" }, svg);
    monthTicks(dom).forEach((t) => el("line", { x1: x(t), x2: x(t), y1: 0, y2: H }, g));
    const step = niceStep(hi - lo);
    const yl = el("g", { class: "pct-axis" }, svg);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      if (Math.abs(v) < 1e-9) continue;
      el("line", { x1: 0, x2: W, y1: y(v), y2: y(v), class: "pct-grid" }, yl);
      const tx = el("text", { x: 3, y: y(v) - 3, class: "pct-tick" }, yl);
      tx.textContent = (v > 0 ? "+" : "−") + (+Math.abs(v).toFixed(2)) + "%";
    }
    const ts = m.dates.map(toT);
    const y0 = y(0);
    const bars = el("g", { class: "pct-bars", "shape-rendering": "crispEdges" }, svg);
    pct.forEach((v, i) => {
      const yy = y(v), h = Math.max(0.8, Math.abs(yy - y0));
      const [bx, bw] = slotEdges(x, ts[i], W, dom.N);
      el("rect", { x: bx, y: (v >= 0 ? y0 - h : y0).toFixed(1), width: bw, height: h.toFixed(1),
        class: v >= 0 ? "pct-up" : "pct-down" }, bars);
    });
    el("line", { x1: 0, x2: W, y1: y0, y2: y0, class: "pct-zero" }, svg);
    const zl = el("text", { x: 3, y: y0 + (y0 > H - bot - 14 ? -5 : 13), class: "pct-zero-label" }, svg);
    zl.textContent = "0% = 150 SMA";
    // hover / tap tooltip: date and %
    const guide = el("line", { x1: 0, x2: 0, y1: top - 6, y2: H - bot, class: "pct-guide", visibility: "hidden" }, svg);
    const xs = ts.map((t) => x(t));
    const wrap = svg.parentNode;
    let tip = wrap.querySelector(".tip");
    if (!tip) { tip = document.createElement("div"); tip.className = "tip"; wrap.appendChild(tip); }
    tip.hidden = true;
    const show = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      let lo2 = 0, hi2 = xs.length - 1;
      while (hi2 - lo2 > 1) { const mid = (lo2 + hi2) >> 1; if (xs[mid] <= px) lo2 = mid; else hi2 = mid; }
      const i = Math.abs(xs[lo2] - px) <= Math.abs(xs[hi2] - px) ? lo2 : hi2;
      guide.setAttribute("x1", xs[i]); guide.setAttribute("x2", xs[i]); guide.setAttribute("visibility", "visible");
      const v = pct[i];
      tip.innerHTML = `<span>${esc(new Date(ts[i]).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }))}</span>` +
        `<b class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%</b>`;
      tip.hidden = false;
      const pr = (tip.offsetParent || wrap).getBoundingClientRect();
      const left = r.left - pr.left + (xs[i] / W) * r.width;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(left - tw / 2, 4), pr.width - tw - 4) + "px";
      tip.style.top = (r.top - pr.top + (Math.min(y(v), y0) / H) * r.height - tip.offsetHeight - 8) + "px";
    };
    let hideTimer = null;
    const hide = () => { guide.setAttribute("visibility", "hidden"); tip.hidden = true; };
    svg.addEventListener("pointermove", (ev) => { if (ev.pointerType === "mouse") show(ev); });
    svg.addEventListener("pointerdown", (ev) => { show(ev); clearTimeout(hideTimer); if (ev.pointerType !== "mouse") hideTimer = setTimeout(hide, 3500); });
    svg.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") hide(); });
    drawVolume(svg, m.volume, x, H - STRIP, STRIP, W, dom.N);
  }

  // ---------- dollar volume strip ----------
  function fmtUsd(v) {
    const a = Math.abs(v);
    if (a >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B";
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + Math.round(v);
  }
  function drawVolume(svg, vol, x, y0, h, W, N) {
    const g = el("g", { class: "dv" }, svg);
    el("line", { x1: 0, x2: W, y1: y0 - 6, y2: y0 - 6, class: "dv-sep" }, g);
    const lab = el("text", { x: 2, y: y0 + 6, class: "dv-label" }, g);
    if (!vol || !vol.dv || !vol.dv.length) {
      lab.textContent = "Dollar Volume · No volume data";
      return;
    }
    const ts = vol.dates.map(toT);
    const max = Math.max(...vol.dv, ...vol.avg50.filter((v) => v != null)) || 1;
    const yb = y0 + h;
    const bars = el("g", { "shape-rendering": "crispEdges" }, g);
    vol.dv.forEach((v, i) => {
      const [bx, bw] = slotEdges(x, ts[i], W, N);
      if (!(v > 0)) { // the source reported no volume that day: a dim marker, not a silent hole
        const r = el("rect", { x: bx, y: (yb - 4).toFixed(1), width: bw, height: 4, class: "dv-none" }, bars);
        el("title", {}, r).textContent = vol.dates[i] + ": no volume reported";
        return;
      }
      const bh = Math.max(1, (v / max) * (h - 12));
      el("rect", { x: bx, y: (yb - bh).toFixed(1), width: bw, height: bh.toFixed(1),
        class: vol.up[i] ? "dv-up" : "dv-down" }, bars);
    });
    const ap = vol.avg50.map((v, i) => v == null ? null : [x(ts[i]).toFixed(1), (yb - (v / max) * (h - 12)).toFixed(1)]).filter(Boolean);
    if (ap.length > 1) el("path", { d: "M" + ap.map((p) => p.join(",")).join("L"), class: "dv-avg" }, g);
    const d = vol.lastDate;
    const md = new Date(toT(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    lab.innerHTML = `<tspan class="dv-title">Dollar Volume</tspan><tspan class="dv-val" dx="6">${fmtUsd(vol.last)}</tspan>` +
      (W < 560
        ? `<tspan class="dv-note" dx="6">${esc(md)}${vol.partial ? " (partial)" : ""} · ${esc(vol.kind === "futures" ? vol.symbol.replace("=F", "") + " futures" : vol.note)}</tspan>`
        : `<tspan class="dv-note" dx="6">${esc(md)}${vol.partial ? " (partial day)" : ""} · 50d avg ${fmtUsd(vol.avg50[vol.avg50.length - 1] || 0)} · ${esc(vol.note)}</tspan>`);
  }

  function drawAxis(dom) {
    const svg = $("axis");
    const W = Math.max(svg.clientWidth, 120), H = 24;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const ticks = monthTicks(dom), x = xScale(dom, W);
    const W0 = ticks.length ? x(ticks[0]) : W;
    if (W0 > 40) { const s0 = el("text", { x: 0, y: 16, "text-anchor": "start" }, svg); const d0 = new Date(dom.ts[0]); s0.textContent = names[d0.getUTCMonth()] + " \u2019" + String(d0.getUTCFullYear()).slice(2); }
    ticks.forEach((t) => {
      const xx = x(t);
      const tx = el("text", { x: xx, y: 16, "text-anchor": xx < 14 ? "start" : xx > W - 14 ? "end" : "middle" }, svg);
      const d = new Date(t); // January carries the year so the two Novembers etc. can't be confused
      tx.textContent = names[d.getUTCMonth()] + (d.getUTCMonth() === 0 ? " \u2019" + String(d.getUTCFullYear()).slice(2) : "");
    });
  }

  function render() {
    if (!data) return;
    const ms = ORDER.map((id) => data.markets.find((m) => m.id === id)).filter(Boolean);
    const dom = domain(ms);
    // Build new DOM off-screen, then swap in one step so nothing blanks.
    const laggers = findLaggers(ms, Date.parse(data.generatedAt));
    const frag = document.createDocumentFragment();
    ms.forEach((m) => {
      const card = document.createElement("article");
      card.className = "card " + (m.above ? "p-above" : "p-below") + (collapsed.has(m.id) ? " collapsed" : "");
      card.dataset.id = m.id;
      const pv = (m.last / m.smaLast - 1) * 100;
      const pct = (pv >= 0 ? "+" : "−") + Math.abs(pv).toFixed(1) + "%";
      card.innerHTML = `
        <div class="info">
          <div class="head" role="button" tabindex="0" aria-expanded="${!collapsed.has(m.id)}" aria-controls="chart-${m.id}" data-panel="${m.id}"><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg><span class="name">${esc(m.name)}</span>
            <span class="pill mini ${m.above ? "up" : "down"}">${m.above ? "Above" : "Below"} 150 SMA<span class="pct">${pct}</span></span></div>
          <div class="sub">${esc(m.subtitle)} · ${esc(m.symbol)}</div>
          ${laggers[m.id] ? `<span class="lag">Last bar ${esc(laggers[m.id])} · lags other markets</span>` : ""}
          <div class="vals"><span>Last</span><b>${fmtNum(m.last, m.decimals, m.unit)}</b>
            <span>150 SMA</span><b class="s">${fmtNum(m.smaLast, m.decimals, m.unit)}</b></div>
        </div>
        <div class="chart" id="chart-${m.id}">
          <span class="pill ${m.above ? "up" : "down"}">${m.above ? "Above" : "Below"} 150 SMA<span class="pct">${pct}</span></span>
          <span class="trend ${m.trend}">${m.trend} · SMA ${m.smaSlope}</span>
          <svg role="img" aria-label="${esc(m.name)} daily close and 150-day SMA"></svg>
        </div>`;
      frag.appendChild(card);
    });
    panelsEl.replaceChildren(frag);
    renderOutlook(Object.fromEntries(ms.map((m) => [m.id, m])));
    lastMs = ms; lastDom = dom;
    // collapsed panels are drawn when expanded (so their charts get the right size)
    panelsEl.querySelectorAll(".card").forEach((c, i) => { if (!c.classList.contains("collapsed")) drawChart(c.querySelector(".chart svg"), ms[i], dom); });
    drawAxis(dom);
    syncAllCollapsed();
    $("lastUpdated").textContent = etFmt.format(new Date(data.generatedAt)) + " ET";
    renderAsOf();
  }

  // ---------- data age / staleness ----------
  // Uses the generatedAt timestamp written by the fetch job (never the page-load time).
  // Rule: regular session = Mon–Fri 9:30 AM–4:00 PM ET. During the session, data older than
  // 4.5 hours (270 min) is STALE. Outside the session (evenings, pre-market, weekends) data is fine as long
  // as it was fetched after the most recent session close (with the same 4.5-hour grace right
  // after the close). More than 2 hours past the threshold = severe (red), otherwise amber.
  const STALE_MIN = 270, SEVERE_MIN = 120, DAY = 86400000;
  const etPartsFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function etWall(ms) { // ET wall-clock time encoded as a UTC timestamp
    const p = Object.fromEntries(etPartsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  }
  const isWeekday = (w) => { const d = new Date(w).getUTCDay(); return d >= 1 && d <= 5; };
  const minsOfDay = (w) => (w % DAY) / 60000;
  function lastClose(w) { // most recent 4:00 PM ET weekday close at or before wall time w
    let c = w - (w % DAY) + 960 * 60000;
    if (!isWeekday(w) || minsOfDay(w) < 960) { do { c -= DAY; } while (!isWeekday(c)); }
    return c;
  }
  function staleness(genMs, nowMs) {
    const w = etWall(nowMs), g = etWall(genMs);
    const inSession = isWeekday(w) && minsOfDay(w) >= 570 && minsOfDay(w) < 960;
    const threshold = inSession ? w - STALE_MIN * 60000 : Math.min(lastClose(w), w - STALE_MIN * 60000);
    const behind = (threshold - g) / 60000;
    return { stale: behind > 0, severe: behind > SEVERE_MIN, inSession, ageMin: Math.max(0, (nowMs - genMs) / 60000) };
  }
  function fmtAge(min) {
    if (min < 60) return Math.round(min) + "m";
    if (min < 48 * 60) return Math.floor(min / 60) + "h " + Math.round(min % 60) + "m";
    return Math.round(min / 1440) + "d";
  }
  function sessionDate(w) { // trading date the data should cover at wall time w
    let d = w - (w % DAY);
    if (!isWeekday(w) || minsOfDay(w) < 570) { do { d -= DAY; } while (!isWeekday(d)); }
    return new Date(d).toISOString().slice(0, 10);
  }
  function findLaggers(ms, genMs) {
    const out = {}, newest = ms.reduce((a, m) => (m.lastDate > a ? m.lastDate : a), "");
    const expect = sessionDate(etWall(genMs));
    ms.forEach((m) => {
      if (m.lastDate < newest && m.lastDate < expect)
        out[m.id] = new Date(toT(m.lastDate)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    });
    return out;
  }
  function renderAsOf() {
    if (!data) return;
    const gen = Date.parse(data.generatedAt), now = Date.now(), el2 = $("asOf");
    const sameDay = etWall(gen) - (etWall(gen) % DAY) === etWall(now) - (etWall(now) % DAY);
    const when = sameDay ? etTime.format(new Date(gen)) : etFmt.format(new Date(gen));
    const st = staleness(gen, now);
    el2.className = "asof" + (st.stale ? (st.severe ? " stale severe" : " stale") : "");
    el2.innerHTML = `Data as of ${esc(when)} ET` + (st.stale ? ` <span class="stale-tag">STALE · ${fmtAge(st.ageMin)} old</span>` : "");
    el2.title = st.stale
      ? (st.inSession ? "Market is open and this data is more than 4.5 hours old." : "No data fetched since the last market close.")
      : "When the data file was generated by the fetch job.";
  }
  setInterval(renderAsOf, 60000);

  // ---------- self-update: reload when a new build is deployed ----------
  // The deploy stamps a build id into index.html (<meta name="build">, ?v= on app.js/style.css)
  // and writes version.json. If the deployed build differs from the one running, navigate to a
  // fresh URL (bypasses the 10-minute HTML cache). Current content stays on screen until the new
  // page loads. sessionStorage guard: at most one reload attempt per target build (no loops).
  const BUILD = (document.querySelector('meta[name="build"]') || {}).content || "";
  const RELOAD_KEY = "fm.reloadedFor";
  if (/[?&]b=/.test(location.search)) { // tidy the cache-busting param after a self-update
    try { history.replaceState(null, "", location.pathname + location.hash); } catch (_) {}
  }
  let versionInflight = false;
  function checkVersion() {
    if (!BUILD || BUILD.startsWith("__") || versionInflight) return; // unstamped local dev copy
    versionInflight = true;
    fetch(`version.json?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (!v || !v.build || v.build === BUILD) { sessionStorage.removeItem(RELOAD_KEY); return; }
        if (sessionStorage.getItem(RELOAD_KEY) === v.build) return; // already tried once for this build
        sessionStorage.setItem(RELOAD_KEY, v.build);
        location.replace(location.pathname + "?b=" + encodeURIComponent(v.build) + location.hash);
      })
      .catch(() => {})
      .finally(() => { versionInflight = false; });
  }
  setInterval(checkVersion, 60000);

  // ---------- market outlook (rule-based, from the equity market's point of view) ----------
  // sign: +1 means "bullish trend in this market is good for stocks", -1 means it is bad.
  const RULES = {
    stocks: { w: 2, sign: +1, label: "Stocks" },
    qqq: { w: 1, sign: +1, label: "QQQ" },
    tnx: { w: 1, sign: -1, label: "10Y Yield" },
    bonds: { w: 1, sign: +1, label: "Bonds" },
    dollar: { w: 1, sign: -1, label: "Dollar" },
    gold: { w: 0.5, sign: -1, label: "Gold" },
  };
  const PHRASE = {
    tnx: { bullish: "rising yields", bearish: "falling yields" },
    bonds: { bullish: "rallying bonds", bearish: "falling bonds" },
    dollar: { bullish: "a strong dollar", bearish: "a weakening dollar" },
    gold: { bullish: "rising gold (a fear and inflation hedge)", bearish: "fading gold (less fear)" },
  };
  const LEVELS = [
    { min: 3.5, cls: "lvl-strong-tail", name: "Strong Tailwind", phrase: "a strong tailwind" },
    { min: 1, cls: "lvl-tail", name: "Tailwind", phrase: "a tailwind" },
    { min: -0.5, cls: "lvl-neutral", name: "Neutral – Choppy", phrase: "a mixed, choppy backdrop" },
    { min: -3, cls: "lvl-head", name: "Headwind", phrase: "a headwind" },
    { min: -Infinity, cls: "lvl-strong-head", name: "Strong Headwind", phrase: "a strong headwind" },
  ];
  const listJoin = (a) => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const fmtScore = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toString();

  function computeOutlook(byId) {
    let total = 0; const chips = [], heads = [], tails = [];
    Object.keys(RULES).forEach((id) => {
      const m = byId[id], r = RULES[id];
      if (!m) return;
      const dir = m.trend === "bullish" ? 1 : m.trend === "bearish" ? -1 : 0;
      const pts = dir * r.sign * r.w;
      total += pts;
      chips.push({ id, label: r.label, trend: m.trend, pts });
      if (PHRASE[id] && dir) (pts > 0 ? tails : heads).push(PHRASE[id][m.trend]);
    });
    total = Math.round(total * 2) / 2;
    const lvl = LEVELS.find((l) => total >= l.min);
    const s = byId.stocks;
    let s1;
    if (!s) s1 = "Stock trend unavailable";
    else if (s.trend === "bullish") s1 = "Stocks are in a confirmed uptrend, above a rising 150 SMA";
    else if (s.trend === "bearish") s1 = "Stocks are in a confirmed downtrend, below a falling 150 SMA";
    else if (s.above) s1 = "Stocks have climbed back above a still-falling 150 SMA, so their trend is undecided";
    else s1 = "Stocks have slipped below a still-rising 150 SMA, so their trend is undecided";
    const q = byId.qqq;
    if (q) s1 += q.trend === "bullish" ? "; QQQ (Nasdaq-100) is above a rising 150 SMA"
      : q.trend === "bearish" ? "; QQQ (Nasdaq-100) is below a falling 150 SMA"
      : `; QQQ (Nasdaq-100) is mixed, ${q.above ? "above a falling" : "below a rising"} 150 SMA`;
    let s2 = "";
    if (heads.length) s2 = `${listJoin(heads)} ${heads.length > 1 ? "are" : "is"} tightening financial conditions`;
    if (tails.length) s2 += (s2 ? ", while " : "") + `${listJoin(tails)} ${tails.length > 1 ? "are" : "is"} ${heads.length ? "easing them" : "easing financial conditions"}`;
    if (!s2) s2 = "rates, the dollar and gold give no clear signal";
    const text = `${s1}. ${cap(s2)} — net, ${lvl.phrase} for stocks ahead.`;
    return { total, lvl, text, chips };
  }

  function renderOutlook(byId) {
    const o = computeOutlook(byId), box = $("outlook");
    box.className = "outlook " + o.lvl.cls; // (v1.12.1) used to wipe "collapsed" on every render
    box.classList.toggle("collapsed", collapsed.has("outlook"));
    const oh = box.querySelector(".head"); if (oh) oh.setAttribute("aria-expanded", String(!collapsed.has("outlook")));
    $("olHeadline").textContent = o.lvl.name;
    $("olScore").innerHTML = `Score <b>${fmtScore(o.total)}</b> of ±6.5`;
    $("olText").textContent = o.text;
    $("olChips").innerHTML = o.chips.map((c) =>
      `<span class="chip ${c.pts > 0 ? "pos" : c.pts < 0 ? "neg" : "zero"}">${c.label} <span class="st">${c.id === "tnx" && c.trend !== "mixed" ? (c.trend === "bullish" ? "rising" : "falling") : c.trend}</span> <b>${fmtScore(c.pts)}</b></span>`).join("");
  }

  // ---------- data loading ----------
  function setStatus(msg, isErr) { statusEl.textContent = msg; statusEl.classList.toggle("err", !!isErr); }

  function load() {
    if (inflight) return inflight;
    btn.disabled = true;
    if (data) setStatus("Refreshing…");
    inflight = fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((j) => {
        if (!j || !Array.isArray(j.markets) || !j.markets.length) throw new Error("bad data");
        data = j; render(); setStatus(statusText()); checkVersion();
      })
      .catch((e) => {
        setStatus(`Couldn't refresh (${e.message}). Showing last good data.`, true);
        if (!data) setStatus(`Couldn't load data (${e.message}). Will retry.`, true);
      })
      .finally(() => { inflight = null; btn.disabled = false; });
    return inflight;
  }

  // ---------- auto-update ----------
  function periodMinutes() {
    if (sel.value === "custom") {
      const v = Math.round(+custom.value);
      return v >= 1 && v <= 1440 ? v : 5;
    }
    return +sel.value;
  }
  function statusText() { return ""; } // v1.7: no page-check or next-update time shown; only "Data as of"
  function schedule() {
    clearInterval(timer); timer = null;
    if (toggle.checked) {
      const ms = periodMinutes() * 60000;
      timer = setInterval(load, ms);
    }
    if (data) setStatus(statusText());
  }
  function save() {
    store.set(LS_ON, toggle.checked ? "1" : "0");
    store.set(LS_PERIOD, sel.value);
    if (custom.value) store.set(LS_CUSTOM, custom.value);
  }

  // restore settings
  try {
    toggle.checked = store.get(LS_ON) === "1";
    const p = store.get(LS_PERIOD);
    if (p && [...sel.options].some((o) => o.value === p)) sel.value = p; else sel.value = "5";
    custom.value = store.get(LS_CUSTOM) || "10";
  } catch (_) { sel.value = "5"; }
  custom.hidden = sel.value !== "custom";

  toggle.addEventListener("change", () => { save(); schedule(); if (toggle.checked) load(); });
  sel.addEventListener("change", () => { custom.hidden = sel.value !== "custom"; save(); schedule(); });
  custom.addEventListener("change", () => { save(); schedule(); });
  btn.addEventListener("click", () => load());
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });

  // chart view toggle (Price / % from SMA); re-render swaps fully built panels, so nothing blanks
  const viewBtns = [...document.querySelectorAll(".seg button[data-view]")];
  function syncView() {
    viewBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === VIEW)));
    document.body.classList.toggle("view-pct", VIEW === "pct");
  }
  viewBtns.forEach((b) => b.addEventListener("click", () => {
    if (VIEW === b.dataset.view) return;
    VIEW = b.dataset.view;
    store.set(LS_VIEW, VIEW);
    syncView(); render();
  }));
  syncView();

  // ---------- collapsible panels (v1.10) ----------
  function syncAllCollapsed() {
    const cards = [...panelsEl.querySelectorAll(".card[data-id]")];
    document.body.classList.toggle("all-collapsed", cards.length > 0 && cards.every(c => c.classList.contains("collapsed")));
  }
  function saveCollapsed() { syncAllCollapsed(); store.set(LS_COLLAPSED, JSON.stringify([...collapsed])); }
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function animateHeight(box, mutate) {
    const h0 = box.offsetHeight; mutate(); const h1 = box.offsetHeight;
    if (reduceMotion || !box.animate || h0 === h1) return;
    box.style.overflow = "hidden";
    const a = box.animate([{ height: h0 + "px" }, { height: h1 + "px" }], { duration: 200, easing: "cubic-bezier(.2,.7,.3,1)" });
    a.onfinish = a.oncancel = () => { box.style.overflow = ""; };
  }
  function setPanel(id, collapse, animate = true) {
    if (collapse) collapsed.add(id); else collapsed.delete(id);
    const box = id === "outlook" ? $("outlook") : panelsEl.querySelector(`.card[data-id="${id}"]`);
    if (!box) return;
    const apply = () => {
      box.classList.toggle("collapsed", collapse);
      const head = box.querySelector(".head"); if (head) head.setAttribute("aria-expanded", String(!collapse));
      if (!collapse && id !== "outlook" && lastMs) {
        const m = lastMs.find((x) => x.id === id);
        if (m) drawChart(box.querySelector(".chart svg"), m, lastDom);
      }
    };
    animate ? animateHeight(box, apply) : apply();
  }
  function togglePanel(id) { setPanel(id, !collapsed.has(id)); saveCollapsed(); }
  document.addEventListener("click", (ev) => {
    const head = ev.target.closest(".head[data-panel]");
    if (head) { togglePanel(head.dataset.panel); return; }
    const bulk = ev.target.closest("[data-bulk]");
    if (bulk) {
      const c = bulk.dataset.bulk === "collapse";
      ["outlook", ...ORDER].forEach((id) => setPanel(id, c));
      saveCollapsed();
    }
  });
  document.addEventListener("keydown", (ev) => {
    const head = ev.target.closest && ev.target.closest(".head[data-panel]");
    if (head && (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar")) { ev.preventDefault(); togglePanel(head.dataset.panel); }
  });
  if (collapsed.has("outlook")) setPanel("outlook", true, false);

  // ---------- pinned top bar: compact title appears once the big title scrolls away ----------
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => document.body.classList.toggle("scrolled", !e.isIntersecting), { threshold: 0 })
      .observe(document.querySelector("h1"));
  }

  renderSkeleton();
  load().then(schedule);
})();
