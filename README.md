# Weightings Analytics

`main` is the canonical source for both local and web installations. Local mode
provides all tools without login or publication controls. Web mode adds visitor
and authenticated administrator access through Cloudflare, with private,
weights-only or public portfolio visibility. See
[website deployment](docs/site-deployment.md) for the web configuration.

Weightings Analytics is a local-first Next.js application for analysing ETF
holdings, comparing underlying exposures, building look-through portfolios,
and creating reusable ETFs from iShares source universes.

## Features

- Inspect one ETF or compare two ETFs by concentration, sector allocation,
  overlap, active sleeves, geography, and ACWI-implied weighting distortion.
- Distortion defaults to the top 30 positive equity holdings, weighted against
  an ACWI free-float counterfactual restricted to the same securities. In
  Distortion details, adjust the top-holdings slider or select All holdings
  (the original common-securities calculation). Market Coverage compares all
  positive equity holdings against the entire ACWI equity universe, including
  unheld benchmark securities and portfolio equities outside ACWI. Each score
  is half the sum of absolute weight differences on distributions normalized
  to 100%, expressed from 0 to 100; cash, non-equity assets and shorts are
  excluded. Top and All holdings report unmatched equities as excluded from
  the score. The Holdings summary always shows the default Top 30 score and
  the full-ACWI Market Coverage score.
  Distortion details separates overweights and underweights in two parallel
  rankings: percentage-point gaps and relative weight multiples (double is
  ×2, half is ×0.5). Unheld ACWI securities display ×0; positions with no ACWI
  weight appear only in the absolute ranking because their ratio is undefined.
  An optional **Total market cap** basis in Distortion details uses TradingView
  company-level capitalization explicitly converted to USD. Top / All holdings
  weight the selected companies, including those outside ACWI; Market Coverage
  uses the ACWI equity universe reweighted by total cap. Known equivalent listings
  and additional share classes with matching issuer metadata and agreeing caps
  are grouped; company capitalizations are counted once. This basis is experimental:
  invalid, missing, stale or conflicting caps are excluded, never replaced by ACWI
  free-float weights. Coverage uses published portfolio weights and, for the full
  reference, original ACWI weights; it is not a claim about unknown missing caps.
  Partial distributions are renormalized. Scores require 95% selected-weight
  coverage and, for Market Coverage, 99% ACWI-weight coverage. Capture dates and
  exclusions are visible in the panel; the default Holdings overview stays on
  the ACWI free-float basis.
  Reproduce the live currency/listing checks and ETF comparisons with
  `node --conditions=react-server --import tsx scripts/audit-total-cap-distortion.ts`.
  The JSON report defaults to the ignored `reports/` directory.
- Build long/short portfolios from ETFs and direct equities, including cash or
  borrowing in multiple currencies, then inspect gross or NAV exposure.
- Save portfolios as local ETFs or create rule-based, free-float-weighted ETFs.
- Compare saved portfolio histories on the Portfolio overview in USD or EUR,
  using absolute values or relative change from a selectable start date.
  Visitors can compare public and weights-only portfolios in relative mode;
  only fully public portfolios expose amounts. Private portfolios stay hidden.
- Initialize portfolios from snapshot copies of up to ten portfolios or ETFs:
  choose a budget in a supported cash currency and allocate percentages to each
  source. The clone merges underlying securities into fixed share quantities,
  retains cash and financing, and creates no dependencies on source portfolios.
  Previewing does not save the draft; use Create portfolio after reviewing it.
- Inspect supported iShares/BlackRock ETFs and funds, and persist validated
  official holdings snapshots.
- Enrich constituents with TradingView fundamentals and consensus EPS series.
- Refresh data caches by replacing their last successful values, without keeping
  daily metric or ETF-composition archives. Portfolio charts and dividend
  entitlement/payment records retain their required history.
- Aggregate valuation, earnings, quality, size, income, and risk metrics with
  explicit data coverage and source freshness.
- Research ETFs and portfolios with Codex through T3: templates, model and
  reasoning selection, dated web sources, follow-ups and saved conversations.
  See [AI analysis setup](docs/ai-analysis.md) for the optional backend connection
  and the local versus administrator-only server access rules.

## Quick start

Requirements: Node.js 22.13 or newer and npm. Run commands from the project root.
An internet connection is needed to load new provider data.

```bash
npm ci
```

Run `npm run dev`. The default is local mode on loopback; no access configuration
or administrator login is required. Optional settings belong in `.env.local`
or `.env.development.local`. Use `SITE_ACCESS_MODE=local` to explicitly select
local mode when web settings also exist on the machine.

Open `http://localhost:3000`. The development launcher applies committed SQLite
migrations and idempotently seeds the ETF catalog before starting Next.js.

