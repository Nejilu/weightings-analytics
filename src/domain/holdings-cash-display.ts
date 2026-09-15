import type { HoldingsAnalysisPosition } from "./holdings-analysis";

export type HoldingsCashDisplay = "combined" | "positions";

// This is a display row only; canonical cash positions remain unchanged.
export function holdingsCashDisplayPositions(
  positions: HoldingsAnalysisPosition[],
  mode: HoldingsCashDisplay,
): HoldingsAnalysisPosition[] {
  if (mode === "positions") return positions;
  const cash = positions.filter((position) => position.isCash);
  if (cash.length === 0) return positions;
  return [
    ...positions.filter((position) => !position.isCash),
    {
      securityId: "display:net-cash",
      ticker: "CASH",
      name: "Net cash (all positions)",
      sector: "Cash & equivalents",
      assetClass: "Cash",
      country: "Not applicable",
      isCash: true,
      publishedWeight: cash.reduce((sum, position) => sum + position.publishedWeight, 0),
      normalizedWeightExCash: null,
      actualWeight: null,
      counterfactualWeight: null,
      weightDelta: null,
      distortionContribution: null,
      distortionStatus: "non-equity",
    },
  ];
}
