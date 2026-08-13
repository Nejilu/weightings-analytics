# IndexLens

IndexLens is a Next.js application for analysing ETF holdings, comparing
underlying exposures, building look-through portfolios and creating reusable
local ETFs from iShares source universes.

## Development

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

`npm run dev` applies the committed SQLite migrations and idempotently seeds
the ETF catalog before starting Next.js. The durable database is stored at
`.data/index-lens.sqlite` by default.

## Local production deployment

```bash
npm ci
npm run build
npm run start
```

The application is served at `http://localhost:3000`. The `start` script uses a
small launcher that runs the generated `.next/standalone/server.js` from the
project root, so relative SQLite paths and migrations remain stable even when
the command is invoked from another directory. Direct standalone launches also
anchor relative database paths back to the project root. Use `/api/health` to
check that both the application and its database are operational. A future
Docker image can use the same commands, migrations and persistence layer.

## Local persistence

IndexLens uses Drizzle ORM with `better-sqlite3`. Set `DATABASE_PATH` in a
local `.env` file to move the database without changing application code:

```env
DATABASE_PATH=.data/index-lens.sqlite
DRIZZLE_MIGRATIONS_PATH=drizzle
HOLDINGS_CACHE_TTL_SECONDS=86400
MARKET_PRICE_TTL_SECONDS=86400
MARKET_PRICE_CONCURRENCY=4
HOLDINGS_REFRESH_CONCURRENCY=4
TRADINGVIEW_METRICS_TTL_SECONDS=86400
TRADINGVIEW_METRICS_MISSING_TTL_SECONDS=900
TRADINGVIEW_BATCH_SIZE=1000
TRADINGVIEW_MISSING_RETRY_LIMIT=100
TRADINGVIEW_ESTIMATES_BATCH_SIZE=250
TRADINGVIEW_ESTIMATES_CONCURRENCY=4
TRADINGVIEW_ESTIMATES_MISSING_TTL_SECONDS=900
```

`MARKET_PRICE_CONCURRENCY` accepte une valeur de 1 à 8 et vaut 4 par défaut,
afin de limiter les pointes de requêtes Yahoo lorsque le portefeuille contient
beaucoup de lignes.

`HOLDINGS_REFRESH_CONCURRENCY` accepte également une valeur de 1 à 8 et vaut 4
par défaut. Il borne les téléchargements iShares déclenchés par un portefeuille
synthétique contenant plusieurs ETF.

`TRADINGVIEW_ESTIMATES_CONCURRENCY` accepte une valeur de 1 à 4 et vaut 4 par
défaut. Le flux WebSocket a été sondé sur l’univers IEMG : quatre sessions
réduisent le temps du premier calcul sans baisse de couverture ni échec observé.
Réduire cette valeur reste possible si une instance rencontre des limites ou
des timeouts TradingView.

`TRADINGVIEW_ESTIMATES_MISSING_TTL_SECONDS` conserve temporairement les
symboles pour lesquels TradingView n'expose aucune série consensus (15 minutes
par défaut, borné entre 60 secondes et 24 heures). Cela garde l'avertissement
de couverture du panel sans relancer immédiatement les mêmes lots vides.

`TRADINGVIEW_METRICS_MISSING_TTL_SECONDS` applique la même protection aux
champs Screener absents, séparément pour chaque symbole et métrique. Les
erreurs de lot ne sont pas mémorisées négativement afin de rester retentables.
Après une réponse confirmant l’absence, ces marqueurs sont aussi persistés
dans `provider_negative_cache` ; ils sont réhydratés au redémarrage et
supprimés dès que TradingView restitue le champ ou la série. Cette table ne
contient jamais un timeout ou une erreur de transport. Le runtime expose un
seul cache négatif borné, avec deux instances explicites pour les séries EPS et
les champs Screener ; la table SQLite en est uniquement la persistance.

`TRADINGVIEW_BATCH_SIZE` regroupe jusqu'à 1 000 symboles par appel Screener
(valeur par défaut), après validation entre 25 et 1 000. Un réglage plus petit
reste possible si les limites du fournisseur l'exigent.

`TRADINGVIEW_MISSING_RETRY_LIMIT` borne à 100 par défaut le nombre de symboles
omis par un lot Screener qui sont rejoués dans des lots de 25. Cette seconde
chance récupère les omissions transitoires sans multiplier les appels pour un
univers complet ; la valeur acceptée va de 0 à 500.

Les libellés iShares `Nyse Euronext - Euronext Paris/Brussels/Lisbon` sont
résolus vers `EURONEXT:` avant le fallback générique `NYSE:` afin de conserver
la place de cotation primaire des actions européennes.

Les aliases TradingView confirmés par description (notamment `WALMEX*` →
`WALMEX`, `PE&OLES*` → `PE_OLES`, les classes chiliennes `_A/_B`, les formats
BMV avec `/`, les REIT indiennes `.RR`, et `KOSDAQ` → `KRX`) sont testés avant
d’être persistés ; les candidats non confirmés restent exclus des agrégats.
Les tickers numériques HKEX avec zéros à gauche essaient aussi la forme
TradingView normalisée (`0700` → `700`) après vérification provider.