Holdings are fetched on demand. The catalog contains supported source funds and
local definitions; it is not a search of every listed ETF.

Use `npm ci` for a fresh checkout and stop if it reports an error. Do not copy or
cache `node_modules` between machines; the GitHub Actions workflow caches only
npm downloads and rebuilds dependencies from `package-lock.json` on every run.

## Production run

The compiled application also supports local mode. With no access settings,
`npm run start` listens on `127.0.0.1` and gives full access without login.
To host the web version, configure `SITE_ACCESS_MODE=cloudflare`, Cloudflare
Access and the environment described in [website deployment](docs/site-deployment.md).
The same build supports both modes; the choice is made on the server at runtime.

```bash
npm ci
npm run build
npm run start
```

Open `http://localhost:3000` locally, or the configured HTTPS public or owner
domain for a web installation. The standalone launcher
keeps database and migration paths anchored to the project root and stages the
required static assets before starting the generated server. Check
`/api/health` to verify application and SQLite readiness (`200` when healthy,
`503` otherwise). This endpoint does not check external provider availability.
`npm run start` also applies migrations and seeds the catalog before launch.

## Provider access from servers

iShares/BlackRock may reject datacenter IPs (HTTP 403), even when the same
request succeeds from a residential connection. Expect this possibility when
deploying to a VPS; a healthy application does not guarantee provider access.
Cloudflare in front of your website does not change its outgoing IP.

Failed updates retain the last usable holdings and display a prominent warning
with the error code and original holdings date, including affected dependencies.
A successful refresh clears the warning. HTTP 403/429/5xx, network failures and
invalid responses are distinguished; no substitute holdings are fabricated.

Operators should test provider downloads from their deployment before choosing
a remedy: an optional restricted Cloudflare Worker relay, an authorised outbound
proxy, another usable network, or a supported data feed. Worker/datacenter
addresses can also be blocked. The project does not require Cloudflare Workers
and never provisions a proxy automatically. See the [optional relay setup](deploy/ishares-relay/README.md)
for configuration, limits, testing and rollback.

## Configuration

Use `.env.example` as the local configuration template. Web access settings are
required only for web installations. Docker and the web systemd service explicitly
select Cloudflare access; missing settings deny access. The systemd service reads
`/etc/weightings-analytics.env`. Local public-preview settings belong in
`.env.development.local`, with `SITE_LOCAL_PUBLIC_PREVIEW=true`; this optional
development view uses `localhost` for the administrator and `127.0.0.1` for the visitor.

| Variable | Default | Valid values / purpose |
| --- | ---: | --- |
| `SITE_ACCESS_MODE` | `local` | `local`: full loopback access, no login; `cloudflare`: web visitor/admin access. Existing web settings without a mode still select Cloudflare and deny access if incomplete. |
| `SITE_LOCAL_PUBLIC_PREVIEW` | unset | Development-only visitor/admin preview when `true`; leave unset for ordinary local use. |
| `BIND_HOST` | `127.0.0.1` locally | Standalone listen address, loaded from the environment or `.env.local`; defaults to `0.0.0.0` for explicit Cloudflare mode. Overrides the machine's `HOSTNAME`. |
| `DATABASE_PATH` | `.data/weightings-analytics.sqlite` | Durable SQLite database path |
| `DRIZZLE_MIGRATIONS_PATH` | `drizzle` | Migration directory; useful when embedded in another runtime image |
| `HOLDINGS_CACHE_TTL_SECONDS` | `86400` | Positive holdings snapshot TTL |
| `ISHARES_RELAY_URL` | unset | Optional operator-managed HTTPS relay for iShares/BlackRock; direct access remains the default |
| `HOLDINGS_REFRESH_CONCURRENCY` | `4` | Parallel holdings refreshes, 1–8 |
| `MARKET_PRICE_TTL_SECONDS` | `86400` | Positive Yahoo price and FX TTL |
| `MARKET_PRICE_CONCURRENCY` | `4` | Parallel Yahoo requests, 1–8 |
| `TRADINGVIEW_METRICS_TTL_SECONDS` | `86400` | Positive Screener metrics TTL |
| `TRADINGVIEW_METRICS_MISSING_TTL_SECONDS` | `900` | Confirmed missing field TTL, 60–86400 |
| `TRADINGVIEW_BATCH_SIZE` | `1000` | Screener batch size, 25–1000 |
| `TRADINGVIEW_MISSING_RETRY_LIMIT` | `100` | Omitted symbols retried in batches of 25, 0–500 |
| `TRADINGVIEW_ESTIMATES_BATCH_SIZE` | `250` | Estimates session batch size, 25–500 |
| `TRADINGVIEW_ESTIMATES_CONCURRENCY` | `5` | Parallel Estimates sessions, 1–5; shared across requests in one server process |
| `TRADINGVIEW_ESTIMATES_MISSING_TTL_SECONDS` | `900` | Confirmed missing series TTL, 60–86400 |
| `PORTFOLIO_METRICS_DAILY_REFRESH` | `true` | Set `false` to disable daily source-metrics refresh for saved portfolios |

