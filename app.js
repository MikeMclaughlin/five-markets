(() => {
  "use strict";
  const DATA_URL = "data/markets.json";
  const LS_ON = "fm.autoUpdate", LS_PERIOD = "fm.period", LS_CUSTOM = "fm.customMinutes";
  const ORDER = ["stocks", "tnx", "bonds", "dollar", "gold"];
  const PLACEHOLDER = [
    ["Stocks", "S&P 500 Equal Weight"], ["10-Year Yield", "US Treasury yield"],
    ["Bonds", "30-Year Treasury bond futures"], ["US Dollar", "Dollar index"], ["Gold", "Gold futures"]];
  const COLORS = { bullish: "#2ee6a0", bearish: "#ff4d6a", mixed: "#e8b04a" };
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
    el("path", { d: sd, fill: "none", stroke: "#f2b731", "stroke-width": 7, opacity: 0.25, filter: `url(#${fid})` }, svg);
    el("path", { d: sd, fill: "none", stroke: "#f5a524", "stroke-width": 3.4, "stroke-linecap": "round" }, svg);

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
    panelsEl.querySelectorAll(".card").forEach((c, i) => drawChart(c.querySelector("svg"), ms[i], dom));
    drawAxis(dom);
    $("lastUpdated").textContent = etFmt.format(new Date(data.generatedAt)) + " ET";
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
