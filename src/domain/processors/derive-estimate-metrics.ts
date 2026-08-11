import {
  DERIVED_METRIC_KEYS,
  type ConsensusHorizon,
  type MetricKey,
  type SecurityEstimateSeries,
} from "@/domain/metrics";

const WINDOW_KEYS = [
  "pe_estimate_window_0",
  "pe_estimate_window_1",
  "pe_estimate_window_2",
  "pe_estimate_window_3",
  "pe_estimate_window_4",
] as const satisfies readonly MetricKey[];

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export interface DerivedConsensusWindow {
  quarters: 1 | 2 | 4;
  annualizationFactor: 1 | 2 | 4;
  annualizedEpsPath: number[];
  pePath: Array<number | null>;
  historicalAnnualizedEps: number;
  forwardAnnualizedEps: number;
  growth: number | null;
}

export function consensusQuarters(horizon: ConsensusHorizon): 1 | 2 | 4 {
  if (horizon === "1q") return 1;
  if (horizon === "2q") return 2;
  return 4;
}

/**
 * Builds every rolling annualized EPS window available in the eight-point
 * series. A two-quarter window is multiplied by two and a single quarter by
 * four, so every resulting P/E remains expressed on an annual basis.
 */
export function deriveConsensusWindow(
  series: SecurityEstimateSeries,
  quarters: 1 | 2 | 4,
): DerivedConsensusWindow | null {
  if (series.points.length !== 8 || !positive(series.price)) return null;
  const estimates = series.points.map((point) => point.estimate);
  if (estimates.some((estimate) => !Number.isFinite(estimate))) return null;

  const annualizationFactor = (4 / quarters) as 1 | 2 | 4;
  const annualizedEpsPath = Array.from({ length: 9 - quarters }, (_, offset) =>
    estimates
      .slice(offset, offset + quarters)
      .reduce((sum, estimate) => sum + estimate, 0) * annualizationFactor);
  const pePath = annualizedEpsPath.map((annualizedEps) =>
    positive(annualizedEps) ? series.price / annualizedEps : null);
  const historicalAnnualizedEps = annualizedEpsPath[4 - quarters];
  const forwardAnnualizedEps = annualizedEpsPath[4];
  const growth = positive(historicalAnnualizedEps) && positive(forwardAnnualizedEps)
    ? (forwardAnnualizedEps / historicalAnnualizedEps - 1) * 100
    : null;

  return {
    quarters,
    annualizationFactor,
    annualizedEpsPath,
    pePath,
    historicalAnnualizedEps,
    forwardAnnualizedEps,
    growth,
  };
}

export function deriveEstimateSeriesMetrics(
  series: SecurityEstimateSeries,
): Partial<Record<MetricKey, number>> {
  const consensus = deriveConsensusWindow(series, 4);
  if (!consensus) return {};
  const values: Partial<Record<MetricKey, number>> = {};

  WINDOW_KEYS.forEach((key, index) => {
    const pe = consensus.pePath[index];
    if (pe !== null) values[key] = pe;
  });

  if (consensus.growth !== null) values.eps_growth_estimate_forward_4q = consensus.growth;
  return values;
}

/**
 * A fresh consensus series is authoritative for derived EPS/P-E fields. If a
 * new series makes one of those fields undefined (for example, a non-positive
 * four-quarter EPS sum), remove the prior cached value instead of carrying it
 * forward with a misleading timestamp.
 */
export function replaceDerivedMetrics(
  values: Partial<Record<MetricKey, number>>,
  derived: Partial<Record<MetricKey, number>>,
): Partial<Record<MetricKey, number>> {
  const result = { ...values };
  for (const key of DERIVED_METRIC_KEYS) delete result[key];
  return { ...result, ...derived };
}
