# Five Markets, One Line.

Live page: **https://mikemclaughlin.github.io/five-markets/**

A one-page dashboard of five markets, each plotted as ~12 months of daily closes with its
**150-day simple moving average** (the yellow line).

| Panel | Market | Ticker (Yahoo Finance) |
|---|---|---|
| Stocks | S&P 500 Equal Weight index | `^SPXEW` (falls back to `RSP` ETF if unavailable) |
| 10-Year Yield | US 10-year Treasury yield | `^TNX` |
| Bonds | 30-Year Treasury bond futures | `ZB=F` |
| US Dollar | US Dollar Index | `DX-Y.NYB` |
| Gold | Gold futures | `GC=F` |

## Reading it
- **Gold line** = 150-day SMA, computed from ~2 years of history so it covers the full visible window.
- **Price-line glow**: green = price above the SMA *and* the SMA sloping up (bullish);
  red = price below *and* SMA sloping down (bearish); amber = mixed. Slope = SMA today vs 10 trading days ago.
- **Top-right pill** on each panel: "Above 150 SMA" / "Below 150 SMA" with % distance from the SMA.
  Last price and SMA value are shown under each market name.

## Market Outlook sign
Above the panels, a **Market Outlook** card combines the five trend states into one rule-based read
for stocks (intermarket logic, scored from the equity market's point of view):

| Market | Bullish trend | Bearish trend | Why |
|---|---|---|---|
| Stocks | +2 | −2 | the trend itself, double weight |
| 10-Year Yield | −1 | +1 | rising rates tighten financial conditions |
| Bonds | +1 | −1 | mirrors yields |
| US Dollar | −1 | +1 | a strong dollar tightens global liquidity and hurts earnings |
| Gold | −0.5 | +0.5 | fear / inflation hedging; half weight because the signal is ambiguous |

Mixed = 0. Total ranges −5.5 to +5.5 and maps to: **≥ +3** Strong Tailwind · **+1 to +2.5** Tailwind ·
**−0.5 to +0.5** Neutral–Choppy · **−1 to −2.5** Headwind · **≤ −3** Strong Headwind.
The card shows the headline, a plain-English sentence built from the actual combination, per-market
contribution chips and an expandable "How this is scored" note. It is recomputed in the browser on
every data refresh. *Rule-based trend read, not a forecast or investment advice.*

## How updates work
1. **Data pipeline** – `.github/workflows/update-and-deploy.yml` runs every 30 minutes on weekdays
   (13:00–23:30 UTC ≈ 8:00 AM–6:30 PM ET), on manual `workflow_dispatch`, and on pushes to `master`.
   It runs `scripts/fetch_markets.py` (Python stdlib only, free Yahoo Finance chart API, no keys),
   commits `data/markets.json` if it changed, and deploys the site to GitHub Pages.
   If a ticker fails to fetch, its last good data is kept.
2. **Page** – `index.html` / `app.js` read `data/markets.json` from the same origin (no CORS).
   - **Auto-update toggle**: when ON, the page re-fetches the JSON (cache-busted) on a timer.
   - **Period**: 1, 5, 15, 30, 60 minutes or a custom number of minutes.
   - Toggle and period are saved in `localStorage`.
   - **Refresh now** fetches immediately.
   - During a refresh the current charts stay on screen; on an error a small note appears and the last good data is kept.
   - "Last updated" is when the data file was generated, shown in ET (America/New_York).

Note: the page can only be as fresh as the data file, which the workflow refreshes every 30 minutes
on weekdays (GitHub may delay scheduled runs by a few minutes). Run the workflow manually from the
Actions tab for an immediate update.

## Run locally
```sh
python3 scripts/fetch_markets.py   # writes data/markets.json
python3 -m http.server 8000        # open http://localhost:8000
```

v1.2
