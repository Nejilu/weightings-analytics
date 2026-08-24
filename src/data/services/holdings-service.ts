import "server-only";

import { createHash } from "node:crypto";

import {
  ISHARES_HOLDINGS_HASH_PREFIX,
  parseIsharesHoldingsCsv,
} from "@/data/providers/ishares-csv";
import {
  assertPlausibleIsharesHoldingsCount,
  fetchIsharesHoldingsFile,
  isPlausibleIsharesHoldingsCount,
} from "@/data/providers/ishares-source";
import {
  findLatestSnapshot,
  loadSnapshot,
  persistSnapshot,
} from "@/db/repositories/holdings-repository";
import { findDynamicCustomEtfDefinition } from "@/db/repositories/local-etf-repository";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { databasePath } from "@/db/client";
import {
  findEtfById,
  findEtfByReference,
  findSecuritiesByIds,
} from "@/db/repositories/catalog-repository";
import {
  anchorPortfolioQuantities,
  loadPortfolioById,
} from "@/db/repositories/portfolio-repository";
import type { HoldingsSnapshot } from "@/domain/etf";
import { deriveDynamicCreatorHoldings } from "@/domain/etf-creator";
import { analyzePortfolio } from "@/domain/processors/analyze-portfolio";
import { deriveMarketValueHoldings } from "@/domain/processors/derive-market-value-holdings";
import { normalizeHoldingWeights } from "@/domain/processors/normalize-holding-weights";
import {
  valueCashPositions,
  valuePortfolioItems,
} from "./market-price-service";
import { mapWithConcurrency } from "@/domain/async-utils";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24;
const DEFAULT_REFRESH_CONCURRENCY = 4;
const inFlightRefreshes = new Map<
  string,
  Promise<HoldingsSnapshot>
>();

export interface RefreshOptions {
  forceRefresh?: boolean;
}

