import type { HoldingsSnapshot, ImplicitSleeve } from "@/domain/etf";
import type { SecurityMetricValues, TargetAssetPairMetrics } from "@/domain/metrics";
import { compareHoldings } from "@/domain/processors/compare-holdings";
import { normalizeHoldingWeights } from "@/domain/processors/normalize-holding-weights";
import { isCashHolding } from "@/domain/cash-holdings";
import { economicSecurityIdentity } from "@/domain/security-equivalence";
import { buildEtfMetricsOverview } from "./metrics-overview-model";

/** Keep original listings for metrics; only their economic exposure is netted. */
export function targetAssetSnapshot(
  source: HoldingsSnapshot,
  sleeve: ImplicitSleeve,
): HoldingsSnapshot {
  const holdings = normalizeHoldingWeights(
    source.holdings.filter((holding) => !isCashHolding(holding)),
    source.etf.exposureMultiplier ?? 1,
  );
  const sourceWeights = new Map<string, number>();
  for (const holding of holdings) {
    const id = economicSecurityIdentity(holding).securityId;
    sourceWeights.set(id, (sourceWeights.get(id) ?? 0) + holding.weight);
  }
  const targetWeights = new Map(sleeve.positions.map((position) => [
    position.securityId, position.normalizedWeight,
  ]));
  return {
    ...source,
    holdings: holdings.flatMap((holding) => {
      const id = economicSecurityIdentity(holding).securityId;
      const targetWeight = targetWeights.get(id) ?? 0;
      const sourceWeight = sourceWeights.get(id) ?? 0;
      return targetWeight > 0 && sourceWeight > 0 && holding.weight > 0
        ? [{ ...holding, weight: targetWeight * holding.weight / sourceWeight }]
        : [];
    }),
  };
}

export function buildTargetAssetPairs(
  snapshots: HoldingsSnapshot[],
  resolvedSecurityIds: ReadonlySet<string>,
  metricsBySecurity: ReadonlyMap<string, SecurityMetricValues>,
): TargetAssetPairMetrics[] {
  return snapshots.flatMap((left, index) => snapshots.slice(index + 1).map((right) => {
    const comparison = compareHoldings(left, right);
    const buildAsset = (source: HoldingsSnapshot, peer: HoldingsSnapshot, sleeve: ImplicitSleeve) => ({
      ...buildEtfMetricsOverview(targetAssetSnapshot(source, sleeve), resolvedSecurityIds, metricsBySecurity),
      relativeToEtfId: peer.etf.id,
      sourceActiveWeight: sleeve.sourceActiveWeight,
    });
    return {
      overlapWeight: comparison.overlapWeight,
      assets: [
        buildAsset(left, right, comparison.implicitSleeves.left),
        buildAsset(right, left, comparison.implicitSleeves.right),
      ],
    };
  }));
}
