import type { Holding, HoldingsSnapshot } from "@/domain/etf";
import type {
  DistortionCoverageStatus,
  HoldingsAnalysisPosition,
  HoldingsAnalysisResult,
} from "@/domain/holdings-analysis";
import { mergeEquivalentHoldings } from "@/domain/security-equivalence";

import { normalizeHoldingWeights } from "./normalize-holding-weights";

const round = (value: number, decimals = 6) =>
  Number(value.toFixed(decimals));

function isEquity(holding: Holding): boolean {
  return (
    holding.weight > 0 &&
    holding.assetClass.toLocaleLowerCase("en-US").includes("equity")
  );
}

function normalizedHoldings(snapshot: HoldingsSnapshot): Holding[] {
  return mergeEquivalentHoldings(
    normalizeHoldingWeights(
      snapshot.holdings,
      snapshot.etf.exposureMultiplier ?? 1,
    ),
  );
}

function coverageStatus(coverageWeight: number): DistortionCoverageStatus {
  if (coverageWeight >= 99) return "complete";
  if (coverageWeight >= 80) return "partial";
  return "insufficient";
}

export function analyzeHoldings(
  targetSnapshot: HoldingsSnapshot,
  acwiSnapshot: HoldingsSnapshot,
): HoldingsAnalysisResult {
  const targetHoldings = normalizedHoldings(targetSnapshot);
  const acwiHoldings = normalizedHoldings(acwiSnapshot).filter(isEquity);
  const targetEquities = targetHoldings.filter(isEquity);
  const acwiBySecurity = new Map(
    acwiHoldings.map((holding) => [holding.securityId, holding]),
  );
  const coveredEquities = targetEquities.filter((holding) =>
    acwiBySecurity.has(holding.securityId),
  );
  const targetEquityWeight = targetEquities.reduce(
    (sum, holding) => sum + holding.weight,
    0,
  );
  const coveredTargetWeight = coveredEquities.reduce(
    (sum, holding) => sum + holding.weight,
    0,
  );
  const coveredReferenceWeight = coveredEquities.reduce(
    (sum, holding) =>
      sum + (acwiBySecurity.get(holding.securityId)?.weight ?? 0),
    0,
  );
  const coverageWeight =
    targetEquityWeight > 0
      ? (coveredTargetWeight / targetEquityWeight) * 100
      : 0;
  const canCalculate =
    coveredTargetWeight > 0 && coveredReferenceWeight > 0;

  const positions: HoldingsAnalysisPosition[] = targetHoldings
    .map((holding) => {
      const equity = isEquity(holding);
      const reference = acwiBySecurity.get(holding.securityId);
      if (!equity || !reference || !canCalculate) {
        return {
          securityId: holding.securityId,
          ticker: holding.ticker,
          name: holding.name,
          sector: holding.sector,
          assetClass: holding.assetClass,
          country: holding.country,
          publishedWeight: round(holding.weight),
          actualWeight: null,
          counterfactualWeight: null,
          weightDelta: null,
          distortionContribution: null,
          distortionStatus: equity ? "not-in-acwi" : "non-equity",
        } satisfies HoldingsAnalysisPosition;
      }

      const actualWeight = (holding.weight / coveredTargetWeight) * 100;
      const counterfactualWeight =
        (reference.weight / coveredReferenceWeight) * 100;
      const weightDelta = actualWeight - counterfactualWeight;
      return {
        securityId: holding.securityId,
        ticker: holding.ticker,
        name: holding.name,
        sector: holding.sector,
        assetClass: holding.assetClass,
        country: holding.country,
        publishedWeight: round(holding.weight),
        actualWeight: round(actualWeight),
        counterfactualWeight: round(counterfactualWeight),
        weightDelta: round(weightDelta),
        distortionContribution: round(Math.abs(weightDelta) / 2),
        distortionStatus: "covered",
      } satisfies HoldingsAnalysisPosition;
    })
    .sort(
      (left, right) =>
        (right.distortionContribution ?? -1) -
          (left.distortionContribution ?? -1) ||
        right.publishedWeight - left.publishedWeight,
    );

  const sectors = new Map<string, number>();
  for (const holding of targetHoldings) {
    const sector = holding.sector || "Unclassified";
    sectors.set(sector, (sectors.get(sector) ?? 0) + holding.weight);
  }
  const topPosition = [...targetHoldings].sort(
    (left, right) => right.weight - left.weight,
  )[0];
  const score = canCalculate
    ? round(
        positions.reduce(
          (sum, position) => sum + (position.distortionContribution ?? 0),
          0,
        ),
      )
    : null;

  return {
    etf: targetSnapshot.etf,
    asOf: targetSnapshot.asOf,
    sourceStatus: targetSnapshot.sourceStatus,
    cacheTtlHours: Math.min(
      targetSnapshot.cacheTtlHours,
      acwiSnapshot.cacheTtlHours,
    ),
    calculatedAt: new Date().toISOString(),
    holdingsCount: targetHoldings.length,
    equityHoldingsCount: targetEquities.length,
    top10Concentration: round(
      [...targetHoldings]
        .sort((left, right) => right.weight - left.weight)
        .slice(0, 10)
        .reduce((sum, holding) => sum + holding.weight, 0),
    ),
    topPosition: topPosition
      ? {
          ticker: topPosition.ticker,
          name: topPosition.name,
          weight: round(topPosition.weight),
        }
      : null,
    sectors: [...sectors.entries()]
      .map(([sector, weight]) => ({ sector, weight: round(weight) }))
      .sort((left, right) => right.weight - left.weight),
    distortion: {
      score,
      coverageWeight: round(coverageWeight),
      coverageStatus: coverageStatus(coverageWeight),
      coveredHoldings: coveredEquities.length,
      eligibleHoldings: targetEquities.length,
      missingHoldings: targetEquities.length - coveredEquities.length,
      referenceEtfId: acwiSnapshot.etf.id,
      referenceTicker: acwiSnapshot.etf.ticker,
      referenceAsOf: acwiSnapshot.asOf,
      methodology: "acwi-free-float-proxy",
    },
    positions,
  };
}
