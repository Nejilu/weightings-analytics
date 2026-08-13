import "server-only";

import {
  DERIVED_METRIC_KEYS,
  OVERVIEW_METRIC_DEFINITIONS,
  type MetricCaptureWindow,
  type MetricsOverviewResult,
  type MetricsOverviewWarning,
  type SecurityMetricValues,
} from "@/domain/metrics";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { databasePath } from "@/db/client";
import {
  ensureMetricDefinitions,
  loadProviderNegativeCache,
  loadLatestSecurityMetrics,
  loadProviderSymbols,
  pruneExpiredProviderNegativeCache,
  saveDerivedSecurityMetricsBatch,
  type DerivedSecurityMetricsInput,
} from "@/db/repositories/metrics-repository";
import { findEtfByReference } from "@/db/repositories/catalog-repository";
import {
  prepareScreenerRefresh,
  refreshScreenerMetrics,
  ScreenerRefreshUnavailableError,
  compatibleCachedSourceValues,
} from "./metrics-overview-screener";
import {
  refreshEstimateSeries,
  EstimatesRefreshUnavailableError,
} from "./metrics-overview-estimates";
import {
  deriveEstimateSeriesMetrics,
  replaceDerivedMetrics,
} from "@/domain/processors/derive-estimate-metrics";
import {
  estimateSeriesNegativeCache,
  providerNegativeCacheKey,
  sourceMetricNegativeCache,
} from "@/domain/provider-negative-cache";
import {
  canonicalizeEtfReferences as canonicalizeReferences,
  reorderEtfItems,
} from "@/domain/metrics-overview-request";
import {
  isEstimateSeriesCompatible,
  metricsSourceStatus,
  resolvedProviderSymbol,
} from "@/domain/metrics-cache";
import {
  getHoldingsSnapshot,
  HoldingsUnavailableError,
} from "./holdings-service";
import {
  buildEtfMetricsOverview,
  uniqueEquityHoldings,
} from "./metrics-overview-model";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24;
const RESULT_CACHE_TTL_MS = 60_000;
const PARTIAL_RESULT_CACHE_TTL_MS = 5 * 60_000;
const STALE_RESULT_CACHE_TTL_MS = 60_000;
const RESULT_CACHE_MAX_ENTRIES = 8;
const MAX_INPUT_REFERENCES = 16;
const INVALID_SELECTION_MESSAGE = "Select between one and four ETFs.";
const inFlightRequests = new Map<string, Promise<MetricsOverviewResult>>();
let hydratedNegativeCachePath: string | undefined;
const resultCache = new Map<string, {
  result: MetricsOverviewResult;
  expiresAt: number;
}>();

function cacheTtlSeconds(): number {
  const configured = Number(process.env.TRADINGVIEW_METRICS_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TTL_SECONDS;
}

function missingEstimateSeriesTtlMs(): number {
  const configured = Number(process.env.TRADINGVIEW_ESTIMATES_MISSING_TTL_SECONDS);
  const seconds = Number.isFinite(configured) && configured >= 60 && configured <= 86_400
    ? configured
    : 900;
  return seconds * 1_000;
}

function missingSourceMetricTtlMs(): number {
  const configured = Number(process.env.TRADINGVIEW_METRICS_MISSING_TTL_SECONDS);
  const seconds = Number.isFinite(configured) && configured >= 60 && configured <= 86_400
    ? configured
    : 900;
  return seconds * 1_000;
}

function hydratePersistedNegativeCache(): void {
  const path = databasePath();
  if (hydratedNegativeCachePath === path) return;
  pruneExpiredProviderNegativeCache();
  const now = Date.now();
  for (const entry of loadProviderNegativeCache(now)) {
    const ttlMs = entry.expiresAt - now;
    if (entry.cacheKind === "estimate_series") {
      estimateSeriesNegativeCache.rememberMissing(
        providerNegativeCacheKey(path, entry.providerSymbol),
        ttlMs,
        now,
      );
    } else {
      sourceMetricNegativeCache.rememberMissing(
        providerNegativeCacheKey(path, entry.providerSymbol, entry.metricKey),
        ttlMs,
        now,
      );
    }
  }
  hydratedNegativeCachePath = path;
}

function cacheResult(key: string, result: MetricsOverviewResult): void {
  resultCache.set(key, {
    result,
    expiresAt: Date.now() + (
      result.sourceStatus === "stale"
        ? STALE_RESULT_CACHE_TTL_MS
        : result.sourceStatus === "partial"
          ? PARTIAL_RESULT_CACHE_TTL_MS
          : RESULT_CACHE_TTL_MS
    ),
  });
  while (resultCache.size > RESULT_CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

function resultForOrder(
  result: MetricsOverviewResult,
  orderedEtfIds: readonly string[],
): MetricsOverviewResult {
  const etfs = reorderEtfItems(result.etfs, orderedEtfIds);
  return etfs.length === result.etfs.length ? { ...result, etfs } : result;
}

function materiallyDifferent(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) return left !== right;
  return Math.abs(left - right) > Math.max(1e-9, Math.abs(right) * 1e-9);
}

function captureWindow(values: Iterable<string | undefined>): MetricCaptureWindow | null {
  let oldest = Number.POSITIVE_INFINITY;
  let latest = 0;
  for (const value of values) {
    const timestamp = Date.parse(value ?? "");
    if (!Number.isFinite(timestamp)) continue;
    oldest = Math.min(oldest, timestamp);
    latest = Math.max(latest, timestamp);
  }
  return latest > 0
    ? { oldest: new Date(oldest).toISOString(), latest: new Date(latest).toISOString() }
    : null;
}

async function providerOrUnavailable<T>(
  operation: () => Promise<T>,
  isUnavailable: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUnavailable(error)) throw new MetricsOverviewUnavailableError(error);
    throw error;
  }
}

