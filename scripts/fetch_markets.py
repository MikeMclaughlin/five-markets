#!/usr/bin/env python3
"""Fetch daily closes from Yahoo Finance's public chart API and write data/markets.json.

For each market we keep ~12 months of visible daily closes plus the 150-day
simple moving average, computed from extra history so the SMA spans the
whole visible window.
"""
import json, os, sys, time, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

SMA_N = 150
VISIBLE_DAYS = 365          # calendar days shown on the chart
SLOPE_LOOKBACK = 10         # trading days used to judge SMA slope

MARKETS = [
    {"id": "stocks", "name": "Stocks", "subtitle": "S&P 500 Equal Weight", "symbol": "^SPXEW", "fallback": "RSP", "decimals": 2, "unit": ""},
    {"id": "qqq", "name": "QQQ", "subtitle": "Invesco QQQ (Nasdaq-100)", "symbol": "QQQ", "decimals": 2, "unit": ""},
    {"id": "tnx", "name": "10-Year Yield", "subtitle": "US Treasury yield", "symbol": "^TNX", "decimals": 3, "unit": "%"},
    {"id": "bonds", "name": "Bonds", "subtitle": "30-Year Treasury bond futures", "symbol": "ZB=F", "decimals": 3, "unit": ""},
    {"id": "dollar", "name": "US Dollar", "subtitle": "Dollar index", "symbol": "DX-Y.NYB", "decimals": 2, "unit": ""},
    {"id": "gold", "name": "Gold", "subtitle": "Gold futures", "symbol": "GC=F", "decimals": 1, "unit": ""},
]


def _day(t, meta):
    """Trading date of a Yahoo bar in the exchange's own time zone, DST-aware (v1.11).
    The old fixed meta.gmtoffset is today's offset; applied to summer bars stamped at 00:00 local
    it pushed them back one calendar day (Mon->Sun ... Fri->Thu), which misaligned those panels."""
    try:
        from zoneinfo import ZoneInfo
        dt = datetime.fromtimestamp(t, tz=ZoneInfo(meta["exchangeTimezoneName"]))
    except Exception:
        dt = datetime.fromtimestamp(t + meta.get("gmtoffset", 0), tz=timezone.utc)
    return dt.strftime("%Y-%m-%d"), dt.hour


def fetch(symbol):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(symbol) + "?range=2y&interval=1d&includePrePost=false")
    last_err = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (five-markets)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                res = json.load(r)["chart"]["result"][0]
            ts = res["timestamp"]
            closes = res["indicators"]["quote"][0]["close"]
            meta = res.get("meta", {})
            pts = {}
            for t, c in zip(ts, closes):
                if c is None:
                    continue
                d, _ = _day(t, meta)
                pts[d] = c  # last value for a date wins (intraday bar for today)
            live = meta.get("regularMarketPrice")
            return sorted(pts.items()), live
        except Exception as e:  # noqa
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{symbol}: {last_err}")


# Dollar volume: real traded volume only. Futures notional = contracts x price x multiplier;
# fall back to an ETF's shares x price when the futures volume is missing or thin.
DV_AVG_N = 50
VOLUME = {
    "stocks": [("RSP", 1, "etf")],
    "tnx": [("ZN=F", 1000, "futures"), ("IEF", 1, "etf")],
    "bonds": [("ZB=F", 1000, "futures"), ("TLT", 1, "etf")],
    "dollar": [("DX=F", 1000, "futures"), ("UUP", 1, "etf")],
    "gold": [("GC=F", 100, "futures"), ("GLD", 1, "etf")],
    "qqq": [("QQQ", 1, "etf")],
}
FUT_NAMES = {"ZN=F": "ZN 10Y note", "ZB=F": "ZB 30Y bond", "DX=F": "DX dollar index", "GC=F": "GC gold"}


def _et_now():
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("America/New_York"))


def fetch_ohlcv(symbol):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(symbol) + "?range=2y&interval=1d&includePrePost=false")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (five-markets)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = (json.load(r).get("chart") or {}).get("result")
    if not res:
        raise RuntimeError(f"{symbol}: no chart data")
    res = res[0]
    meta = res.get("meta", {})
    q = res["indicators"]["quote"][0]
    pts = {}
    for t, c, v in zip(res["timestamp"], q["close"], q["volume"]):
        if c is None:
            continue
        d, hr = _day(t, meta)
        if hr >= 18 and d in pts:
            continue  # evening futures bar = next session's first minutes; keep the completed day
        pts[d] = (c, v or 0)
    return sorted(pts.items())


