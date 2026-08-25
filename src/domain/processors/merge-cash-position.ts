import type {
  PortfolioCashCurrency,
  PortfolioCashPosition,
} from "../portfolio";

export function mergeCashPosition(
  positions: PortfolioCashPosition[],
  currency: PortfolioCashCurrency,
  amount: number,
): PortfolioCashPosition[] {
  const existing = positions.find((position) => position.currency === currency);
  if (!existing) return [...positions, { currency, amount }];

  const mergedAmount = existing.amount + amount;
  if (mergedAmount === 0) {
    return positions.filter((position) => position.currency !== currency);
  }

  return positions.map((position) => {
    if (position.currency !== currency) return position;

    const merged = { ...position, amount: mergedAmount };
    if (position.fxToUsd === undefined) delete merged.valueUsd;
    else merged.valueUsd = mergedAmount * position.fxToUsd;
    return merged;
  });
}
