import type { Holding, HoldingsSnapshot } from "@/domain/etf";
import type {
  ConsensusHorizon,
  ComponentValuationView,
  EtfMetricsOverview,
  SecurityMetricValues,
} from "@/domain/metrics";
import { CONSENSUS_HORIZONS } from "@/domain/metrics";
import {
  aggregateConsensusWindow,
  aggregateEtfMetrics,
} from "@/domain/processors/aggregate-etf-metrics";
import { consensusQuarters } from "@/domain/processors/derive-estimate-metrics";

const COMPONENT_POINT_LIMIT = 500;

export function equityHoldings(holdings: Holding[]): Holding[] {
  return holdings.filter((holding) =>
    holding.weight > 0 && holding.assetClass.toLocaleLowerCase("en-US").includes("equity"));
}

export function uniqueEquityHoldings(snapshots: HoldingsSnapshot[]): Holding[] {
  const result = new Map<string, Holding>();
  for (const snapshot of snapshots) {
    for (const holding of equityHoldings(snapshot.holdings)) {
      const current = result.get(holding.securityId);
      if (!current || (!current.exchange && holding.exchange)) {
        result.set(holding.securityId, holding);
      }
    }
  }
  return [...result.values()];
}

export function latestTimestamp(values: Iterable<string | undefined>): string {
  let latest = 0;
  for (const value of values) {
    const timestamp = Date.parse(value ?? "");
    if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
  }
  return latest > 0 ? new Date(latest).toISOString() : new Date().toISOString();
}

export function buildComponentValuation(
  holdings: Holding[],
  metricsBySecurity: ReadonlyMap<string, SecurityMetricValues>,
): ComponentValuationView {
  const eligibleHoldings = equityHoldings(holdings);
  const totalWeight = eligibleHoldings.reduce((sum, holding) => sum + holding.weight, 0);
  const eligiblePoints = eligibleHoldings.flatMap((holding) => {
    const securityMetrics = metricsBySecurity.get(holding.securityId);
    const peHistoricalEstimate4q = securityMetrics?.values.pe_estimate_window_0;
    const peForwardEstimate4q = securityMetrics?.values.pe_estimate_window_4;
    const epsGrowthEstimate4q = securityMetrics?.values.eps_growth_estimate_forward_4q;
    const series = securityMetrics?.estimateSeries;
    const qMinus3EpsEstimate = series?.points[0]?.estimate;
    const nextQuarterEpsEstimate = series?.points[4]?.estimate;
    const peQMinus3Annualized =
      typeof qMinus3EpsEstimate === "number" && qMinus3EpsEstimate !== 0 && series
        ? series.price / (qMinus3EpsEstimate * 4)
        : undefined;
    const peNextQuarterAnnualized =
      typeof nextQuarterEpsEstimate === "number" && nextQuarterEpsEstimate !== 0 && series
        ? series.price / (nextQuarterEpsEstimate * 4)
        : undefined;
    const epsGrowthNextQuarterVsQMinus3 =
      typeof peQMinus3Annualized === "number" && typeof peNextQuarterAnnualized === "number"
        ? (peQMinus3Annualized / peNextQuarterAnnualized - 1) * 100
        : undefined;
    if (
      !securityMetrics || !series ||
      !Number.isFinite(epsGrowthNextQuarterVsQMinus3) ||
      !Number.isFinite(peQMinus3Annualized) ||
      !Number.isFinite(peNextQuarterAnnualized) ||
      !Number.isFinite(qMinus3EpsEstimate) ||
      !Number.isFinite(nextQuarterEpsEstimate)
    ) {
      return [];
    }
    const historicalEstimateSum = series.points
      .slice(0, 4)
      .reduce((sum, point) => sum + point.estimate, 0);
    const forwardEstimateSum = series.points
      .slice(4, 8)
      .reduce((sum, point) => sum + point.estimate, 0);
    return [{
      securityId: holding.securityId,
      ticker: holding.ticker,
      name: holding.name,
      sector: holding.sector,
      country: holding.country,
      providerSymbol: securityMetrics.providerSymbol,
      weight: holding.weight,
      peHistoricalEstimate4q: Number.isFinite(peHistoricalEstimate4q)
        ? peHistoricalEstimate4q as number
        : null,
      peForwardEstimate4q: Number.isFinite(peForwardEstimate4q)
        ? peForwardEstimate4q as number
        : null,
      epsGrowthEstimate4q: Number.isFinite(epsGrowthEstimate4q)
        ? epsGrowthEstimate4q as number
        : null,
      historicalEstimateSum,
      forwardEstimateSum,
      price: series.price,
      currency: series.currency,
      estimatePoints: series.points,
      epsGrowthNextQuarterVsQMinus3: epsGrowthNextQuarterVsQMinus3 as number,
      peQMinus3Annualized: peQMinus3Annualized as number,
      qMinus3EpsEstimate: qMinus3EpsEstimate as number,
      peNextQuarterAnnualized: peNextQuarterAnnualized as number,
      nextQuarterEpsEstimate: nextQuarterEpsEstimate as number,
    }];
  });
  const validPoints = eligiblePoints.filter((point) =>
    point.peQMinus3Annualized > 0 && point.peNextQuarterAnnualized > 0);
  const points = validPoints
    .sort((left, right) => right.weight - left.weight)
    .slice(0, COMPONENT_POINT_LIMIT);
  const representedWeight = points.reduce((sum, point) => sum + point.weight, 0);
  const minGrowth = points.length
    ? Math.min(-10, Math.floor(Math.min(...points.map((point) => point.epsGrowthNextQuarterVsQMinus3)) / 10) * 10)
    : -10;
  const maxGrowth = points.length
    ? Math.max(30, Math.ceil(Math.max(...points.map((point) => point.epsGrowthNextQuarterVsQMinus3)) / 10) * 10)
    : 30;
  const maxPe = points.length
    ? Math.max(30, Math.ceil(Math.max(...points.map((point) => point.peNextQuarterAnnualized)) / 10) * 10)
    : 30;
  return {
    points,
    eligibleCount: eligiblePoints.length,
    eligibleHoldingCount: eligibleHoldings.length,
    displayedCount: points.length,
    excludedOutlierCount: 0,
    missingMetricCount: eligibleHoldings.length - eligiblePoints.length,
    excludedNonPositivePeCount: eligiblePoints.length - validPoints.length,
    truncatedCount: Math.max(0, validPoints.length - points.length),
    representedWeight: totalWeight > 0 ? (representedWeight / totalWeight) * 100 : 0,
    axisLimits: { minGrowth, maxGrowth, maxPe },
  };
}

