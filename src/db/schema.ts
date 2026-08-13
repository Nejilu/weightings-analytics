import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const benchmarks = sqliteTable(
  "benchmarks",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    region: text("region"),
    description: text("description"),
    methodologyUrl: text("methodology_url"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("benchmarks_name_provider_uq").on(table.name, table.provider)],
);

export const etfs = sqliteTable(
  "etfs",
  {
    id: text("id").primaryKey(),
    ticker: text("ticker").notNull(),
    isin: text("isin").notNull(),
    name: text("name").notNull(),
    issuer: text("issuer").notNull(),
    benchmarkId: text("benchmark_id")
      .notNull()
      .references(() => benchmarks.id),
    wrapper: text("wrapper").notNull(),
    domicile: text("domicile").notNull(),
    exchange: text("exchange").notNull(),
    tradingCurrency: text("trading_currency").notNull(),
    distributionPolicy: text("distribution_policy").notNull(),
    ter: real("ter"),
    productUrl: text("product_url").notNull(),
    holdingsUrl: text("holdings_url").notNull(),
    priceSymbol: text("price_symbol"),
    fundType: text("fund_type").notNull().default("physical"),
    portfolioId: text("portfolio_id"),
    description: text("description"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    metadataJson: text("metadata_json", { mode: "json" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("etfs_ticker_exchange_uq").on(table.ticker, table.exchange),
    uniqueIndex("etfs_isin_uq").on(table.isin),
    index("etfs_benchmark_idx").on(table.benchmarkId),
  ],
);

export const securities = sqliteTable(
  "securities",
  {
    id: text("id").primaryKey(),
    isin: text("isin"),
    primaryTicker: text("primary_ticker"),
    name: text("name").notNull(),
    assetClass: text("asset_class"),
    sector: text("sector"),
    industry: text("industry"),
    country: text("country"),
    currency: text("currency"),
    identifiersJson: text("identifiers_json", { mode: "json" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("securities_isin_uq").on(table.isin),
    index("securities_ticker_idx").on(table.primaryTicker),
  ],
);

export const securityProviderSymbols = sqliteTable(
  "security_provider_symbols",
  {
    provider: text("provider").notNull(),
    securityId: text("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "cascade" }),
    providerSymbol: text("provider_symbol"),
    status: text("status").notNull(),
    confidence: real("confidence"),
    lastVerifiedAt: text("last_verified_at").notNull(),
    metadataJson: text("metadata_json", { mode: "json" }),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.securityId] }),
    index("security_provider_symbols_symbol_idx").on(
      table.provider,
      table.providerSymbol,
    ),
  ],
);

export const providerNegativeCache = sqliteTable(
  "provider_negative_cache",
  {
    provider: text("provider").notNull(),
    cacheKind: text("cache_kind").notNull(),
    providerSymbol: text("provider_symbol").notNull(),
    metricKey: text("metric_key").notNull().default(""),
    expiresAt: integer("expires_at").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({
      columns: [
        table.provider,
        table.cacheKind,
        table.providerSymbol,
        table.metricKey,
      ],
    }),
    index("provider_negative_cache_expiry_idx").on(table.expiresAt),
    index("provider_negative_cache_symbol_idx").on(
      table.provider,
      table.providerSymbol,
    ),
  ],
);

export const holdingSnapshots = sqliteTable(
  "holding_snapshots",
  {
    id: text("id").primaryKey(),
    etfId: text("etf_id")
      .notNull()
      .references(() => etfs.id),
    asOf: text("as_of").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceHash: text("source_hash"),
    sourceStatus: text("source_status").notNull(),
    totalWeight: real("total_weight").notNull(),
    rowCount: integer("row_count").notNull(),
    rawMetadataJson: text("raw_metadata_json", { mode: "json" }),
  },
  (table) => [
    uniqueIndex("holding_snapshots_etf_asof_hash_uq").on(
      table.etfId,
      table.asOf,
      table.sourceHash,
    ),
    index("holding_snapshots_latest_idx").on(table.etfId, table.asOf),
  ],
);

export const holdings = sqliteTable(
  "holdings",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => holdingSnapshots.id, { onDelete: "cascade" }),
    securityId: text("security_id")
      .notNull()
      .references(() => securities.id),
    weight: real("weight").notNull(),
    quantity: real("quantity"),
    marketValue: real("market_value"),
    localPrice: real("local_price"),
    currency: text("currency"),
    sourceTicker: text("source_ticker"),
    sourceRowJson: text("source_row_json", { mode: "json" }),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.securityId] }),
    index("holdings_security_idx").on(table.securityId),
  ],
);