Chaque résolution persistée conserve aussi sa provenance (`exact_exchange`,
`confirmed_alias`, `country_fallback` ou `cross_exchange`), le score de nom et
les alternatives testées. Un fallback pays sans ticker ou rapprochement de nom
suffisant est laissé non résolu afin d’éviter de transformer une correspondance
ambiguë en fondamentaux exploitables.
Un candidat `exact_exchange` dont l’observation provider contredit à la fois le
ticker normalisé et le nom est également invalidé ; une erreur de transport
conserve toutefois le fallback stale, explicitement signalé.
Lorsque l’export iShares omet l’ISIN, l’identité de secours inclut aussi le
ticker normalisé afin de ne pas fusionner deux classes de cotation portant le
même nom.
Le hash de snapshot est versionné pour forcer la relecture des snapshots
legacy après une évolution de cette normalisation.

Relative paths resolve from the project root. The database and its WAL files
are ignored by Git, so commits, rebuilds and deletion of `.next` do not remove
stored holdings.

`DRIZZLE_MIGRATIONS_PATH` is optional for the normal launcher. It can be set to
an absolute path when the standalone server is embedded in a separate runtime
image where the source `drizzle/` directory is mounted elsewhere.

Useful commands:

```bash
npm test           # processor, mapping-audit, migration and standalone asset tests
npm run db:setup   # apply migrations and seed the ETF catalog
npm run db:stats   # show row counts and database size
npm run db:audit-mappings -- --strict  # verify mapping provenance, weights and identity
npm run test:mappings-audit  # run the read-only audit fixture tests
npm run db:backup  # create a safe SQLite backup
```

`db:audit-mappings` opens SQLite read-only and reports the latest equity
snapshot for every active ETF, mapping coverage by weight, provenance counts,
and source/Estimates identity mismatches. `--strict` exits non-zero when a
resolved mapping has no provenance, metadata is malformed, or a persisted
provider symbol disagrees with the current mapping. Add `--breakdown` to print
the country/exchange coverage (including the weight covered), or `--json` for a
machine-readable report; the command does not migrate or modify the database.

La documentation active est volontairement limitée à trois fichiers :

- [`docs/iterative-agent-work-plan.md`](docs/iterative-agent-work-plan.md), le
  plan final dirigé et son avancement ;
- [`docs/metrics-overview-architecture.md`](docs/metrics-overview-architecture.md),
  les contrats réellement exécutés ;
- [`docs/engineering-review.md`](docs/engineering-review.md), le bilan condensé
  des décisions, preuves, essais rejetés et risques ouverts.

Les anciens journaux append-only ont été retirés afin que les agents mettent à
jour un état courant au lieu d’accumuler des comptes rendus redondants.

Legacy TradingView resolution databases can be imported once, before their
source folder is retired:

```bash
npm run db:import-tradingview-mappings -- path/to/stocks.sqlite
```

After a code update, run:

```bash
git pull
npm ci
npm run db:setup
npm run build
npm run start
```

`db:setup` is safe to run repeatedly and does not delete snapshots. Backups
are written below `.data/backups/`.

`npm start` stages `.next/static` and `public` into the generated standalone
layout before launching the server, so the production UI keeps its CSS and
browser assets as well as its API routes.

## Current scope

- Select an underlying index, then a US or UCITS ETF wrapper.
- Ingest official iShares holdings payloads on the server, preferring BlackRock
  product data because it exposes ISIN, SEDOL and CUSIP, with the regional CSV
  retained as a resilient fallback.
- Persist normalized securities and holdings snapshots in local SQLite.
- Resolve every source row onto one canonical security identity. ISIN is
  preferred, then SEDOL, CUSIP and finally a conservative name+ticker fallback.
  Legacy `NAME:*` identities are transactionally reconciled only when one
  unambiguous listing or strong-identifier target exists; holdings, provider
  mappings, metrics, prices and portfolio positions are repointed together.
- Reuse SQLite snapshots for 24 hours and return the latest persisted snapshot
  as stale data when iShares is temporarily unavailable. SQLite is the only
  holdings cache: after expiry, the provider request uses `no-store` so an old
  Next.js revalidation response cannot renew a stale snapshot.
- Open a single-ETF holdings deep dive by default, with concentration, sector
  allocation, the complete security table and an optional second-ETF comparison.
- Measure weighting distortion against ACWI-implied free-float weights on the
  common security universe. The score is `50 × Σ|actual - counterfactual|` after
  renormalising both sides to 100%; coverage and missing securities remain visible.
- Use pure, reusable processors for holdings analysis, weighted overlap and
  active sleeves. Large security tables initially render 50 rows while retaining
  an accessible control for the complete result set.
- Build and persist a mixed ETF/direct-stock portfolio, using ACWI holdings as
  the searchable stock universe. Long and short positions can be entered as a
  USD value or a number of shares; explicit positive cash and negative borrowing
  can be recorded in 14 currencies and converted to USD.
