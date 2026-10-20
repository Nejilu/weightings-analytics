import type { Holding } from "@/domain/etf";
import { resolvedProviderSymbol } from "@/domain/metrics-cache";
import {
  refreshScreenerMetrics,
  type RefreshScreenerMetricsInput,
  type RefreshScreenerMetricsResult,
} from "./metrics-overview-screener";
import {
  refreshEstimateSeries,
  type RefreshEstimateSeriesInput,
  type RefreshEstimateSeriesResult,
} from "./metrics-overview-estimates";

const providers = { screener: refreshScreenerMetrics, estimates: refreshEstimateSeries };

// Both branches settle explicitly: an Estimates failure must not become an
// unhandled rejection while Screener is still resolving new symbols.
function outcome<T>(operation: Promise<T>) {
  return operation.then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
}

export async function refreshMetricSources(
  screenerInput: RefreshScreenerMetricsInput,
  estimateInput: RefreshEstimateSeriesInput,
  refresh = providers,
  onScreener?: (result: RefreshScreenerMetricsResult) => void,
) {
  const known = estimateInput.holdings.filter((holding) => {
    const symbol = resolvedProviderSymbol(estimateInput.providerSymbols.get(holding.securityId));
    return symbol && (!screenerInput.needsRefresh.has(holding.securityId) ||
      screenerInput.candidatesBySecurity.get(holding.securityId)?.includes(symbol));
  });
  const knownSymbols = new Map(known.map((holding) => [holding.securityId,
    resolvedProviderSymbol(estimateInput.providerSymbols.get(holding.securityId))]));
  const screenerRequest = refresh.screener(screenerInput);
  const estimatesRequest = outcome(refresh.estimates({ ...estimateInput, holdings: known,
    securityIds: known.map((holding) => holding.securityId) }));
  const screenerResult = await screenerRequest;
  onScreener?.(screenerResult);
  // Newly resolved or changed mappings must use their final symbol. Series
  // fetched for an old mapping remain incompatible and are never aggregated.
  const remaining: Holding[] = estimateInput.holdings.filter((holding) =>
    !knownSymbols.has(holding.securityId) || knownSymbols.get(holding.securityId) !==
      resolvedProviderSymbol(screenerResult.providerSymbols.get(holding.securityId)));
  const loadRemaining = () => outcome(refresh.estimates({ ...estimateInput, holdings: remaining,
      securityIds: remaining.map((holding) => holding.securityId),
      providerSymbols: screenerResult.providerSymbols }));
  // New securities can start immediately. A changed mapping waits for its old
  // request to settle, so an old-symbol write cannot overwrite the new series.
  const newRequest = remaining.length && remaining.every((holding) => !knownSymbols.has(holding.securityId))
    ? loadRemaining() : undefined;
  const early = await estimatesRequest;
  const late = newRequest ? await newRequest : remaining.length ? await loadRemaining() : undefined;
  const estimates = [early, late].filter((item) => item !== undefined);
  const successes = estimates.flatMap((item) => item.result ? [item.result] : []);
  const failures = estimates.filter((item) => item.error !== undefined);
  const cachedEstimateSeries = new Map(successes.flatMap((result) => [...result.cachedEstimateSeries]));
  if (failures.length && cachedEstimateSeries.size === 0) throw failures[0].error;
  const estimateResult: RefreshEstimateSeriesResult = {
    cachedEstimateSeries,
    estimateCoverageGaps: new Set(successes.flatMap((result) => [...result.estimateCoverageGaps])),
    warnings: [...new Set(successes.flatMap((result) => result.warnings).concat(
      failures.length ? ["estimates-unavailable"] : []))],
    hasLiveSource: successes.some((result) => result.hasLiveSource),
    hasPartialCoverage: successes.some((result) => result.hasPartialCoverage),
    hasStaleSource: failures.length > 0 || successes.some((result) => result.hasStaleSource),
  };
  return { screenerResult, estimateResult };
}
