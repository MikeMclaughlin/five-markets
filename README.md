# Five Markets, One Line.

Live page: **https://mikemclaughlin.github.io/five-markets/**

A one-page dashboard of six markets, each plotted as ~3 years of daily closes with its
**150-day simple moving average** (the yellow line).

| Panel | Market | Ticker (Yahoo Finance) |
|---|---|---|
| Stocks | S&P 500 Equal Weight index | `^SPXEW` (falls back to `RSP` ETF if unavailable) |
| QQQ | Invesco QQQ (Nasdaq-100 ETF) | `QQQ` |
| 10-Year Yield | US 10-year Treasury yield | `^TNX` |
| Bonds | 30-Year Treasury bond futures | `ZB=F` |
| US Dollar | US Dollar Index | `DX-Y.NYB` |
| Gold | Gold futures | `GC=F` |

## Reading it
- **Yellow line** = 150-day SMA, computed from ~5 years of history so it covers the full visible window.
- **Price-line glow**: green = price above the SMA *and* the SMA sloping up (bullish);
  red = price below *and* SMA sloping down (bearish); amber = mixed. Slope = SMA today vs 10 trading days ago.
- **Top-right pill** on each panel: "Above 150 SMA" / "Below 150 SMA" with % distance from the SMA.
  Last price and SMA value are shown under each market name.
- **Panel shading** follows the pill: dark green background when price is above the 150 SMA, dark pink when below (updates with every data refresh).