export function buildEtfMetricsOverview(
  snapshot: HoldingsSnapshot,
  resolvedSecurityIds: ReadonlySet<string>,
  metricsBySecurity: ReadonlyMap<string, SecurityMetricValues>,
): EtfMetricsOverview {
  const eligible = equityHoldings(snapshot.holdings);
  const totalWeight = eligible.reduce((sum, holding) => sum + holding.weight, 0);
  const mapped = eligible.filter((holding) => resolvedSecurityIds.has(holding.securityId));
  const mappedWeight = mapped.reduce((sum, holding) => sum + holding.weight, 0);
  const consensusWindows = Object.fromEntries(CONSENSUS_HORIZONS.map((horizon) => [
    horizon,
    aggregateConsensusWindow(snapshot.holdings, metricsBySecurity, consensusQuarters(horizon)),
  ])) as Record<ConsensusHorizon, EtfMetricsOverview["consensusWindows"][ConsensusHorizon]>;
  return {
    etfId: snapshot.etf.id,
    ticker: snapshot.etf.ticker,
    name: snapshot.etf.name,
    asOf: snapshot.asOf,
    holdingsCount: eligible.length,
    mappedHoldings: mapped.length,
    mappingCoverageWeight: totalWeight > 0 ? (mappedWeight / totalWeight) * 100 : 0,
    metrics: aggregateEtfMetrics(snapshot.holdings, metricsBySecurity),
    consensusWindows,
    componentValuation: buildComponentValuation(snapshot.holdings, metricsBySecurity),
  };
}
