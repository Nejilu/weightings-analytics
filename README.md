# IndexLens

IndexLens is a local-first Next.js application for analysing ETF holdings,
comparing underlying exposures, building look-through portfolios, and creating
reusable ETFs from iShares source universes.

## Features

- Inspect one ETF or compare two ETFs by concentration, sector allocation,
  overlap, active sleeves, and ACWI-implied weighting distortion.
- Build long/short portfolios from ETFs and direct equities, including cash or
  borrowing in multiple currencies, then inspect gross or NAV exposure.
- Save portfolios as local ETFs or create rule-based, free-float-weighted ETFs.
- Fetch official iShares/BlackRock holdings and persist validated snapshots.
- Enrich constituents with TradingView fundamentals and consensus EPS series.
- Aggregate valuation, earnings, quality, size, income, and risk metrics with
  explicit data coverage and source freshness.

## Quick start

Requirements: Node.js 22.13 or newer and npm.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. The development launcher applies committed SQLite
migrations and idempotently seeds the ETF catalog before starting Next.js.

Use `npm ci` for a fresh checkout and stop if it reports an error. Do not copy or
cache `node_modules` between machines; the GitHub Actions workflow caches only
npm downloads and rebuilds dependencies from `package-lock.json` on every run.

## Production-like local run

```bash
npm ci
npm run build
npm run start
```

The application is served at `http://localhost:3000`. The standalone launcher
keeps database and migration paths anchored to the project root and stages the
required static assets before starting the generated server. Check
`/api/health` to verify both the application and database.

## Configuration

Copy `.env.example` to `.env` only when overriding a default.

| Variable | Default | Valid values / purpose |
| --- | ---: | --- |
| `DATABASE_PATH` | `.data/index-lens.sqlite` | Durable SQLite database path |
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
backups are ignored by Git and survive rebuilds or deletion of `.next`.

## Common commands

```bash
npm test                 # unit, contract, migration, audit, and launcher tests
npm run typecheck        # TypeScript validation
npm run lint             # ESLint
npm run db:setup         # apply migrations and seed the catalog
npm run db:stats         # display database size and row counts
npm run db:backup        # create a safe backup in .data/backups
npm run db:audit-mappings -- --strict --breakdown
```

The mapping audit opens SQLite read-only. It checks current provider mappings,
provenance, metadata, identity consistency, unresolved weight, duplicates, and
orphaned references. Add `--json` for machine-readable output.

Import a legacy TradingView mapping database once with:

```bash
npm run db:import-tradingview-mappings -- path/to/stocks.sqlite
```

## API

The main endpoints are:

- `GET /api/health`
- `GET /api/v1/catalog`
- `GET /api/v1/holdings/:ticker`
- `GET /api/v1/holdings/:ticker/analysis`
- `GET /api/v1/compare?left=IVV&right=ACWI`
- `GET|PUT /api/v1/portfolio`
- `POST /api/v1/portfolio/save-as-etf`
- `GET /api/v1/securities/search?q=AAPL`
- `GET /api/v1/prices/quote`
- `POST /api/v1/etf-creator`
- `GET|PATCH|DELETE /api/v1/local-etfs/:etfId`
- `GET /api/v1/metrics/overview?etfs=ivv-us,acwi-us`

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
and metric contracts that must remain stable. That file is the only detailed
technical reference; completed plans and chronological review logs are kept in
Git history instead of active documentation.

No demonstration holdings dataset is included. Each installation builds its
own local history from official source files. Data is indicative and does not
constitute investment advice.
