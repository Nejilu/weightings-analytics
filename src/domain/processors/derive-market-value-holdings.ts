import type { Holding } from "../etf";

interface DerivedMarketValueHoldings {
  holdings: Holding[];
  sourceMarketValue: number;
  missingTickers: string[];
}

interface DeriveMarketValueHoldingsOptions {
  missingComponentPolicy?: "exclude-and-renormalize";
  componentSecurityIds?: Record<string, string>;
}

export function deriveMarketValueHoldings(
  sourceHoldings: Holding[],
  componentTickers: string[],
  options: DeriveMarketValueHoldingsOptions = {},
): DerivedMarketValueHoldings {
  const sourceByTicker = new Map<string, Holding[]>();
  for (const holding of sourceHoldings) {
    const ticker = holding.ticker.trim().toUpperCase();
    const candidates = sourceByTicker.get(ticker) ?? [];
    candidates.push(holding);
    sourceByTicker.set(ticker, candidates);
  }
  const normalizedTickers = componentTickers.map((ticker) =>
    ticker.trim().toUpperCase(),
  );
  const componentSecurityIds = new Map(
    Object.entries(options.componentSecurityIds ?? {}).map(
      ([ticker, securityId]) => [ticker.trim().toUpperCase(), securityId],
    ),
  );
  const duplicateTickers = normalizedTickers.filter(
    (ticker, index) => normalizedTickers.indexOf(ticker) !== index,
  );
  if (duplicateTickers.length > 0) {
    throw new Error(
      `Duplicate derived component tickers: ${[...new Set(duplicateTickers)].join(", ")}`,
    );
  }

  const selectedByTicker = new Map<string, Holding>();
  const missingTickers: string[] = [];
  const ambiguousTickers: string[] = [];
  for (const ticker of normalizedTickers) {
    const candidates = sourceByTicker.get(ticker) ?? [];
    const configuredSecurityId = componentSecurityIds.get(ticker);
    if (configuredSecurityId) {
      const configured = candidates.find(
        (holding) => holding.securityId === configuredSecurityId,
      );
      if (!configured) {
        throw new Error(
          `Configured derived component identity ${ticker}=${configuredSecurityId} is unavailable in the source ETF.`,
        );
      }
      selectedByTicker.set(ticker, configured);
      continue;
    }
    if (candidates.length === 0) {
      missingTickers.push(ticker);
      continue;
    }
    if (candidates.length > 1) {
      ambiguousTickers.push(
        `${ticker} (${candidates.map((holding) =>
          `${holding.name} [${holding.securityId}]`).join("; ")})`,
      );
      continue;
    }
    selectedByTicker.set(ticker, candidates[0]);
  }
  if (ambiguousTickers.length > 0) {
    throw new Error(
      `Ambiguous derived component tickers: ${ambiguousTickers.join(", ")}. Configure componentSecurityIds with durable identities.`,
    );
  }
  if (
    missingTickers.length > 0 &&
    options.missingComponentPolicy !== "exclude-and-renormalize"
  ) {
    throw new Error(
      `Derived components missing from the source ETF: ${missingTickers.join(", ")}`,
    );
  }

  const selected = normalizedTickers.flatMap((ticker) => {
    const holding = selectedByTicker.get(ticker);
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