- Persist Yahoo Finance market prices and FX conversions for 24 hours, with the
  latest stored quote used as a stale fallback when a refresh fails.
- Offer accumulating iShares share classes in Portfolio only. Each keeps its own
  Yahoo unit-price symbol while reusing the canonical distributing ETF holdings
  snapshot, so no duplicate iShares holdings download or snapshot is created.
- Label iShares selector entries by underlying index, distribution policy and a
  final parenthesized ticker, rather than by the issuer product name.
- Expand every ETF sleeve, merge duplicate direct and indirect exposures, and
  rank the resulting synthetic portfolio at security level. The interface can
  switch between gross-normalised equity exposure and signed NAV exposure with
  cash and implicit leveraged-ETF financing included.
- Save the share-based portfolio and cash definition as a reusable local ETF.
  Its component weights follow current market values, while its security-level
  holdings are recalculated from the latest persisted source ETF compositions
  whenever it is selected.
- Select saved portfolio ETFs in the standard holdings and ETF comparison
  workflows under the `Saved portfolios` catalog group.
- Create a free-float-weighted ETF from any registered source universe (ACWI is
  selected by default) using country, sector, supported-ETF overlap and manual
  inclusion/exclusion rules. The visible final recipe is automatic matches plus
  manual additions minus exclusions. The selected security list is persisted;
  available source weights are recalculated and normalised on every read from
  the latest persisted source snapshot.
- Reload, edit and delete custom or portfolio ETFs without exposing those
  lifecycle operations for official catalog ETFs. Deletion transactionally
  removes the local definition and its private snapshots while preserving
  shared securities and official data.
- Use a persistent light or dark interface theme.
- Resolve constituent listings to TradingView symbols using the iShares exchange,
  imported ticker disambiguation rules and country fallbacks for legacy snapshots.
- Fetch valuation, earnings, quality, size, income and risk fields through
  grouped TradingView Screener requests, and retrieve EPS consensus histories
  through grouped TradingView quote sessions.
- Build an estimates-only earnings series from the consensus attached to the four
  latest reported quarters and the current consensus for the next four quarters.
  Reported EPS and reconstructed adjusted EPS are never used in P/E or growth.
- Keep derived EPS/P-E values only when their persisted consensus series matches
  the current TradingView symbol; incompatible or incomplete series are removed
  from aggregates instead of being presented as stale-but-valid fundamentals.
- Distinguish incomplete provider coverage (`partial`) from genuinely stale
  fallback data (`stale`), so normal Screener/Estimates gaps remain cacheable
  without hiding their metric-by-metric coverage warnings.
- Calculate each security's P/E from its local-currency price divided by rolling
  consensus EPS. ETF P/E, P/E TTM, P/B, P/S, EV/EBITDA and P/FCF use
  holding-weighted harmonic means on positive ratios. Operating margin, ROIC,
  revenue growth, diluted EPS growth, yield, ROE, debt/equity and beta use
  covered-weight arithmetic means; market capitalisation uses a weighted median.
  Every aggregate discloses coverage and its source capture window.
- Expose versioned endpoints: `/api/v1/catalog`,
  `/api/v1/holdings/:ticker`, `/api/v1/holdings/:ticker/analysis` and
  `/api/v1/compare?left=IVV&right=ACWI`, plus `/api/v1/portfolio` and
  `/api/v1/securities/search?q=AAPL`. Market quotes are exposed through
  `/api/v1/prices/quote`, and portfolio ETFs are created through
  `/api/v1/portfolio/save-as-etf`. Custom ETFs are created through
  `/api/v1/etf-creator`; `/api/v1/local-etfs/:etfId` loads, updates or deletes
  editable local definitions.
- Expose holding-weighted constituent metrics through
  `/api/v1/metrics/overview?etfs=ivv-us,acwi-us`.
- Probe live historical and forward estimate coverage, including non-USD primary
  listings, with `npm run test:tradingview-estimates`.
- Provide versioned Drizzle migrations for the local database.

## Architecture

```text
src/
  app/                  Next.js routes and API handlers
  components/           reusable interface panels
  data/
    providers/          external source adapters
    services/           persistence and refresh orchestration
  domain/
    processors/         pure calculations independent of the interface
  db/
    repositories/       isolated persistence queries
    client.ts           SQLite connection and runtime configuration
    schema.ts           versioned relational model
scripts/                migration, seed, stats and backup commands
drizzle/                committed SQL migrations
.data/                  local database and backups, ignored by Git
```

The catalog is seeded from the versioned source manifest. Holdings are fetched
on first access, validated, deduplicated and inserted transactionally. Later
requests read SQLite first; iShares is contacted with a fresh `no-store`
request only after the configured TTL expires. If refresh fails, the latest
persisted snapshot remains available.
HTTP 503 is returned only when no snapshot has ever been stored for the ETF.

No demonstration holdings dataset is included. Each installation builds its
own local history from official iShares source files.

Data is indicative and does not constitute investment advice.
