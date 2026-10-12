import type { CapitalizationReferenceData } from "../capitalization-reference";
import { validMarketCapitalization } from "../capitalization-reference";
import { DEFAULT_DISTORTION_TOP_COUNT, type DistortionMode, type DistortionReferencePosition, type HoldingsAnalysisPosition, type HoldingsDistortionAnalysis } from "../holdings-analysis";
import { calculateHoldingsDistortion } from "./calculate-holdings-distortion";

export function calculateTotalCapDistortion(
  positions: HoldingsAnalysisPosition[], referencePositions: DistortionReferencePosition[],
  reference: Pick<HoldingsDistortionAnalysis, "referenceEtfId" | "referenceTicker" | "referenceAsOf">,
  capitalizations: CapitalizationReferenceData,
  mode: DistortionMode = "top-holdings", topCount = DEFAULT_DISTORTION_TOP_COUNT,
) {
  const companyIds = new Map(capitalizations.observations.map((row) => [row.securityId, row.companyId ?? row.securityId]));
  const groupPositions = new Map<string, HoldingsAnalysisPosition>();
  for (const position of positions) {
    const securityId = companyIds.get(position.securityId) ?? position.securityId;
    const existing = groupPositions.get(securityId);
    if (existing) {
      existing.publishedWeight += position.publishedWeight;
      if (!existing.ticker.split(" / ").includes(position.ticker)) existing.ticker += ` / ${position.ticker}`;
    } else groupPositions.set(securityId, { ...position, securityId });
  }
  const groupReferences = new Map<string, DistortionReferencePosition>();
  for (const position of referencePositions) {
    const securityId = companyIds.get(position.securityId) ?? position.securityId;
    const existing = groupReferences.get(securityId);
    if (existing) {
      existing.weight += position.weight;
      if (!existing.ticker.split(" / ").includes(position.ticker)) existing.ticker += ` / ${position.ticker}`;
    } else groupReferences.set(securityId, { ...position, securityId });
  }
  const equities = [...groupPositions.values()].filter((p) => p.publishedWeight > 0 && !p.isCash && p.assetClass.toLowerCase().includes("equity"))
    .sort((a, b) => b.publishedWeight - a.publishedWeight || a.securityId.localeCompare(b.securityId));
  const count = Number.isFinite(topCount) ? Math.max(1, Math.trunc(topCount)) : DEFAULT_DISTORTION_TOP_COUNT;
  const selected = mode === "top-holdings" ? equities.slice(0, count) : equities;
  const bySecurity = new Map(capitalizations.observations
    .filter((observation) => observation.status === "available" && validMarketCapitalization(observation.marketCapUsd))
    .map((observation) => [observation.companyId ?? observation.securityId, observation.marketCapUsd!]));
  const market = mode === "market-coverage";
  const acwi = [...groupReferences.values()].filter((p) => p.weight > 0);
  const inAcwi = new Set(acwi.map((p) => p.securityId));
  const usable = selected.filter((p) => bySecurity.has(p.securityId) || (market && !inAcwi.has(p.securityId)));
  const weight = (rows: HoldingsAnalysisPosition[]) => rows.reduce((sum, p) => sum + p.publishedWeight, 0);
  const selectedWeight = weight(selected);
  const coverage = selectedWeight > 0 ? weight(usable) / selectedWeight * 100 : 0;
  const referenceCoverage = market
    ? acwi.filter((p) => bySecurity.has(p.securityId)).reduce((sum, p) => sum + p.weight, 0) / (acwi.reduce((sum, p) => sum + p.weight, 0) || 1) * 100
    : coverage;
  const benchmarks = (market ? acwi : selected).flatMap((p) => {
    const cap = bySecurity.get(p.securityId);
    return cap === undefined ? [] : [{
      securityId: p.securityId, ticker: p.ticker, name: p.name, sector: p.sector, assetClass: p.assetClass, country: p.country, weight: cap,
    }];
  });
  // Selection happens before exclusions: missing top holdings are never replaced
  // by lower ranks. No missing capitalization is treated as a zero benchmark.
  const calculated = calculateHoldingsDistortion(usable, benchmarks, reference, mode === "top-holdings" ? "all-holdings" : mode, topCount);
  const scoreAvailable = calculated.distortion.score !== null && coverage >= 95 && (!market || referenceCoverage >= 99);
  const missingIds = new Set(selected.filter((p) => !usable.includes(p)).map((p) => p.securityId));
  const rows = calculated.positions.map((p) => !scoreAvailable ? {
    ...p, actualWeight: null, counterfactualWeight: null, weightDelta: null, distortionContribution: null,
  } : p);
  for (const p of selected.filter((p) => missingIds.has(p.securityId))) rows.push({
    ...p, actualWeight: null, counterfactualWeight: null, weightDelta: null, distortionContribution: null, distortionStatus: "missing-capitalization",
  });
  return {
    positions: rows,
    distortion: {
      ...calculated.distortion, mode, methodology: "tradingview-total-cap" as const,
      topCount: mode === "top-holdings" ? selected.length : null,
      selectedWeight, score: scoreAvailable ? calculated.distortion.score : null,
      coverageWeight: coverage, coverageStatus: coverage >= 99 && referenceCoverage >= 99 ? "complete" as const : coverage >= 95 ? "partial" as const : "insufficient" as const,
      coveredHoldings: usable.length, eligibleHoldings: selected.length,
      missingHoldings: market ? selected.filter((p) => !inAcwi.has(p.securityId)).length : missingIds.size,
      capitalizationCoverage: {
        referenceWeightCoverage: referenceCoverage,
        missingReferenceHoldings: market ? acwi.filter((p) => !bySecurity.has(p.securityId)).length : missingIds.size,
        excludedHoldings: missingIds.size, scoreAvailable,
      },
    },
  };
}
