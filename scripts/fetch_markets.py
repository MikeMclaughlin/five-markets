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
    {"id": "tnx", "name": "10-Year Yield", "subtitle": "US Treasury yield", "symbol": "^TNX", "decimals": 3, "unit": "%"},
    {"id": "bonds", "name": "Bonds", "subtitle": "30-Year Treasury bond futures", "symbol": "ZB=F", "decimals": 3, "unit": ""},
    {"id": "dollar", "name": "US Dollar", "subtitle": "Dollar index", "symbol": "DX-Y.NYB", "decimals": 2, "unit": ""},
    {"id": "gold", "name": "Gold", "subtitle": "Gold futures", "symbol": "GC=F", "decimals": 1, "unit": ""},
]


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
            tz_off = meta.get("gmtoffset", 0)
            pts = {}
            for t, c in zip(ts, closes):
                if c is None:
                    continue
                d = datetime.fromtimestamp(t + tz_off, tz=timezone.utc).strftime("%Y-%m-%d")
                pts[d] = c  # last value for a date wins (intraday bar for today)
            live = meta.get("regularMarketPrice")
            return sorted(pts.items()), live
        except Exception as e:  # noqa
            last_err = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{symbol}: {last_err}")


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
