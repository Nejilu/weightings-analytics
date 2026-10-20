import "server-only";

import {
  DERIVED_METRIC_KEYS,
  OVERVIEW_METRIC_DEFINITIONS,
  type MetricCaptureWindow,
  type MetricsOverviewWarning,
  type SecurityMetricValues,
  type MetricsOverviewResult,
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
import {
  prepareScreenerRefresh,
  ScreenerRefreshUnavailableError,
  compatibleCachedSourceValues,
} from "./metrics-overview-screener";
import {
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
  isEstimateSeriesCompatible,
  metricsSourceStatus,
  resolvedProviderSymbol,
} from "@/domain/metrics-cache";
import type { Holding } from "@/domain/etf";
import { loadUpcomingEarnings } from "@/db/repositories/upcoming-earnings-repository";
import { upcomingEarningsAreFresh } from "@/domain/upcoming-earnings";
import { refreshMetricSources } from "./metrics-source-refresh";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24;
let hydratedNegativeCachePath: string | undefined;

export interface MetricsRefreshOptions {
  forceRefresh?: boolean;
}

export type SecurityMetricsSnapshot = Omit<MetricsOverviewResult, "etfs" | "holdingsSourceIssues"> & {
  metricsBySecurity: Map<string, SecurityMetricValues>;
  resolvedSecurityIds: Set<string>;
};

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

export async function providerOrUnavailable<T>(
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

export async function retrieveSecurityMetrics(
  holdings: Holding[],
  options: MetricsRefreshOptions & {
    includeUpcomingEarnings?: boolean;
    onFundamentals?: (snapshot: SecurityMetricsSnapshot) => void;
  } = {},
  holdingsAreStale = false,
) {
  try {
    ensureLocalDatabase();
    ensureMetricDefinitions();
  } catch (error) {
    throw new MetricsOverviewUnavailableError(error);
  }
  hydratePersistedNegativeCache();
  const sourceWarnings = new Set<MetricsOverviewWarning>();
  if (holdingsAreStale) sourceWarnings.add("holdings-stale");
  const securityIds = holdings.map((holding) => holding.securityId);
  const ttlSeconds = cacheTtlSeconds();
  const refreshTtlSeconds = options.forceRefresh ? 0 : ttlSeconds;
  const missingEstimateTtlMs = missingEstimateSeriesTtlMs();
  const missingSourceMetricTtl = missingSourceMetricTtlMs();
  let providerSymbols = loadProviderSymbols(securityIds);
  let cachedMetrics = loadLatestSecurityMetrics(securityIds);
  const cachedEarnings = options.includeUpcomingEarnings ? loadUpcomingEarnings(securityIds) : new Map();
  const earningsRefreshIds = new Set(options.includeUpcomingEarnings ? holdings.flatMap((holding) =>
    upcomingEarningsAreFresh(cachedEarnings.get(holding.securityId),
      resolvedProviderSymbol(providerSymbols.get(holding.securityId)), refreshTtlSeconds)
      ? [] : [holding.securityId]) : []);
  const screenerPlan = prepareScreenerRefresh({
    holdings,
    providerSymbols,
    cachedMetrics,
    ttlSeconds: refreshTtlSeconds,
    additionalRefreshSecurityIds: earningsRefreshIds,
  });
  if (screenerPlan.hasUnresolvedCandidates) sourceWarnings.add("mapping-unresolved");
  const { screenerResult, estimateResult: estimateRefreshResult } = await providerOrUnavailable(
    () => refreshMetricSources({
      holdings,
      includeUpcomingEarnings: options.includeUpcomingEarnings,
      needsRefresh: screenerPlan.needsRefresh,
      candidatesBySecurity: screenerPlan.candidatesBySecurity,
      candidateDetailsBySecurity: screenerPlan.candidateDetailsBySecurity,
      requestedSymbols: screenerPlan.requestedSymbols,
      providerSymbols,
      cachedMetrics,
      securityIds,
      missingSourceMetricTtlMs: missingSourceMetricTtl,
      sourceMetricCoverageGaps: screenerPlan.sourceMetricCoverageGaps,
    }, {
      holdings,
      providerSymbols,
      securityIds,
      ttlSeconds: refreshTtlSeconds,
      missingEstimateTtlMs,
    }, undefined, options.onFundamentals ? (screen) => {
      const metricsBySecurity = new Map<string, SecurityMetricValues>();
      const resolvedSecurityIds = new Set<string>();
      const path = databasePath();
      for (const holding of holdings) {
        const symbol = resolvedProviderSymbol(screen.providerSymbols.get(holding.securityId));
        if (!symbol) continue;
        resolvedSecurityIds.add(holding.securityId);
        const cached = screen.cachedMetrics.get(holding.securityId);
        if (!cached) continue;
        const values = compatibleCachedSourceValues(cached, symbol, path);
        for (const key of DERIVED_METRIC_KEYS) delete values[key];
        metricsBySecurity.set(holding.securityId, { securityId: holding.securityId,
          providerSymbol: symbol, values,
          capturedAtByKey: Object.fromEntries([...cached.sourceCapturedAtByKey]
            .filter(([key]) => values[key] !== undefined)) });
      }
      options.onFundamentals!({ calculatedAt: new Date().toISOString(),
        fundamentalsCaptureWindow: captureWindow([...metricsBySecurity.values()]
          .flatMap((metric) => Object.values(metric.capturedAtByKey ?? {}))),
        estimatesCaptureWindow: null, source: "TradingView Screener + Estimates",
        sourceStatus: metricsSourceStatus(holdingsAreStale || screen.hasStaleSource,
          screenerPlan.hasUnresolvedCandidates || screen.hasPartialCoverage, screen.hasLiveSource),
        sourceWarnings: [...new Set([...sourceWarnings, ...screen.warnings])].sort(),
        cacheTtlHours: ttlSeconds / 3_600,
        definitions: OVERVIEW_METRIC_DEFINITIONS.filter((definition) =>
          !DERIVED_METRIC_KEYS.includes(definition.key as typeof DERIVED_METRIC_KEYS[number])),
        metricsBySecurity, resolvedSecurityIds });
    } : undefined),
    (error) => error instanceof ScreenerRefreshUnavailableError || error instanceof EstimatesRefreshUnavailableError,
  );
  providerSymbols = screenerResult.providerSymbols;
  cachedMetrics = screenerResult.cachedMetrics;
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
    source: "TradingView Screener + Estimates" as const,
    sourceStatus,
    sourceWarnings: [...sourceWarnings].sort(),
    cacheTtlHours: ttlSeconds / 3_600,
    definitions: [...OVERVIEW_METRIC_DEFINITIONS],
    metricsBySecurity,
    resolvedSecurityIds,
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