async function buildOverview(references: string[]): Promise<MetricsOverviewResult> {
  try {
    ensureLocalDatabase();
    ensureMetricDefinitions();
  } catch (error) {
    throw new MetricsOverviewUnavailableError(error);
  }
  hydratePersistedNegativeCache();
  let etfs: ReturnType<typeof findEtfByReference>[];
  try {
    etfs = references.map((reference) => findEtfByReference(reference));
  } catch (error) {
    throw new MetricsOverviewUnavailableError(error);
  }
  if (etfs.some((etf) => !etf)) {
    throw new MetricsOverviewRequestError(
      "Invalid ETF selection. Use funds available in the catalog.",
    );
  }
  const snapshots = await providerOrUnavailable(
    () => Promise.all(references.map(getHoldingsSnapshot)),
    (error) => error instanceof HoldingsUnavailableError,
  );
  const holdingsAreStale = snapshots.some((snapshot) => snapshot.sourceStatus === "stale");
  const sourceWarnings = new Set<MetricsOverviewWarning>();
  if (holdingsAreStale) sourceWarnings.add("holdings-stale");
  const holdings = uniqueEquityHoldings(snapshots);
  const securityIds = holdings.map((holding) => holding.securityId);
  const ttlSeconds = cacheTtlSeconds();
  const missingEstimateTtlMs = missingEstimateSeriesTtlMs();
  const missingSourceMetricTtl = missingSourceMetricTtlMs();
  let providerSymbols = loadProviderSymbols(securityIds);
  let cachedMetrics = loadLatestSecurityMetrics(securityIds);
  const screenerPlan = prepareScreenerRefresh({
    holdings,
    providerSymbols,
    cachedMetrics,
    ttlSeconds,
  });
  if (screenerPlan.hasUnresolvedCandidates) sourceWarnings.add("mapping-unresolved");
  const screenerResult = await providerOrUnavailable(
    () => refreshScreenerMetrics({
      holdings,
      needsRefresh: screenerPlan.needsRefresh,
      candidatesBySecurity: screenerPlan.candidatesBySecurity,
      candidateDetailsBySecurity: screenerPlan.candidateDetailsBySecurity,
      requestedSymbols: screenerPlan.requestedSymbols,
      providerSymbols,
      cachedMetrics,
      securityIds,
      missingSourceMetricTtlMs: missingSourceMetricTtl,
      sourceMetricCoverageGaps: screenerPlan.sourceMetricCoverageGaps,
    }),
    (error) => error instanceof ScreenerRefreshUnavailableError,
  );
  providerSymbols = screenerResult.providerSymbols;
  cachedMetrics = screenerResult.cachedMetrics;

  const estimateRefreshResult = await providerOrUnavailable(
    () => refreshEstimateSeries({
      holdings,
      providerSymbols,
      securityIds,
      ttlSeconds,
      missingEstimateTtlMs,
    }),
    (error) => error instanceof EstimatesRefreshUnavailableError,
  );
  const cachedEstimateSeries = estimateRefreshResult.cachedEstimateSeries;
  const providerRefreshes = [screenerResult, estimateRefreshResult];
  for (const refresh of providerRefreshes) {
    for (const warning of refresh.warnings) sourceWarnings.add(warning);
  }

  const metricsBySecurity = new Map<string, SecurityMetricValues>();
  const derivedWrites: DerivedSecurityMetricsInput[] = [];
  // The database path is constant for this request; avoid resolving it once
  // per security and per source metric in the hot compatibility loop.
  const metricsCachePath = databasePath();
  for (const holding of holdings) {
    const securityId = holding.securityId;
    const cached = cachedMetrics.get(securityId);
    const currentProviderSymbol = resolvedProviderSymbol(providerSymbols.get(securityId));
    const cachedEstimate = cachedEstimateSeries.get(securityId);
    const missingEstimateNow = currentProviderSymbol
      ? estimateSeriesNegativeCache.state(
        providerNegativeCacheKey(metricsCachePath, currentProviderSymbol),
      ) === "fresh"
      : false;
    const estimateCache = !missingEstimateNow && isEstimateSeriesCompatible(
      cachedEstimate?.series.providerSymbol,
      currentProviderSymbol,
    ) ? cachedEstimate : undefined;
    const correctedValues = replaceDerivedMetrics(
      compatibleCachedSourceValues(cached, currentProviderSymbol, metricsCachePath),
      estimateCache ? deriveEstimateSeriesMetrics(estimateCache.series) : {},
    );
    const derivedChanged = DERIVED_METRIC_KEYS.some((key) =>
      materiallyDifferent(cached?.values[key], correctedValues[key]));
    const providerSymbol = estimateCache?.series.providerSymbol ?? currentProviderSymbol ?? "";
    if (derivedChanged && currentProviderSymbol && providerSymbol) {
      derivedWrites.push({
        securityId,
        providerSymbol,
        values: correctedValues,
        capturedAt: estimateCache?.capturedAt ?? cached?.capturedAt ?? new Date().toISOString(),
      });
    }
    if (!currentProviderSymbol || (!cached && !estimateCache)) continue;
    metricsBySecurity.set(securityId, {
      securityId,
      providerSymbol,
      values: correctedValues,
      estimateSeries: estimateCache?.series,
      capturedAtByKey: Object.fromEntries([
        ...[...cached?.sourceCapturedAtByKey.entries() ?? []]
          .filter(([key]) => correctedValues[key] !== undefined),
        ...DERIVED_METRIC_KEYS.flatMap((key) =>
          correctedValues[key] !== undefined && estimateCache?.capturedAt
            ? [[key, estimateCache.capturedAt] as const]
            : []),
      ]),
      estimateCapturedAt: estimateCache?.capturedAt,
    });
  }
  saveDerivedSecurityMetricsBatch(derivedWrites);

  const sourceStatus = metricsSourceStatus(
    holdingsAreStale || providerRefreshes.some((refresh) => refresh.hasStaleSource),
    screenerPlan.hasUnresolvedCandidates ||
      providerRefreshes.some((refresh) => refresh.hasPartialCoverage),
    providerRefreshes.some((refresh) => refresh.hasLiveSource),
  );
  const calculatedAt = new Date().toISOString();
  const fundamentalsCaptureWindow = captureWindow([...metricsBySecurity.values()].flatMap((metric) =>
    Object.entries(metric.capturedAtByKey ?? {})
      .filter(([key]) => !DERIVED_METRIC_KEYS.includes(key as typeof DERIVED_METRIC_KEYS[number]))
      .map(([, capturedAt]) => capturedAt)));
  const estimatesCaptureWindow = captureWindow([...metricsBySecurity.values()].map((metric) =>
    metric.estimateCapturedAt));
  const resolvedSecurityIds = new Set([...providerSymbols.entries()]
    .filter(([, record]) => Boolean(resolvedProviderSymbol(record)))
    .map(([securityId]) => securityId));

  return {
    calculatedAt,
    fundamentalsCaptureWindow,
    estimatesCaptureWindow,
    source: "TradingView Screener + Estimates",
    sourceStatus,
    sourceWarnings: [...sourceWarnings].sort(),
    cacheTtlHours: ttlSeconds / 3_600,
    definitions: [...OVERVIEW_METRIC_DEFINITIONS],
    etfs: snapshots.map((snapshot) => buildEtfMetricsOverview(
      snapshot,
      resolvedSecurityIds,
      metricsBySecurity,
    )),
  };
}