def build_volume(mid, start_date):
    notes = []
    for sym, mult, kind in VOLUME.get(mid, []):
        try:
            rows = fetch_ohlcv(sym)
        except Exception as e:
            notes.append(f"{sym}: {e}")
            continue
        dates = [d for d, _ in rows]
        closes = [c for _, (c, _) in rows]
        dv = [c * v * mult for _, (c, v) in rows]
        try:
            i0 = next(i for i, d in enumerate(dates) if d >= start_date)
        except StopIteration:
            notes.append(f"{sym}: no recent data")
            continue
        vis = dv[i0:]
        zero = sum(1 for x in vis if x <= 0)
        # roll-week lows on ZN/ZB are real (small) bars, not empty days, so only true zeros count here
        if not vis or zero > 0.1 * len(vis) or vis[-1] <= 0 and vis[-2] <= 0:
            notes.append(f"{sym}: thin/zero volume ({zero}/{len(vis)} empty days)")
            continue
        up, avg = [], []
        for i in range(i0, len(dates)):
            up.append(1 if i > 0 and closes[i] >= closes[i - 1] else 0)
            win = [x for x in dv[max(0, i - DV_AVG_N + 1):i + 1] if x > 0]
            avg.append(round(sum(win) / len(win)) if win else None)
        return {
            "symbol": sym, "kind": kind, "multiplier": mult,
            "note": f"{FUT_NAMES.get(sym, sym)} futures notional" if kind == "futures" else f"via {sym}",
            "dates": dates[i0:], "dv": [round(x) for x in vis], "up": up, "avg50": avg,
            "last": round(vis[-1]), "lastDate": dates[-1], "skipped": notes,
            "partial": dates[-1] == _et_now().strftime("%Y-%m-%d") and _et_now().hour < 17,
        }
    print("no volume data for", mid, notes, file=sys.stderr)
    return None


def build(m):
    used = m["symbol"]
    try:
        series, live = fetch(used)
    except Exception:
        if not m.get("fallback"):
            raise
        used = m["fallback"]
        series, live = fetch(used)
    dates = [d for d, _ in series]
    closes = [c for _, c in series]
    if len(closes) < SMA_N + 50:
        raise RuntimeError(f"{used}: not enough history ({len(closes)})")
    sma = [None] * len(closes)
    run = sum(closes[:SMA_N])
    sma[SMA_N - 1] = run / SMA_N
    for i in range(SMA_N, len(closes)):
        run += closes[i] - closes[i - SMA_N]
        sma[i] = run / SMA_N
    cutoff = (datetime.strptime(dates[-1], "%Y-%m-%d") - timedelta(days=VISIBLE_DAYS)).strftime("%Y-%m-%d")
    start = max(next(i for i, d in enumerate(dates) if d >= cutoff), SMA_N - 1)
    dec = m["decimals"] + 2
    last, last_sma = closes[-1], sma[-1]
    prev_sma = sma[-1 - SLOPE_LOOKBACK]
    above = last > last_sma
    up = last_sma > prev_sma
    trend = "bullish" if (above and up) else "bearish" if (not above and not up) else "mixed"
    return {
        "id": m["id"], "name": m["name"], "subtitle": m["subtitle"],
        "symbol": used, "decimals": m["decimals"], "unit": m["unit"],
        "dates": dates[start:],
        "close": [round(c, dec) for c in closes[start:]],
        "sma150": [round(s, dec) for s in sma[start:]],
        "last": round(last, dec), "lastDate": dates[-1],
        "smaLast": round(last_sma, dec),
        "pctFromSma": round((last / last_sma - 1) * 100, 2),
        "above": above, "smaSlope": "up" if up else "down", "trend": trend,
        "volume": build_volume(m["id"], dates[start]),
    }


def main():
    out_path = os.path.join(os.path.dirname(__file__), "..", "data", "markets.json")
    out = {"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "Yahoo Finance chart API (daily closes)", "smaPeriod": SMA_N, "markets": []}
    old = {}
    try:
        with open(out_path) as f:
            old = {x["id"]: x for x in json.load(f)["markets"]}
    except Exception:
        pass
    failures = 0
    for m in MARKETS:
        try:
            out["markets"].append(build(m))
            print("ok", m["symbol"], out["markets"][-1]["lastDate"], out["markets"][-1]["last"])
        except Exception as e:
            failures += 1
            print("FAIL", m["symbol"], e, file=sys.stderr)
            if m["id"] in old:
                out["markets"].append(old[m["id"]])  # keep last good data
    if failures == len(MARKETS):
        sys.exit("all fetches failed; leaving existing data untouched")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")


if __name__ == "__main__":
    main()
