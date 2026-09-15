import type { Holding } from "../etf";
import { isCashHolding } from "../cash-holdings";

const MAX_POSITION_DIFFERENCE = 0.1;
const MAX_TOTAL_DIFFERENCE = 5;

// Borrowed cash offsets invested assets in net asset value.
const sourceWeight = (holding: Holding) =>
  isCashHolding(holding) ? holding.weight : Math.max(0, holding.weight);

// Market values are preferred only when they reconcile closely with the
// official weights. This avoids treating derivative market value as exposure.
function normalizedBySourceWeight(
  holdings: Holding[],
  targetTotal: number,
): Holding[] {
  const total = holdings.reduce(
    (sum, holding) => sum + sourceWeight(holding),
    0,
  );
  if (total <= 0) return holdings;

  return holdings.map((holding) => ({
    ...holding,
    weight: (sourceWeight(holding) / total) * targetTotal,
  }));
}

function normalizedByMarketValue(
  holdings: Holding[],
  targetTotal: number,
): Holding[] | null {
  if (
    holdings.length === 0 ||
    holdings.some(
      (holding) =>
        typeof holding.marketValue !== "number" ||
        !Number.isFinite(holding.marketValue) ||
        holding.marketValue <= 0,
    )
  ) {
    return null;
  }

  const total = holdings.reduce(
    (sum, holding) => sum + (holding.marketValue ?? 0),
    0,
  );
  if (!Number.isFinite(total) || total <= 0) return null;

  return holdings.map((holding) => ({
    ...holding,
    weight: ((holding.marketValue ?? 0) / total) * targetTotal,
  }));
}

export function normalizeHoldingWeights(
  holdings: Holding[],
  exposureMultiplier = 1,
): Holding[] {
  const targetTotal = 100 * exposureMultiplier;
  const sourceWeights = normalizedBySourceWeight(holdings, targetTotal);
  const marketValueWeights = normalizedByMarketValue(holdings, targetTotal);
  if (!marketValueWeights) return sourceWeights;

  const sourceTotal = sourceWeights.reduce(
    (sum, holding) => sum + holding.weight,
    0,
  );
  if (sourceTotal <= 0) return marketValueWeights;

  const differences = marketValueWeights.map((holding, index) =>
    Math.abs(holding.weight - sourceWeights[index].weight),
  );
  const maxDifference = Math.max(...differences);
  const totalDifference = differences.reduce(
    (sum, difference) => sum + difference,
    0,
  );

  return maxDifference <= MAX_POSITION_DIFFERENCE * exposureMultiplier &&
    totalDifference <= MAX_TOTAL_DIFFERENCE * exposureMultiplier
    ? marketValueWeights
    : sourceWeights;
}
