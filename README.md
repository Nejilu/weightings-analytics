# Weightings Analytics

This site-deployment branch adds public/owner access through Cloudflare and
private, weights-only or public portfolio visibility. See
[website deployment](docs/site-deployment.md) before exposing the application.
Local development requires `SITE_ACCESS_MODE=local` and loopback binding.

Weightings Analytics is a local-first Next.js application for analysing ETF
holdings, comparing underlying exposures, building look-through portfolios,
and creating reusable ETFs from iShares source universes.

## Features

- Inspect one ETF or compare two ETFs by concentration, sector allocation,
  overlap, active sleeves, geography, and ACWI-implied weighting distortion.
- Build long/short portfolios from ETFs and direct equities, including cash or
  borrowing in multiple currencies, then inspect gross or NAV exposure.
- Save portfolios as local ETFs or create rule-based, free-float-weighted ETFs.
- Inspect supported iShares/BlackRock ETFs and funds, and persist validated
  official holdings snapshots.
- Enrich constituents with TradingView fundamentals and consensus EPS series.
- Aggregate valuation, earnings, quality, size, income, and risk metrics with
  explicit data coverage and source freshness.

## Quick start

Requirements: Node.js 22.13 or newer and npm. Run commands from the project root.
An internet connection is needed to load new provider data.

```bash
npm ci
```

Create `.env.development.local` with:

```dotenv
SITE_ACCESS_MODE=local
SITE_LOCAL_PUBLIC_PREVIEW=true
```

Then run `npm run dev -- --hostname 127.0.0.1`. Open `http://localhost:3000`
for the owner interface or `http://127.0.0.1:3000` for the public preview.

Open `http://localhost:3000`. The development launcher applies committed SQLite
migrations and idempotently seeds the ETF catalog before starting Next.js.

Holdings are fetched on demand. The catalog contains supported source funds and
local definitions; it is not a search of every listed ETF.

Use `npm ci` for a fresh checkout and stop if it reports an error. Do not copy or
cache `node_modules` between machines; the GitHub Actions workflow caches only
npm downloads and rebuilds dependencies from `package-lock.json` on every run.

## Production run

Configure Cloudflare Access and the production environment as described in
[website deployment](docs/site-deployment.md). Production rejects local access mode.

```bash
npm ci
npm run build
npm run start
```

Open the configured HTTPS public or owner domain through Caddy. The standalone launcher
keeps database and migration paths anchored to the project root and stages the
required static assets before starting the generated server. Check
`/api/health` to verify application and SQLite readiness (`200` when healthy,
`503` otherwise). This endpoint does not check external provider availability.
`npm run start` also applies migrations and seeds the catalog before launch.

## Configuration

Use `.env.example` as the configuration template. Site access settings are required;
the production systemd service reads `/etc/weightings-analytics.env`, which you
create on the VPS. Local preview settings belong in `.env.development.local`.

| Variable | Default | Valid values / purpose |
| --- | ---: | --- |
| `BIND_HOST` | `0.0.0.0` | Standalone listen address; set in the shell environment, e.g. `127.0.0.1` for loopback only. Overrides Docker's automatic `HOSTNAME`. |
| `DATABASE_PATH` | `.data/weightings-analytics.sqlite` | Durable SQLite database path |
| `DRIZZLE_MIGRATIONS_PATH` | `drizzle` | Migration directory; useful when embedded in another runtime image |
| `HOLDINGS_CACHE_TTL_SECONDS` | `86400` | Positive holdings snapshot TTL |
| `HOLDINGS_REFRESH_CONCURRENCY` | `4` | Parallel holdings refreshes, 1–8 |
| `MARKET_PRICE_TTL_SECONDS` | `86400` | Positive Yahoo price and FX TTL |
| `MARKET_PRICE_CONCURRENCY` | `4` | Parallel Yahoo requests, 1–8 |
| `TRADINGVIEW_METRICS_TTL_SECONDS` | `86400` | Positive Screener metrics TTL |
| `TRADINGVIEW_METRICS_MISSING_TTL_SECONDS` | `900` | Confirmed missing field TTL, 60–86400 |
| `TRADINGVIEW_BATCH_SIZE` | `1000` | Screener batch size, 25–1000 |
| `TRADINGVIEW_MISSING_RETRY_LIMIT` | `100` | Omitted symbols retried in batches of 25, 0–500 |
| `TRADINGVIEW_ESTIMATES_BATCH_SIZE` | `250` | Estimates session batch size, 25–500 |
| `TRADINGVIEW_ESTIMATES_CONCURRENCY` | `4` | Parallel Estimates sessions, 1–4 |
| `TRADINGVIEW_ESTIMATES_MISSING_TTL_SECONDS` | `900` | Confirmed missing series TTL, 60–86400 |

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
- `GET|PUT /api/v1/portfolio`
- `POST /api/v1/portfolio/save-as-etf`
- `GET /api/v1/securities/search?q=AAPL`
- `GET /api/v1/prices/quote?kind=etf&referenceId=ivv-us`
- `POST /api/v1/prices/quotes`
- `GET /api/v1/prices/fx?currency=EUR`
- `POST /api/v1/etf-creator`
- `GET|PATCH|DELETE /api/v1/local-etfs/:etfId`
- `PATCH /api/v1/local-etfs/:etfId/visibility` (owner only)
- `GET /api/v1/published-portfolios/:etfId` (fully public portfolios only)
- `GET /api/v1/metrics/overview?etfs=ivv-us,acwi-us`

Comparison excludes cash by default. Add `includeCash=true` to include it in
weight normalization, overlap, and active-sleeve calculations. Metrics Overview
accepts one to four distinct ETFs after reference resolution.

Portfolio and ETF editing routes require owner access, including their GET
endpoints. Public catalog and analysis routes exclude private ETFs and personal
amounts; exact published amounts use the dedicated published-portfolios route.

Add `refresh=true` to holdings, holdings analysis, comparison, portfolio, single
quote, or Metrics Overview requests to request fresh source data. Provider
failures can still return stale fallback data. The FX endpoint has no refresh
query option.

Batch listing quotes accept a JSON body with `quotes` entries containing `key`,
`securityId`, and `ticker` (up to 30 distinct keys), plus optional `refresh: true`.
Use canonical security IDs returned by the application. Request body contracts
for writes are defined in `src/app/api/v1`; this is an endpoint index, not a
complete API schema.

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
own local history from official source files. Data is indicative and does not
constitute investment advice.
