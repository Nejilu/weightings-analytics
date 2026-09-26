import type { PortfolioItem } from "../portfolio";

export function mergePortfolioPosition(
  items: PortfolioItem[],
  addition: PortfolioItem,
): PortfolioItem[] {
  const existing = items.find(
    (item) => item.kind === addition.kind && item.referenceId === addition.referenceId,
  );
  if (!existing) return [...items, addition];

  const quantity = (existing.quantity ?? 0) + (addition.quantity ?? 0);
  // Ignore floating-point residue when fractional shares offset each other.
  const tolerance = Number.EPSILON * Math.max(
    Math.abs(existing.quantity ?? 0),
    Math.abs(addition.quantity ?? 0),
  );
  if (Math.abs(quantity) <= tolerance) {
    return items.filter((item) => item !== existing);
  }

  return items.map((item) => item === existing ? {
    ...existing,
    inputMode: "shares",
    inputAmount: quantity,
    quantity,
    priceSymbol: addition.priceSymbol,
    priceCurrency: addition.priceCurrency,
    currentPrice: addition.currentPrice,
    currentPriceUsd: addition.currentPriceUsd,
    currentValueUsd: quantity * (addition.currentPriceUsd ?? 0),
    priceAsOf: addition.priceAsOf,
    priceStatus: addition.priceStatus,
  } : item);
}