export class MetricsOverviewUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(cause instanceof Error
      ? `TradingView metrics are unavailable: ${cause.message}`
      : "TradingView metrics are unavailable.");
    this.name = "MetricsOverviewUnavailableError";
  }
}

export class MetricsOverviewRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsOverviewRequestError";
  }
}

export function getMetricsOverview(references: string[]): Promise<MetricsOverviewResult> {
  if (references.length > MAX_INPUT_REFERENCES) {
    return Promise.reject(new MetricsOverviewRequestError(INVALID_SELECTION_MESSAGE));
  }
  let normalized: string[];
  try {
    ensureLocalDatabase();
    normalized = canonicalizeReferences(references, findEtfByReference);
  } catch (error) {
    return Promise.reject(new MetricsOverviewUnavailableError(error));
  }
  if (normalized.length < 1 || normalized.length > 4) {
    return Promise.reject(new MetricsOverviewRequestError(INVALID_SELECTION_MESSAGE));
  }
  const key = `${databasePath()}::${normalized.slice().sort().join("|")}`;
  const cached = resultCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      resultCache.delete(key);
      resultCache.set(key, cached);
      return Promise.resolve(resultForOrder(cached.result, normalized));
    }
    resultCache.delete(key);
  }
  const existing = inFlightRequests.get(key);
  if (existing) return existing.then((result) => resultForOrder(result, normalized));
  const request = buildOverview(normalized)
    .then((result) => {
      cacheResult(key, result);
      return result;
    })
    .finally(() => inFlightRequests.delete(key));
  inFlightRequests.set(key, request);
  return request;
}