function cacheTtlSeconds() {
  const configured = Number(process.env.HOLDINGS_CACHE_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TTL_SECONDS;
}

export function holdingsRefreshConcurrency(): number {
  const configured = Number(process.env.HOLDINGS_REFRESH_CONCURRENCY);
  return Number.isInteger(configured) && configured >= 1 && configured <= 8
    ? configured
    : DEFAULT_REFRESH_CONCURRENCY;
}

function isFresh(fetchedAt: string, ttlSeconds: number): boolean {
  const fetchedAtMs = Date.parse(fetchedAt);
  return (
    Number.isFinite(fetchedAtMs) &&
    Date.now() - fetchedAtMs < ttlSeconds * 1000
  );
}

export class HoldingsUnavailableError extends Error {
  readonly ticker: string;
  readonly reference: string;

  constructor(ticker: string, reference: string, cause?: unknown) {
    super(
      cause instanceof Error
        ? `Holdings for ${ticker} are unavailable: ${cause.message}`
        : `Holdings for ${ticker} are unavailable.`,
    );
    this.name = "HoldingsUnavailableError";
    this.ticker = ticker;
    this.reference = reference;
  }
}

async function buildPortfolioEtfSnapshot(
  etf: NonNullable<ReturnType<typeof findEtfByReference>>,
  options: RefreshOptions,
): Promise<HoldingsSnapshot> {
  if (!etf.portfolioId) {
    throw new Error(`Portfolio definition for ${etf.ticker} is missing.`);
  }
  const portfolio = loadPortfolioById(etf.portfolioId);
  if (!portfolio || portfolio.items.length === 0) {
    throw new Error(`Portfolio definition for ${etf.ticker} is empty.`);
  }
  const cashPositions = await valueCashPositions(portfolio.cashPositions, options);
  const cashValueUsd = cashPositions.reduce(
    (sum, position) => sum + (position.valueUsd ?? 0),
    0,
  );
  const valuedPortfolio = await valuePortfolioItems(
    portfolio.items,
    cashValueUsd,
    options,
  );
  if (portfolio.items.some((item) => !item.quantity)) {
    anchorPortfolioQuantities(portfolio.id, valuedPortfolio.items);
  }

  const etfItems = valuedPortfolio.items.filter((item) => item.kind === "etf");
  for (const item of etfItems) {
    const component = findEtfById(item.referenceId);
    if (!component || component.fundType === "portfolio") {
      throw new Error(
        `${etf.ticker} contains an unsupported synthetic ETF component.`,
      );
    }
  }

  const snapshots = await mapWithConcurrency(
    etfItems,
    holdingsRefreshConcurrency(),
    (item) => getHoldingsSnapshot(item.referenceId, options),
  );
  const directSecurities = findSecuritiesByIds(
    valuedPortfolio.items
      .filter((item) => item.kind === "security")
      .map((item) => item.referenceId),
  );
  // Provider mappings and metrics depend on durable security IDs. Economic
  // grouping belongs to the portfolio display model, never this snapshot.
  const canonicalAnalysis = analyzePortfolio({
    items: valuedPortfolio.items,
    etfSnapshots: new Map(
      snapshots.map((snapshot) => [snapshot.etf.id, snapshot]),
    ),
    directSecurities,
    cashWeight: cashValueUsd / valuedPortfolio.totalMarketValueUsd * 100,
  });
  const explicitCashHoldings = cashPositions.flatMap((position) => {
    const valueUsd = position.valueUsd ?? 0;
    if (valueUsd <= 0) return [];
    return [{
      securityId: `CASH:${position.currency}`,
      ticker: position.currency,
      name: `${position.currency} CASH`,
      sector: "Cash & equivalents",
      assetClass: "Cash",
      country: "Not applicable",
      currency: position.currency,
      marketValue: valueUsd,
      weight: valueUsd / valuedPortfolio.totalMarketValueUsd * 100,
    }];
  });
  const sourceStatus =
    snapshots.some((snapshot) => snapshot.sourceStatus === "stale")
      ? "stale"
      : snapshots.some((snapshot) => snapshot.sourceStatus === "live")
        ? "live"
        : "cached";
  const asOf =
    snapshots
      .map((snapshot) => snapshot.asOf)
      .sort((left, right) => left.localeCompare(right))[0] ??
    new Date().toISOString().slice(0, 10);

  return {
    etf,
    asOf,
    fetchedAt: new Date().toISOString(),
    sourceStatus,
    sourceUrl: etf.holdingsUrl,
    cacheTtlHours: cacheTtlSeconds() / 3600,
    holdings: [
      ...canonicalAnalysis.positions.map((position) => ({
        securityId: position.securityId,
        ticker: position.ticker,
        name: position.name,
        sector: position.sector,
        assetClass: position.assetClass,
        country: position.country,
        weight: position.weight,
      })),
      ...explicitCashHoldings,
    ],
  };
}

async function buildDynamicCustomEtfSnapshot(
  etf: NonNullable<ReturnType<typeof findEtfByReference>>,
  options: RefreshOptions,
): Promise<HoldingsSnapshot> {
  const definition = findDynamicCustomEtfDefinition(etf.id);
  if (!definition) {
    throw new Error(`Dynamic custom ETF definition for ${etf.ticker} is missing.`);
  }
  if (definition.sourceEtfId === etf.id) {
    throw new Error(`${etf.ticker} cannot derive its holdings from itself.`);
  }

  const ttlHours = cacheTtlSeconds() / 3600;
  const latest = findLatestSnapshot(etf.id);
  let source: HoldingsSnapshot;
  try {
    source = await getHoldingsSnapshot(definition.sourceEtfId, options);
  } catch (error) {
    if (latest) return loadSnapshot(etf, latest, "stale", ttlHours);
    throw new HoldingsUnavailableError(etf.ticker, etf.id, error);
  }

  const derived = deriveDynamicCreatorHoldings(
    source.holdings,
    definition.selectedSecurities,
  );
  if (derived.holdings.length === 0) {
    throw new Error(
      `None of the selected ${etf.ticker} securities are available in ${source.etf.ticker}.`,
    );
  }
  const fetchedAt = new Date().toISOString();
  const sourceHash = createHash("sha256")
    .update(
      JSON.stringify({
        model: "dynamic-source-free-float",
        sourceEtfId: source.etf.id,
        sourceAsOf: source.asOf,
        selectedSecurities: definition.selectedSecurities,
        holdings: derived.holdings.map((holding) => [
          holding.securityId,
          holding.weight,
        ]),
      }),
    )
    .digest("hex");
  const stored = persistSnapshot({
    etf,
    asOf: source.asOf,
    fetchedAt,
    sourceUrl: source.sourceUrl,
    sourceHash,
    holdings: derived.holdings,
  });
  const snapshot = loadSnapshot(
    etf,
    stored,
    source.sourceStatus,
    ttlHours,
  );
  return derived.missingSecurities.length > 0
    ? {
        ...snapshot,
        constituentCoverage: {
          used: derived.holdings.length,
          total: definition.selectedSecurities.length,
          missingTickers: derived.missingSecurities.map(
            (security) => security.ticker,
          ),
        },
      }
    : snapshot;
}

async function buildDerivedEtfSnapshot(
  etf: NonNullable<ReturnType<typeof findEtfByReference>>,
  options: RefreshOptions,
): Promise<HoldingsSnapshot> {
  const definition = etf.derivedHoldings;
  if (!definition) {
    throw new Error(`Derived holdings definition for ${etf.ticker} is missing.`);
  }
  if (definition.sourceEtfId === etf.id) {
    throw new Error(`${etf.ticker} cannot derive its holdings from itself.`);
  }

  const ttlHours = cacheTtlSeconds() / 3600;
  const latest = findLatestSnapshot(etf.id);
  let source: HoldingsSnapshot;
  try {
    source = await getHoldingsSnapshot(definition.sourceEtfId, options);
  } catch (error) {
    if (latest) {
      const snapshot = loadSnapshot(etf, latest, "stale", ttlHours);
      if (
        definition.model === "component-market-value" &&
        latest.rowCount < definition.componentTickers.length
      ) {
        return {
          ...snapshot,
          constituentCoverage: {
            used: latest.rowCount,
            total: definition.componentTickers.length,
            missingTickers: [],
          },
        };
      }
      return snapshot;
    }
    throw new HoldingsUnavailableError(etf.ticker, etf.id, error);
  }

  let constituentCoverage: HoldingsSnapshot["constituentCoverage"];
  const derivedHoldings = (() => {
    if (definition.model === "scaled-source") {
      return normalizeHoldingWeights(source.holdings).map((holding) => ({
        ...holding,
        weight: holding.weight * definition.exposureMultiplier,
        marketValue: undefined,
      }));
    }

    const derived = deriveMarketValueHoldings(
      source.holdings,
      definition.componentTickers,
      {
        missingComponentPolicy: definition.missingComponentPolicy,
        componentSecurityIds: definition.componentSecurityIds,
      },
    );
    if (derived.missingTickers.length > 0) {
      constituentCoverage = {
        used: derived.holdings.length,
        total: definition.componentTickers.length,
        missingTickers: derived.missingTickers,
      };
    }
    return derived.holdings;
  })();
  const fetchedAt = new Date().toISOString();
  const sourceHash = createHash("sha256")
    .update(
      JSON.stringify({
        model: definition.model,
        sourceEtfId: source.etf.id,
        sourceAsOf: source.asOf,
        definition,
        holdings: derivedHoldings.map((holding) => [
          holding.ticker,
          holding.weight,
          holding.marketValue ?? null,
        ]),
      }),
    )
    .digest("hex");
  const stored = persistSnapshot({
    etf,
    asOf: source.asOf,
    fetchedAt,
    sourceUrl: definition.compositionSourceUrl,
    sourceHash,
    holdings: derivedHoldings,
  });

  const snapshot = loadSnapshot(
    etf,
    stored,
    source.sourceStatus,
    ttlHours,
  );
  return constituentCoverage
    ? { ...snapshot, constituentCoverage }
    : snapshot;
}

async function buildSharedHoldingsSnapshot(
  etf: NonNullable<ReturnType<typeof findEtfByReference>>,
  options: RefreshOptions,
): Promise<HoldingsSnapshot> {
  const sourceEtfId = etf.holdingsSourceEtfId;
  if (!sourceEtfId || sourceEtfId === etf.id) {
    throw new Error(`Invalid shared holdings source for ${etf.ticker}.`);
  }

  const source = await getHoldingsSnapshot(sourceEtfId, options);
  return {
    ...source,
    etf,
  };
}

async function refreshHoldings(
  etf: NonNullable<ReturnType<typeof findEtfByReference>>,
  options: RefreshOptions,
): Promise<HoldingsSnapshot> {
  if (etf.fundType === "portfolio") {
    return buildPortfolioEtfSnapshot(etf, options);
  }
  if (etf.fundType === "custom") {
    return buildDynamicCustomEtfSnapshot(etf, options);
  }
  if (etf.holdingsSourceEtfId) {
    return buildSharedHoldingsSnapshot(etf, options);
  }
  if (etf.derivedHoldings) {
    return buildDerivedEtfSnapshot(etf, options);
  }

  const ttlSeconds = cacheTtlSeconds();
  const ttlHours = ttlSeconds / 3600;
  const latest = findLatestSnapshot(etf.id);
  const latestIsPlausible = latest
    ? isPlausibleIsharesHoldingsCount(etf.id, latest.rowCount)
    : false;
  const latestUsesCurrentNormalization = Boolean(
    latest?.sourceHash?.startsWith(ISHARES_HOLDINGS_HASH_PREFIX),
  );

  if (
    !options.forceRefresh &&
    latest &&
    latestIsPlausible &&
    latestUsesCurrentNormalization &&
    isFresh(latest.fetchedAt, ttlSeconds)
  ) {
    return loadSnapshot(etf, latest, "cached", ttlHours);
  }

  try {
    // The persisted snapshot is the only TTL boundary. Once it expires, the
    // provider request must be fresh or an old Next fetch-cache response can
    // be written back with a new fetchedAt timestamp.
    const fetched = await fetchIsharesHoldingsFile(etf);
    const parsed = parseIsharesHoldingsCsv(fetched.raw);
    assertPlausibleIsharesHoldingsCount(etf, parsed.holdings.length);
    const fetchedAt = new Date().toISOString();
    const stored = persistSnapshot({
      etf,
      asOf: parsed.asOf,
      fetchedAt,
      sourceUrl: fetched.sourceUrl,
      sourceHash: `${ISHARES_HOLDINGS_HASH_PREFIX}${createHash("sha256")
        .update(fetched.raw)
        .digest("hex")}`,
      holdings: parsed.holdings,
    });

    return loadSnapshot(etf, stored, "live", ttlHours);
  } catch (error) {
    if (latest && latestIsPlausible) {
      return loadSnapshot(etf, latest, "stale", ttlHours);
    }
    throw new HoldingsUnavailableError(etf.ticker, etf.id, error);
  }
}

export async function getHoldingsSnapshot(
  reference: string,
  options: RefreshOptions = {},
): Promise<HoldingsSnapshot> {
  const normalizedReference = reference.trim();
  let etf: NonNullable<ReturnType<typeof findEtfByReference>>;
  try {
    ensureLocalDatabase();
    const resolved = findEtfByReference(normalizedReference);
    if (!resolved) throw new Error(`Unsupported ETF: ${normalizedReference}`);
    etf = resolved;
  } catch (error) {
    throw new HoldingsUnavailableError(
      normalizedReference,
      normalizedReference,
      error,
    );
  }
  const cacheKey = `${databasePath()}::${etf.id}::${options.forceRefresh ? "force" : "cached"}`;
  const existing = inFlightRefreshes.get(cacheKey);
  if (existing) return existing;

  const refresh = refreshHoldings(etf, options)
    .catch((error) => {
      if (error instanceof HoldingsUnavailableError) throw error;
      throw new HoldingsUnavailableError(
        etf.ticker,
        etf.id,
        error,
      );
    })
    .finally(() => {
      inFlightRefreshes.delete(cacheKey);
    });
  inFlightRefreshes.set(cacheKey, refresh);
  return refresh;
}