export const portfolios = sqliteTable("portfolios", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseCurrency: text("base_currency").notNull().default("USD"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const portfolioItems = sqliteTable(
  "portfolio_items",
  {
    id: text("id").primaryKey(),
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    assetType: text("asset_type").notNull(),
    etfId: text("etf_id").references(() => etfs.id),
    securityId: text("security_id").references(() => securities.id),
    allocationWeight: real("allocation_weight").notNull(),
    quantity: real("quantity"),
    inputMode: text("input_mode"),
    inputAmount: real("input_amount"),
    initialPriceUsd: real("initial_price_usd"),
    initialValueUsd: real("initial_value_usd"),
    priceSymbol: text("price_symbol"),
    priceCurrency: text("price_currency"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("portfolio_items_portfolio_idx").on(table.portfolioId),
    uniqueIndex("portfolio_items_etf_uq").on(table.portfolioId, table.etfId),
    uniqueIndex("portfolio_items_security_uq").on(
      table.portfolioId,
      table.securityId,
    ),
  ],
);

export const portfolioCashPositions = sqliteTable(
  "portfolio_cash_positions",
  {
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    amount: real("amount").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.portfolioId, table.currency] }),
    index("portfolio_cash_positions_portfolio_idx").on(table.portfolioId),
  ],
);

export const marketPrices = sqliteTable(
  "market_prices",
  {
    id: text("id").primaryKey(),
    assetType: text("asset_type").notNull(),
    assetId: text("asset_id").notNull(),
    providerSymbol: text("provider_symbol").notNull(),
    price: real("price").notNull(),
    currency: text("currency").notNull(),
    fxToUsd: real("fx_to_usd").notNull(),
    priceUsd: real("price_usd").notNull(),
    asOf: text("as_of").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    source: text("source").notNull(),
  },
  (table) => [
    uniqueIndex("market_prices_asset_uq").on(table.assetType, table.assetId),
    index("market_prices_symbol_idx").on(table.providerSymbol),
  ],
);

export const fxRates = sqliteTable("fx_rates", {
  currency: text("currency").primaryKey(),
  providerSymbol: text("provider_symbol").notNull(),
  rateToUsd: real("rate_to_usd").notNull(),
  asOf: text("as_of").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  source: text("source").notNull(),
});

export const metricDefinitions = sqliteTable(
  "metric_definitions",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    entityType: text("entity_type").notNull(),
    valueType: text("value_type").notNull(),
    unit: text("unit"),
    frequency: text("frequency"),
    version: integer("version").notNull().default(1),
    formulaJson: text("formula_json", { mode: "json" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("metric_definitions_key_version_uq").on(table.key, table.version),
  ],
);

export const metricObservations = sqliteTable(
  "metric_observations",
  {
    id: text("id").primaryKey(),
    metricDefinitionId: text("metric_definition_id")
      .notNull()
      .references(() => metricDefinitions.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    asOf: text("as_of").notNull(),
    valueNumber: real("value_number"),
    valueText: text("value_text"),
    valueJson: text("value_json", { mode: "json" }),
    source: text("source"),
    capturedAt: text("captured_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("metric_observations_natural_uq").on(
      table.metricDefinitionId,
      table.entityType,
      table.entityId,
      table.asOf,
    ),
    index("metric_observations_entity_idx").on(table.entityType, table.entityId),
    index("metric_observations_latest_idx").on(
      table.metricDefinitionId,
      table.entityType,
      table.entityId,
      table.capturedAt,
    ),
  ],
);
