import type { HoldingsAnalysisPosition } from "./holdings-analysis";

export type DistortionRankingBasis = "absolute" | "relative";
export type DistortionTableRanking = "weight" | DistortionRankingBasis;
export interface RankedDistortionPosition extends HoldingsAnalysisPosition {
  actualWeight: number;
  counterfactualWeight: number;
  weightDelta: number;
  relativeWeight: number | null;
}

export function distortionWeightMultiple(
  position: Pick<HoldingsAnalysisPosition, "actualWeight" | "counterfactualWeight">,
): number | null {
  const { actualWeight, counterfactualWeight } = position;
  if (actualWeight === null || counterfactualWeight === null ||
    !Number.isFinite(actualWeight) || !Number.isFinite(counterfactualWeight) ||
    actualWeight < 0 || counterfactualWeight <= 0) return null;
  return actualWeight / counterfactualWeight;
}

export function rankDistortionTablePositions(
  positions: HoldingsAnalysisPosition[],
  ranking: DistortionTableRanking = "weight",
) {
  const rows = positions.map((position) => ({ ...position, relativeWeight: distortionWeightMultiple(position) }));
  const gap = (position: HoldingsAnalysisPosition) => position.weightDelta === null ? -1 : Math.abs(position.weightDelta);
  // A ×5 overweight and a ×0.2 underweight have the same relative magnitude.
  // Zero portfolio weight is complete underweight; undefined ratios sort last.
  const multiple = (ratio: number | null) => ratio === null ? -1 : ratio === 0 ? Infinity : Math.max(ratio, 1 / ratio);
  return rows.sort((a, b) => {
    const weightOrder = b.publishedWeight - a.publishedWeight;
    const absoluteOrder = gap(b) - gap(a);
    const primary = ranking === "weight" ? weightOrder : ranking === "absolute" ? absoluteOrder : multiple(b.relativeWeight) - multiple(a.relativeWeight);
    return primary || (ranking === "weight" ? 0 : absoluteOrder) || weightOrder || a.securityId.localeCompare(b.securityId);
  });
}

export function rankDistortionPositions(
  positions: HoldingsAnalysisPosition[],
  basis: DistortionRankingBasis,
) {
  const eligible: RankedDistortionPosition[] = positions.flatMap((position) => {
    const { actualWeight, counterfactualWeight, weightDelta } = position;
    if (actualWeight === null || counterfactualWeight === null || weightDelta === null ||
      !Number.isFinite(actualWeight) || !Number.isFinite(counterfactualWeight) ||
      !Number.isFinite(weightDelta) || actualWeight < 0 || counterfactualWeight < 0 || weightDelta === 0) return [];
    return [{ ...position, actualWeight, counterfactualWeight, weightDelta,
      relativeWeight: distortionWeightMultiple(position),
    }];
  });
  const noBenchmarkCount = eligible.filter((position) => position.counterfactualWeight === 0).length;
  const ranked = basis === "relative"
    ? eligible.filter((position) => position.relativeWeight !== null)
    : eligible;
  const absoluteOrder = (a: RankedDistortionPosition, b: RankedDistortionPosition) =>
    Math.abs(b.weightDelta) - Math.abs(a.weightDelta) || a.securityId.localeCompare(b.securityId);
  return {
    overweights: ranked.filter((position) => position.weightDelta > 0).sort((a, b) =>
      (basis === "relative" ? b.relativeWeight! - a.relativeWeight! : 0) || absoluteOrder(a, b)),
    underweights: ranked.filter((position) => position.weightDelta < 0).sort((a, b) =>
      (basis === "relative" ? a.relativeWeight! - b.relativeWeight! : 0) || absoluteOrder(a, b)),
    noBenchmarkCount,
  };
}

export function relativeDistortionLabel(relativeWeight: number): string {
  if (relativeWeight === 0) return "×0";
  // Preserve small nonzero ratios and deviations near ×1.00 on both sides.
  const digits = Math.abs(relativeWeight - 1) < 0.005 && relativeWeight !== 1
    ? 4 : Math.max(2, Math.min(6, 1 - Math.floor(Math.log10(relativeWeight))));
  return `×${relativeWeight.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function absoluteDistortionLabel(weightDelta: number): string {
  const magnitude = Math.abs(weightDelta);
  const digits = magnitude === 0 ? 2 : Math.max(2, Math.min(6, 1 - Math.floor(Math.log10(magnitude))));
  return `${weightDelta > 0 ? "+" : ""}${weightDelta.toFixed(digits)} pp`;
}
