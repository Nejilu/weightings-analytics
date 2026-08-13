import {
  METRIC_DEFINITIONS,
  type ConsensusAggregate,
  type MetricCaptureWindow,
  type MetricKey,
  type ConsensusWindowView,
  type SecurityMetricValues,
  type WeightedMetric,
} from "@/domain/metrics";
import type { Holding } from "@/domain/etf";
import { deriveConsensusWindow } from "./derive-estimate-metrics";

const EARNINGS_GROWTH_KEY = "eps_growth_estimate_forward_4q";

function captureWindow(values: Array<string | undefined>): MetricCaptureWindow | null {
  const timestamps = values
    .filter((value): value is string => Number.isFinite(Date.parse(value ?? "")))
    .sort();
  return timestamps.length > 0
    ? { oldest: timestamps[0], latest: timestamps[timestamps.length - 1] }
    : null;
}

function aggregateHarmonicPe(
  eligible: Holding[],
  totalWeight: number,
  peBySecurity: ReadonlyMap<string, number | null>,
  capturedAtBySecurity: ReadonlyMap<string, string | undefined>,
): ConsensusAggregate {
  const covered = eligible.flatMap((holding) => {
    const pe = peBySecurity.get(holding.securityId);
    return typeof pe === "number" && Number.isFinite(pe) && pe > 0
      ? [{ holding, pe }]
      : [];
  });
  const coveredWeight = covered.reduce((sum, item) => sum + item.holding.weight, 0);
  const earningsYield = covered.reduce(
    (sum, item) => sum + item.holding.weight / item.pe,
    0,
  );
  const value = coveredWeight > 0 && earningsYield > 0
    ? coveredWeight / earningsYield
    : null;
  return {
    value: value !== null && Number.isFinite(value) ? value : null,
    coverageWeight: totalWeight > 0 ? (coveredWeight / totalWeight) * 100 : 0,
    coveredHoldings: covered.length,
    totalHoldings: eligible.length,
    captureWindow: captureWindow(covered.map((item) =>
      capturedAtBySecurity.get(item.holding.securityId))),
  };
}

export function aggregateConsensusWindow(
  holdings: Holding[],
  metricsBySecurity: ReadonlyMap<string, SecurityMetricValues>,
  quarters: 1 | 2 | 4,
): ConsensusWindowView {
  const eligible = holdings.filter((holding) =>
    holding.weight > 0 && holding.assetClass.toLowerCase().includes("equity"));
  const totalWeight = eligible.reduce((sum, holding) => sum + holding.weight, 0);
  const derivedBySecurity = new Map(eligible.flatMap((holding) => {
    const series = metricsBySecurity.get(holding.securityId)?.estimateSeries;
    const derived = series ? deriveConsensusWindow(series, quarters) : null;
    return derived ? [[holding.securityId, derived] as const] : [];
  }));
  const valuationPath = Array.from({ length: 9 - quarters }, (_, index) =>
    aggregateHarmonicPe(
      eligible,
      totalWeight,
      new Map([...derivedBySecurity].map(([securityId, derived]) =>
        [securityId, derived.pePath[index]])),
      new Map(eligible.map((holding) => [
        holding.securityId,
        metricsBySecurity.get(holding.securityId)?.estimateCapturedAt,
      ])),
    ));
  const coveredForGrowth = eligible.flatMap((holding) => {
    const derived = derivedBySecurity.get(holding.securityId);
    const historicalPe = derived?.pePath[4 - quarters];
    const forwardPe = derived?.pePath[4];
    return typeof historicalPe === "number" && historicalPe > 0 &&
      typeof forwardPe === "number" && forwardPe > 0
      ? [{ holding, historicalPe, forwardPe }]
      : [];
  });
  const coveredWeight = coveredForGrowth.reduce((sum, item) => sum + item.holding.weight, 0);
  const historicalEarningsYield = coveredForGrowth.reduce(
    (sum, item) => sum + item.holding.weight / item.historicalPe,
    0,
  );
  const forwardEarningsYield = coveredForGrowth.reduce(
    (sum, item) => sum + item.holding.weight / item.forwardPe,
    0,
  );
  const growthValue = historicalEarningsYield > 0 && forwardEarningsYield >= 0
    ? (forwardEarningsYield / historicalEarningsYield - 1) * 100
    : null;

  return {
    quarters,
    annualizationFactor: (4 / quarters) as 1 | 2 | 4,
    valuationPath,
    growth: {
      value: growthValue !== null && Number.isFinite(growthValue) ? growthValue : null,
      coverageWeight: totalWeight > 0 ? (coveredWeight / totalWeight) * 100 : 0,
      coveredHoldings: coveredForGrowth.length,
      totalHoldings: eligible.length,
      captureWindow: captureWindow(coveredForGrowth.map((item) =>
        metricsBySecurity.get(item.holding.securityId)?.estimateCapturedAt)),
    },
  };
}

