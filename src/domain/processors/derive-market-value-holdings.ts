import type { Holding } from "../etf";

interface DerivedMarketValueHoldings {
  holdings: Holding[];
  sourceMarketValue: number;
  missingTickers: string[];
}

interface DeriveMarketValueHoldingsOptions {
  missingComponentPolicy?: "exclude-and-renormalize";
}

export function deriveMarketValueHoldings(
  sourceHoldings: Holding[],
  componentTickers: string[],
  options: DeriveMarketValueHoldingsOptions = {},
): DerivedMarketValueHoldings {
  const sourceByTicker = new Map(
    sourceHoldings.map((holding) => [holding.ticker.toUpperCase(), holding]),
  );
  const normalizedTickers = componentTickers.map((ticker) =>
    ticker.trim().toUpperCase(),
  );
  const duplicateTickers = normalizedTickers.filter(
    (ticker, index) => normalizedTickers.indexOf(ticker) !== index,
  );
  if (duplicateTickers.length > 0) {
    throw new Error(
      `Duplicate derived component tickers: ${[...new Set(duplicateTickers)].join(", ")}`,
    );
  }

  const missingTickers = normalizedTickers.filter(
    (ticker) => !sourceByTicker.has(ticker),
  );
  if (
    missingTickers.length > 0 &&
    options.missingComponentPolicy !== "exclude-and-renormalize"
  ) {
    throw new Error(
      `Derived components missing from the source ETF: ${missingTickers.join(", ")}`,
    );
  }

  const selected = normalizedTickers.flatMap((ticker) => {
    const holding = sourceByTicker.get(ticker);
    return holding ? [holding] : [];
  });
  const invalidMarketValues = selected
    .filter(
      (holding) =>
        holding.marketValue === undefined ||
        !Number.isFinite(holding.marketValue) ||
        holding.marketValue <= 0,
    )
    .map((holding) => holding.ticker);
  if (invalidMarketValues.length > 0) {
    throw new Error(
      `Derived components without a positive market value: ${invalidMarketValues.join(", ")}`,
    );
  }

  const sourceMarketValue = selected.reduce(
    (total, holding) => total + holding.marketValue!,
    0,
  );
  const holdings = selected
    .map((holding) => ({
      ...holding,
      weight: (holding.marketValue! / sourceMarketValue) * 100,
    }))
    .sort((left, right) => right.weight - left.weight);

  return { holdings, sourceMarketValue, missingTickers };
}