Metrics loads fundamentals and EPS consensus concurrently for known symbols.
The Metrics screen displays fundamental tables as soon as that phase completes,
then adds the consensus charts when all estimates have settled. Both phases
belong to the current request; no previous aggregate is shown while loading.
Overlapping requests share in-flight consensus symbols, with a process-wide
connection limit. Completed requests are removed from that coordinator; normal
observation TTLs still determine data freshness. No durable aggregate-result
cache is added.

While the server is running, saved portfolio metrics are refreshed once per
calendar day in `Europe/Paris`. The first check runs 90 seconds after startup,
then every 15 minutes. The task retrieves each required security once across
portfolios; unrelated catalog funds are excluded. It refreshes source
observations and does not store calculated portfolio metrics. A durable day
claim prevents repeated scans on restart or provider failure; manual loads and
force refresh remain available. If the server was stopped, it catches up on
the next startup rather than replaying missed days.

Measure real provider loads against isolated copies of a database with
`node --conditions=react-server --import tsx scripts/benchmark-metrics.ts --etfs=PF,ACWI --runs=2`.
Results are written under the ignored `reports/` directory. The source database
is read-only and each sample starts from the same baseline backup.

Relative paths resolve from the project root. The database, WAL files, and
backups at the default location are ignored by Git and survive rebuilds or
deletion of `.next`. If you change `DATABASE_PATH`, keep the database and backups
outside build directories and outside version control.

## Common commands

```bash
npm test                 # unit, contract, migration, audit, and launcher tests
npm run typecheck        # TypeScript validation
npm run lint             # ESLint
npm run db:setup         # apply migrations and seed the catalog
npm run db:stats         # display database size and row counts
npm run db:backup        # back up SQLite to a sibling backups directory
npm run db:audit-mappings -- --strict --breakdown
```

Backups default to `.data/backups`; with a custom database path, they are written
to `backups` beside that database. The backup command applies pending migrations
before using the SQLite backup API.

The mapping audit opens SQLite read-only. It checks current provider mappings,
provenance, metadata, identity consistency, unresolved weight, duplicates, and
orphaned references. Add `--json` for machine-readable output.

Repeated listing labels used only in superseded snapshots are reported separately
as historical collisions, not active duplicates. Current snapshots, saved portfolio
positions and ETF definitions keep a collision actionable. This does not infer
corporate actions or merge identities. For example, ONEOK's September 2026 identifier
change leaves distinct old/new ISINs in the source history.

Import a legacy TradingView mapping database once with:

```bash
npm run db:import-tradingview-mappings -- path/to/stocks.sqlite
```

## API

Holdings routes accept a catalog ID or ticker; use IDs to identify a specific
share class. The endpoints are:

- `GET /api/health`
- `GET /api/v1/catalog`
- `GET /api/v1/holdings/:ticker`
- `GET /api/v1/holdings/:ticker/analysis`
- `GET /api/v1/compare?left=IVV&right=ACWI`
- `GET|PUT /api/v1/portfolio` (legacy workspace draft; publishing consumes it)
- `POST /api/v1/portfolio` (owner-only composition preview; no portfolio write)
- `POST /api/v1/portfolio/save-as-etf` (direct creation from positions and cash)
- `POST /api/v1/portfolio/clone` (owner-only allocation preview; no portfolio write)
- `GET /api/v1/securities/search?q=AAPL`
- `GET /api/v1/prices/quote?kind=etf&referenceId=ivv-us`
- `POST /api/v1/prices/quotes`
- `GET /api/v1/prices/fx?currency=EUR`
- `POST /api/v1/etf-creator`
- `GET|PATCH|DELETE /api/v1/local-etfs/:etfId`
- `PATCH /api/v1/local-etfs/:etfId/visibility` (owner only)
- `GET /api/v1/published-portfolios/:etfId` (fully public portfolios only)
- `GET /api/v1/metrics/overview?etfs=ivv-us,acwi-us`
- `GET /api/v1/metrics/stock?securityId=US5949181045`

Comparison excludes cash by default. Add `includeCash=true` to include it in
weight normalization, overlap, and active-sleeve calculations. Metrics Overview
accepts one to four distinct ETFs after reference resolution.