function aggregateEarningsYieldGrowth(
  eligible: Holding[],
  totalWeight: number,
  metricsBySecurity: ReadonlyMap<string, SecurityMetricValues>,
): WeightedMetric {
  const covered = eligible.flatMap((holding) => {
    const values = metricsBySecurity.get(holding.securityId)?.values;
    const historicalPe = values?.pe_estimate_window_0;
    const forwardPe = values?.pe_estimate_window_4;
    return typeof historicalPe === "number" && Number.isFinite(historicalPe) && historicalPe > 0 &&
      typeof forwardPe === "number" && Number.isFinite(forwardPe) && forwardPe > 0
      ? [{ holding, historicalPe, forwardPe }]
      : [];
  });
  const coveredWeight = covered.reduce((sum, item) => sum + item.holding.weight, 0);
  const historicalEarningsYield = covered.reduce(
    (sum, item) => sum + item.holding.weight / item.historicalPe,
    0,
  );
  const forwardEarningsYield = covered.reduce(
    (sum, item) => sum + item.holding.weight / item.forwardPe,
    0,
  );
  const value = historicalEarningsYield > 0 && forwardEarningsYield >= 0
    ? (forwardEarningsYield / historicalEarningsYield - 1) * 100
    : null;
  return {
    key: EARNINGS_GROWTH_KEY,
    value: value !== null && Number.isFinite(value) ? value : null,
    coverageWeight: totalWeight > 0 ? (coveredWeight / totalWeight) * 100 : 0,
    coveredHoldings: covered.length,
    totalHoldings: eligible.length,
    captureWindow: captureWindow(covered.map((item) =>
      metricsBySecurity.get(item.holding.securityId)?.estimateCapturedAt)),
  };
}

function weightedMedian(
  values: Array<{ holding: Holding; value: number }>,
  coveredWeight: number,
): number | null {
  if (coveredWeight <= 0) return null;
  const ordered = [...values].sort((left, right) => left.value - right.value);
  let cumulativeWeight = 0;
  for (const item of ordered) {
    cumulativeWeight += item.holding.weight;
    if (cumulativeWeight >= coveredWeight / 2) return item.value;
  }
  return ordered.at(-1)?.value ?? null;
}

export function aggregateEtfMetrics(
  holdings: Holding[],
  metricsBySecurity: ReadonlyMap<string, SecurityMetricValues>,
): WeightedMetric[] {
  const eligible = holdings.filter((holding) => holding.weight > 0 && holding.assetClass.toLowerCase().includes("equity"));
  const totalWeight = eligible.reduce((sum, holding) => sum + holding.weight, 0);
  return METRIC_DEFINITIONS.filter((definition) => definition.aggregate).map((definition) => {
    if (definition.key === EARNINGS_GROWTH_KEY) {
      return aggregateEarningsYieldGrowth(eligible, totalWeight, metricsBySecurity);
    }
    const covered = eligible.flatMap((holding) => {
      const value = metricsBySecurity.get(holding.securityId)?.values[definition.key];
      const inRange = !definition.validRange || (
        typeof value === "number" &&
        value >= definition.validRange.min &&
        value <= definition.validRange.max
      );
      const validForAggregation = definition.aggregation !== "weighted_harmonic" || (
        typeof value === "number" && value > 0
      );
      return typeof value === "number" && Number.isFinite(value) && inRange && validForAggregation
        ? [{ holding, value }]
        : [];
    });
    const coveredWeight = covered.reduce((sum, item) => sum + item.holding.weight, 0);
    const weightedValue = definition.aggregation === "weighted_harmonic"
      ? coveredWeight / covered.reduce((sum, item) => sum + item.holding.weight / item.value, 0)
      : definition.aggregation === "weighted_median"
        ? weightedMedian(covered, coveredWeight)
        : covered.reduce((sum, item) => sum + item.value * item.holding.weight, 0) / coveredWeight;
    return {
      key: definition.key,
      value: coveredWeight > 0 && typeof weightedValue === "number" && Number.isFinite(weightedValue)
        ? weightedValue
        : null,
      coverageWeight: totalWeight > 0 ? (coveredWeight / totalWeight) * 100 : 0,
      coveredHoldings: covered.length,
      totalHoldings: eligible.length,
      captureWindow: captureWindow(covered.map((item) =>
        metricsBySecurity.get(item.holding.securityId)?.capturedAtByKey?.[
          definition.key as MetricKey
        ])),
    };
  });
}
