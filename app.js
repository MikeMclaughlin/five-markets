(() => {
  "use strict";
  const DATA_URL = "data/markets.json";
  const LS_ON = "fm.autoUpdate", LS_PERIOD = "fm.period", LS_CUSTOM = "fm.customMinutes";
  const ORDER = ["stocks", "tnx", "bonds", "dollar", "gold"];
  const PLACEHOLDER = [
    ["Stocks", "S&P 500 Equal Weight"], ["10-Year Yield", "US Treasury yield"],
    ["Bonds", "30-Year Treasury bond futures"], ["US Dollar", "Dollar index"], ["Gold", "Gold futures"]];
  const COLORS = { bullish: "#2ee6a0", bearish: "#ff4d6a", mixed: "#ff8a2b" };
  const NS = "http://www.w3.org/2000/svg";

  const $ = (id) => document.getElementById(id);
  const panelsEl = $("panels"), statusEl = $("status"), toggle = $("autoToggle"),
        sel = $("periodSelect"), custom = $("customMinutes"), btn = $("refreshBtn");

  let data = null, timer = null, inflight = null, nextAt = null;

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
  function domain(markets) {
    let lo = Infinity, hi = -Infinity;
    markets.forEach((m) => { lo = Math.min(lo, toT(m.dates[0])); hi = Math.max(hi, toT(m.dates[m.dates.length - 1])); });
    return [lo, hi];
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

  function monthTicks(t0, t1) {
    const out = []; const d = new Date(t0);
    let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (m % 2 === 1) m++; // Jan, Mar, May, Jul, Sep, Nov
    for (;;) {
      if (m > 11) { y += Math.floor(m / 12); m = m % 12; }
      const t = Date.UTC(y, m, 1);
      if (t > t1) break;
      out.push(t); m += 2;
    }
    return out;
  }

  function drawChart(svg, m, dom) {
    const W = Math.max(svg.clientWidth || svg.parentNode.clientWidth, 120);
    const H = Math.max(svg.clientHeight, 110);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";
    const top = window.matchMedia("(max-width:760px)").matches ? 10 : 50, bot = 10;
    const vals = m.close.concat(m.sma150);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const x = (t) => ((t - dom[0]) / (dom[1] - dom[0])) * W;
    const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bot);
    const color = COLORS[m.trend] || COLORS.mixed;
    const fid = "glow-" + m.id;
    const defs = el("defs", {}, svg);
    const f = el("filter", { id: fid, x: "-5%", y: "-30%", width: "110%", height: "160%" }, defs);
    el("feGaussianBlur", { stdDeviation: "4" }, f);

    const g = el("g", { class: "grid" }, svg);
    monthTicks(dom[0], dom[1]).forEach((t) => el("line", { x1: x(t), x2: x(t), y1: 0, y2: H }, g));

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
  }

  function drawAxis(dom) {
    const svg = $("axis");
    const W = Math.max(svg.clientWidth, 120), H = 24;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const ticks = monthTicks(dom[0], dom[1]);
    const W0 = ((ticks[0] - dom[0]) / (dom[1] - dom[0])) * W;
    if (W0 > 40) { const s0 = el("text", { x: 0, y: 16, "text-anchor": "start" }, svg); s0.textContent = names[new Date(dom[0]).getUTCMonth()]; }
    ticks.forEach((t) => {
      const xx = ((t - dom[0]) / (dom[1] - dom[0])) * W;
      const tx = el("text", { x: xx, y: 16, "text-anchor": xx < 14 ? "start" : xx > W - 14 ? "end" : "middle" }, svg);
      tx.textContent = names[new Date(t).getUTCMonth()];
    });
  }

  function render() {
    if (!data) return;
    const ms = ORDER.map((id) => data.markets.find((m) => m.id === id)).filter(Boolean);
    const dom = domain(ms);
    // Build new DOM off-screen, then swap in one step so nothing blanks.
    const frag = document.createDocumentFragment();
    ms.forEach((m) => {
      const card = document.createElement("article");
      card.className = "card";
      const pct = (m.pctFromSma > 0 ? "+" : "") + m.pctFromSma.toFixed(2) + "%";
      card.innerHTML = `
        <div class="info">
          <div class="name">${esc(m.name)}</div>
          <div class="sub">${esc(m.subtitle)} · ${esc(m.symbol)}</div>
          <div class="vals"><span>Last</span><b>${fmtNum(m.last, m.decimals, m.unit)}</b>
            <span>150 SMA</span><b class="s">${fmtNum(m.smaLast, m.decimals, m.unit)}</b></div>
        </div>
        <div class="chart">
          <span class="pill ${m.above ? "up" : "down"}">${m.above ? "Above" : "Below"} 150 SMA<span class="pct">${pct}</span></span>
          <span class="trend ${m.trend}">${m.trend} · SMA ${m.smaSlope}</span>
          <svg role="img" aria-label="${esc(m.name)} daily close and 150-day SMA"></svg>
        </div>`;
      frag.appendChild(card);
    });
    panelsEl.replaceChildren(frag);
    renderOutlook(Object.fromEntries(ms.map((m) => [m.id, m])));
    panelsEl.querySelectorAll(".card").forEach((c, i) => drawChart(c.querySelector("svg"), ms[i], dom));
    drawAxis(dom);
    $("lastUpdated").textContent = etFmt.format(new Date(data.generatedAt)) + " ET";
  }

  // ---------- market outlook (rule-based, from the equity market's point of view) ----------
  // sign: +1 means "bullish trend in this market is good for stocks", -1 means it is bad.
  const RULES = {
    stocks: { w: 2, sign: +1, label: "Stocks" },
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
    { min: 3, cls: "lvl-strong-tail", name: "Strong Tailwind", phrase: "a strong tailwind" },
    { min: 1, cls: "lvl-tail", name: "Tailwind", phrase: "a tailwind" },
    { min: -0.5, cls: "lvl-neutral", name: "Neutral – Choppy", phrase: "a mixed, choppy backdrop" },
    { min: -2.5, cls: "lvl-head", name: "Headwind", phrase: "a headwind" },
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
    let s2 = "";
    if (heads.length) s2 = `${listJoin(heads)} ${heads.length > 1 ? "are" : "is"} tightening financial conditions`;
    if (tails.length) s2 += (s2 ? ", while " : "") + `${listJoin(tails)} ${tails.length > 1 ? "are" : "is"} ${heads.length ? "easing them" : "easing financial conditions"}`;
    if (!s2) s2 = "rates, the dollar and gold give no clear signal";
    const text = `${s1}. ${cap(s2)} — net, ${lvl.phrase} for stocks ahead.`;
    return { total, lvl, text, chips };
  }

  function renderOutlook(byId) {
    const o = computeOutlook(byId), box = $("outlook");
    box.className = "outlook " + o.lvl.cls;
    $("olHeadline").textContent = o.lvl.name;
    $("olScore").innerHTML = `Score <b>${fmtScore(o.total)}</b> of ±5.5`;
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
        data = j; render(); setStatus(statusText());
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
  function statusText() {
    const now = "Checked " + etTime.format(new Date()) + " ET";
    return toggle.checked && nextAt ? `${now} · next ${etTime.format(nextAt)} ET` : now;
  }
  function schedule() {
    clearInterval(timer); timer = null; nextAt = null;
    if (toggle.checked) {
      const ms = periodMinutes() * 60000;
      nextAt = new Date(Date.now() + ms);
      timer = setInterval(() => { nextAt = new Date(Date.now() + ms); load(); }, ms);
    }
    if (data) setStatus(statusText());
  }
  function save() {
    localStorage.setItem(LS_ON, toggle.checked ? "1" : "0");
    localStorage.setItem(LS_PERIOD, sel.value);
    if (custom.value) localStorage.setItem(LS_CUSTOM, custom.value);
  }

  // restore settings
  try {
    toggle.checked = localStorage.getItem(LS_ON) === "1";
    const p = localStorage.getItem(LS_PERIOD);
    if (p && [...sel.options].some((o) => o.value === p)) sel.value = p; else sel.value = "5";
    custom.value = localStorage.getItem(LS_CUSTOM) || "10";
  } catch (_) { sel.value = "5"; }
  custom.hidden = sel.value !== "custom";

  toggle.addEventListener("change", () => { save(); schedule(); if (toggle.checked) load(); });
  sel.addEventListener("change", () => { custom.hidden = sel.value !== "custom"; save(); schedule(); });
  custom.addEventListener("change", () => { save(); schedule(); });
  btn.addEventListener("click", () => load());
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });

  renderSkeleton();
  load().then(schedule);
})();