Metrics also includes a **Single stock** sub-panel. Select an equity through
the ACWI and supported-securities search to inspect all 20 company metrics,
the eight quarterly EPS consensus observations, and the 4Q/2Q/1Q P/E paths.
The stock endpoint reuses the ETF Screener and Estimates pipeline and its
security-level caches, refreshing only the selected company. Direct stock
ratios retain negative values; derived P/E and EPS growth require positive EPS.
Observation capture dates and partial/stale provider states remain visible.
Individual-stock requests also retrieve the next earnings report date in the
same Screener call (`earnings_release_next_date` and listing `timezone`). The
calendar has its own persisted daily cache, including unavailable dates, and
is displayed in the listing timezone with its capture date and stale status.
Scheduled dates can be estimated or revised by TradingView.
Add `assetClass=equity` to security search to restrict results to equities.

Portfolio and ETF editing routes require owner access, including their GET
endpoints. Public catalog and analysis routes exclude private ETFs and personal
amounts; exact published amounts use the dedicated published-portfolios route.

Add `refresh=true` to holdings, holdings analysis, comparison, portfolio, single
quote, or ETF/stock metrics requests to request fresh source data. Provider
failures can still return stale fallback data. The FX endpoint has no refresh
query option.

Batch listing quotes accept a JSON body with `quotes` entries containing `key`,
`securityId`, and `ticker` (up to 30 distinct keys), plus optional `refresh: true`.
Use canonical security IDs returned by the application. Request body contracts
for writes are defined in `src/app/api/v1`; this is an endpoint index, not a
complete API schema.

## Daily portfolio value history

Saved portfolios record their net value in USD and EUR by default. The portfolio
detail page shows dated observations, period filters, the currency selector and
a daily recording switch. Pausing retains existing history; each portfolio has
its own persistent setting. EUR values use the EUR/USD rate captured with the
observation, rather than today's rate applied to older dollar amounts.

The local Node server checks on startup and every minute, without requiring an
open browser. It forces a refresh of position prices and exchange rates before
recording. The daily target is **16:10 America/New_York**, following US daylight
saving time. A portfolio without history gets an initial observation; otherwise
an observation is due after the daily target or whenever the latest capture is
more than 24 hours old. A unique portfolio/date key limits recording to one
observation per New York calendar day (including an initial or catch-up point
taken before that day's normal target).

Failed refreshes are retried after five minutes; stale fallback values are not
saved as new observations. Weekends, holidays and early-close days retain the
same daily target and use the latest available regular-market quotes. A capture
records its actual timestamp and quote timestamps. The server cannot record
while stopped: restarting resumes collection, leaving missed dates empty.
The chart spaces observations by time and connects the saved points. Changes in
net value include cash flows and edits to holdings; they are not a cash-flow
adjusted investment return.

SQLite migrations create `portfolio_value_snapshots` and
`portfolio_history_settings` automatically. History stays in the local database
and is included in normal database backups. The owner-only endpoint is
`GET /api/v1/portfolio/history?portfolioId=...`; change recording with `PATCH`
and a JSON body such as `{"enabled": false}`. Run `npm run test:portfolio-history`
to verify scheduling, persistence, catch-up and retry behavior.

The Portfolio overview reads saved histories through
`GET /api/v1/portfolio/overview`. It does not initiate valuation captures.
Public responses omit private portfolios and remove currency amounts from
weights-only histories on the server. Relative curves use each portfolio's first
saved observation on or after the chosen start date; their baseline dates remain
visible when histories start on different days. Changing visibility applies to
the overview immediately, including dependencies on private funds.

Visitors open the same read-only Portfolio detail layout from the overview.
`GET /api/v1/portfolio/published/{etfId}` and its `/history` subroute validate
current publication visibility and dependencies. Fully public portfolios expose
current amounts with USD/EUR conversion and the second-currency equivalent;
weights-only portfolios expose allocations and relative history, omitting exact
amounts, share quantities and editor metadata in the server response. Private
portfolios remain unavailable. Creation, editing, dividend payments and recording
settings remain owner-only.

## Architecture

```text
src/
  app/                  Next.js pages and API handlers
  components/           interface panels
  data/providers/       external source adapters
  data/services/        refresh and persistence orchestration
  domain/processors/    pure calculations
  db/repositories/      persistence queries
scripts/                database, audit, and launcher utilities
drizzle/                committed SQL migrations
.data/                  ignored local database and backups
```

See [docs/architecture.md](docs/architecture.md) for the data, cache, identity,
and metric contracts that must remain stable. That file is the detailed technical
reference.

No demonstration holdings dataset is included. Each installation builds its
own local cache from official source files. Data is indicative and does not
constitute investment advice.