## Chart view: Price / % from SMA (v1.9)
A segmented control in the controls bar switches all six panels between **Price** (daily close with the
yellow 150 SMA) and **% from SMA**: one bar per trading day of (close / 150 SMA − 1) × 100, green above
zero and red below, with a yellow 0% baseline (= the 150 SMA) and ±% gridlines. Hover or tap a bar for its
date and %. The choice is saved in `localStorage` (default Price). Pills, Dollar Volume, lag notes and the
Outlook card are the same in both views. All panels share one trading-day x-axis (the union of the
markets' trading dates), so weekends take no space and every chart, bar strip and month label lines up.

## Collapsible panels and pinned controls (v1.10)
- Click/tap a panel's header (or its chevron) to collapse or expand it, from the Market Outlook card through
  Gold. A collapsed panel is one compact row with the name and its Above/Below pill (%); the collapsed Outlook
  shows its headline and score. "Collapse all / Expand all" sit in the controls bar. States are saved in
  `localStorage` (default all expanded) and survive refreshes; headers are keyboard buttons (Enter/Space,
  `aria-expanded`).
- (v1.12.1) Collapsed panels, including the Market Outlook card, stay collapsed across reloads, auto-updates,
  Price/% switches and new-build self-updates. Settings use stable `fm.*` keys (not tied to a build); if the
  browser blocks storage the page still works and remembers for the current visit.
- The controls bar (auto-update, period, Refresh, Price/% toggle, Collapse/Expand all, Data as of / STALE) stays
  pinned at the top while the Outlook and panels scroll beneath it (solid backdrop once the title scrolls away).

## Chart duration (v1.14)
A **Show** dropdown in the pinned controls bar picks 6 months, 1 year, 18 months, 2 years, 30 months or 3 years
(default 3 years). It trims the already-loaded 3-year data on the page (no refetch); the 150-day SMA keeps its
full-history values, and pills, values and the Outlook always use the latest bar. Month labels adapt (monthly at
6 months–1 year, every 2 months mid-range, quarterly at 3 years). The choice is remembered under `fm.range`.

## 3-year window (v1.13)
Every panel shows ~3 years (~750 trading days) of price, 150-day SMA, % from SMA bars and Dollar Volume on the
shared trading-day axis. The fetch pulls 5 years so the SMA and 50-day volume average are warmed up from day one.
Month labels pick their spacing from the chart width (quarterly on desktop: Jan, Apr, Jul, Oct; January shows the year).

## 18-month window (v1.12, superseded by v1.13)
Every panel shows ~18 months (~378 trading days) of price, 150-day SMA, % from SMA bars and Dollar Volume on
the shared trading-day axis. The fetch pulls 3 years from Yahoo so the 150-day SMA and the 50-day volume average
are fully warmed up from the first visible day.

## Gap-free bars (v1.11)
- Dollar Volume and % from SMA bars fill their whole trading-day slot (snapped to pixels), so neighbours touch.
- Bar dates use each exchange's own time zone with DST (`exchangeTimezoneName`). The old fixed offset shifted
  summer futures/ICE bars one day earlier, so their panels had empty slots on the shared axis.
- Evening futures bars (after 6 PM ET, the next session's first minutes) no longer replace the completed day's volume.
- 10-Year Yield and Bonds keep futures notional (ZN=F / ZB=F). Their low bars in roll weeks (Yahoo's continuous
  contract stays on the expiring month for a few weeks each quarter) are real reported volume, shown as small bars.
- A day the source reports no volume at all (e.g. two GC=F days) shows a short grey marker instead of a hole.

## Dollar Volume strip (v1.4)
The bottom of each panel shows daily **dollar volume** bars (green = up day, red = down day) on the same
time axis, with a thin 50-day average line and the latest value. Only real traded volume is used:

| Panel | Primary | Fallback |
|---|---|---|
| Stocks | RSP shares × price | — |
| QQQ | QQQ shares × price | — |
| 10-Year Yield | ZN=F contracts × price × 1,000 | IEF |
| Bonds | ZB=F contracts × price × 1,000 | TLT |
| US Dollar | DX=F contracts × price × 1,000 | UUP |
| Gold | GC=F contracts × price × 100 | GLD |

A futures series is skipped for its ETF fallback if Yahoo returns no data or more than 10% empty
days. If nothing is available the strip says "No volume data". Futures bars for the current day are
marked "partial" until the session closes; futures volume also spikes around quarterly contract rolls.

## Market Outlook sign
Above the panels, a **Market Outlook** card combines the five trend states into one rule-based read
for stocks (intermarket logic, scored from the equity market's point of view):

| Market | Bullish trend | Bearish trend | Why |
|---|---|---|---|
| Stocks | +2 | −2 | the trend itself, double weight |
| QQQ (Nasdaq-100) | +1 | −1 | risk-on growth confirmation; single weight |
| 10-Year Yield | −1 | +1 | rising rates tighten financial conditions |
| Bonds | +1 | −1 | mirrors yields |
| US Dollar | −1 | +1 | a strong dollar tightens global liquidity and hurts earnings |
| Gold | −0.5 | +0.5 | fear / inflation hedging; half weight because the signal is ambiguous |

Mixed = 0. Total ranges −6.5 to +6.5 and maps to: **≥ +3.5** Strong Tailwind · **+1 to +3** Tailwind ·
**−0.5 to +0.5** Neutral–Choppy · **−1 to −3** Headwind · **≤ −3.5** Strong Headwind.
The card shows the headline, a plain-English sentence built from the actual combination, per-market
contribution chips and an expandable "How this is scored" note. It is recomputed in the browser on
every data refresh. *Rule-based trend read, not a forecast or investment advice.*

## How updates work
1. **Data pipeline** – `.github/workflows/update-and-deploy.yml` runs on weekdays at
   8:07 AM, 12:07 PM and 4:07 PM ET (13:07, 17:07, 21:07 UTC; cron `7 13,17,21 * * 1-5`), on manual `workflow_dispatch`, and on pushes to `master`.
   It runs `scripts/fetch_markets.py` (Python stdlib only, free Yahoo Finance chart API, no keys),
   commits `data/markets.json` if it changed, and deploys the site to GitHub Pages.
   If a ticker fails to fetch, its last good data is kept.
2. **Page** – `index.html` / `app.js` read `data/markets.json` from the same origin (no CORS).
   - **Auto-update toggle**: when ON, the page re-fetches the JSON (cache-busted) on a timer.
   - **Period**: 1, 5, 15, 30, 60 minutes or a custom number of minutes.
   - Toggle and period are saved in `localStorage`.
   - **Refresh now** fetches immediately.
   - During a refresh the current charts stay on screen; on an error a small note appears and the last good data is kept.
   - **"Data as of"** (controls bar and footer) is the `generatedAt` time the fetch job wrote into
     `markets.json`, shown in ET — not when the page was loaded. No page-load or next-update time is shown.
   - **Staleness**: during the regular session (Mon–Fri 9:30 AM–4:00 PM ET) data older than 4.5 hours is tagged
     **STALE** (amber; red when more than 2 hours past that). Outside the session, data is only flagged if nothing was
     fetched since the most recent 4:00 PM ET close (after a 4.5-hour grace). Exchange holidays are not modeled.
     A panel whose last daily bar lags the other markets and the expected session date gets a small "Last bar" note.

Note: the page can only be as fresh as the data file, which the workflow refreshes at 8:07 AM,
12:07 PM and 4:07 PM ET on weekdays (GitHub may delay scheduled runs by a few minutes). Run the workflow manually from the
Actions tab for an immediate update.

## Always the latest version (no stale cache)
GitHub Pages serves files with a 10-minute cache, so the page busts it itself:
- The deploy runs `scripts/build_site.sh`, which stamps a **build id** (a hash of `index.html`, `app.js`
  and `style.css`) into `index.html` as `<meta name="build">` and as `?v=<build>` on `app.js` and
  `style.css`, and writes `version.json`. The id only changes when the code changes, not on data refreshes.
- `index.html` carries no-cache meta hints; `data/markets.json` and `version.json` are fetched with
  `cache: "no-store"` plus a `?t=` timestamp.
- Every data refresh and every 60 seconds the page checks `version.json`. If a newer build is live it
  navigates to `./?b=<build>` (a fresh URL, so the cached HTML is skipped) while the current page stays on
  screen until the new one loads. It tries at most once per build per tab, so it can't loop.

## Run locally
```sh
python3 scripts/fetch_markets.py   # writes data/markets.json
python3 -m http.server 8000        # open http://localhost:8000
```

v1.15
