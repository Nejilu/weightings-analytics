import assert from "node:assert/strict";
import test from "node:test";

import type { HoldingsSnapshot } from "../etf";
import type { PortfolioItem, PortfolioSecurity } from "../portfolio";
import {
  analyzePortfolio,
  analyzePortfolioForDisplay,
} from "./analyze-portfolio";
import { valuePortfolioPositions } from "./value-portfolio";

const apple: PortfolioSecurity = {
  securityId: "US0378331005",
  ticker: "AAPL",
  name: "Apple",
  sector: "Information Technology",
  assetClass: "Equity",
  country: "United States",
};

const microsoft: PortfolioSecurity = {
  securityId: "US5949181045",
  ticker: "MSFT",
  name: "Microsoft",
  sector: "Information Technology",
  assetClass: "Equity",
  country: "United States",
};

const snapshot = {
  etf: { ticker: "ACWI" },
  asOf: "2026-07-30",
  sourceStatus: "cached",
  holdings: [
    { ...apple, weight: 60 },
    { ...microsoft, weight: 40 },
  ],
} as HoldingsSnapshot;

test("aggregates direct positions with their ETF look-through exposure", () => {
  const items: PortfolioItem[] = [
    {
      id: "etf",
      kind: "etf",
      referenceId: "acwi-us",
      ticker: "ACWI",
      name: "iShares MSCI ACWI ETF",
      allocationWeight: 50,
    },
    {
      id: "direct",
      kind: "security",
      referenceId: apple.securityId,
      ticker: apple.ticker,
      name: apple.name,
      allocationWeight: 20,
    },
  ];

  const result = analyzePortfolio({
    items,
    etfSnapshots: new Map([["ACWI", snapshot]]),
    directSecurities: new Map([[apple.securityId, apple]]),
    calculatedAt: "2026-07-31T00:00:00.000Z",
  });

  assert.equal(result.positions[0].ticker, "AAPL");
  assert.equal(result.positions[0].weight, 50);
  assert.equal(result.positions[0].contributions.length, 2);
  assert.equal(result.positions[1].weight, 20);
  assert.equal(result.cashWeight, 30);
  assert.equal(result.top10Concentration, 70);
});

test("normalises small source weight drift inside each ETF sleeve", () => {
  const driftingSnapshot = {
    ...snapshot,
    holdings: [
      { ...apple, weight: 49 },
      { ...microsoft, weight: 50 },
    ],
  } as HoldingsSnapshot;

  const result = analyzePortfolio({
    items: [
      {
        id: "etf",
        kind: "etf",
        referenceId: "acwi-us",
        ticker: "ACWI",
        name: "iShares MSCI ACWI ETF",
        allocationWeight: 100,
      },
    ],
    etfSnapshots: new Map([["ACWI", driftingSnapshot]]),
    directSecurities: new Map(),
  });

  assert.equal(
    Math.round(
      result.positions.reduce((sum, position) => sum + position.weight, 0),
    ),
    100,
  );
});

test("uses market values for higher-precision portfolio look-through weights", () => {
  const preciseSnapshot = {
    ...snapshot,
    holdings: [
      { ...apple, weight: 50, marketValue: 5_000.4 },
      { ...microsoft, weight: 50, marketValue: 4_999.6 },
    ],
  } as HoldingsSnapshot;

  const result = analyzePortfolio({
    items: [
      {
        id: "etf",
        kind: "etf",
        referenceId: "acwi-us",
        ticker: "ACWI",
        name: "iShares MSCI ACWI ETF",
        allocationWeight: 100,
      },
    ],
    etfSnapshots: new Map([["ACWI", preciseSnapshot]]),
    directSecurities: new Map(),
  });

  assert.equal(
    result.positions.find((position) => position.ticker === "AAPL")?.weight,
    50.004,
  );
  assert.equal(
    result.positions.find((position) => position.ticker === "MSFT")?.weight,
    49.996,
  );
});

test("recalculates a saved component definition from updated ETF holdings", () => {
  const item: PortfolioItem = {
    id: "etf",
    kind: "etf",
    referenceId: "acwi-us",
    ticker: "ACWI",
    name: "iShares MSCI ACWI ETF",
    allocationWeight: 100,
  };
  const updatedSnapshot = {
    ...snapshot,
    asOf: "2026-07-31",
    holdings: [
      { ...apple, weight: 20 },
      { ...microsoft, weight: 80 },
    ],
  } as HoldingsSnapshot;

  const original = analyzePortfolio({
    items: [item],
    etfSnapshots: new Map([["ACWI", snapshot]]),
    directSecurities: new Map(),
  });
  const updated = analyzePortfolio({
    items: [item],
    etfSnapshots: new Map([["ACWI", updatedSnapshot]]),
    directSecurities: new Map(),
  });

  assert.equal(original.positions.find((position) => position.ticker === "AAPL")?.weight, 60);
  assert.equal(updated.positions.find((position) => position.ticker === "AAPL")?.weight, 20);
  assert.equal(updated.positions[0].ticker, "MSFT");
});

test("preserves leveraged allocations above 100% with negative cash", () => {
  const result = analyzePortfolio({
    items: [
      {
        id: "direct",
        kind: "security",
        referenceId: apple.securityId,
        ticker: apple.ticker,
        name: apple.name,
        allocationWeight: 200,
      },
    ],
    etfSnapshots: new Map(),
    directSecurities: new Map([[apple.securityId, apple]]),
    cashWeight: -100,
  });

  assert.equal(result.positions[0].weight, 200);
  assert.equal(result.cashWeight, -100);
  assert.equal(result.netExposureWeight, 200);
  assert.equal(result.grossExposureWeight, 200);
});

test("keeps short positions signed and ranks them by absolute exposure", () => {
  const result = analyzePortfolio({
    items: [
      {
        id: "long",
        kind: "security",
        referenceId: apple.securityId,
        ticker: apple.ticker,
        name: apple.name,
        allocationWeight: 150,
      },
      {
        id: "short",
        kind: "security",
        referenceId: microsoft.securityId,
        ticker: microsoft.ticker,
        name: microsoft.name,
        allocationWeight: -50,
      },
    ],
    etfSnapshots: new Map(),
    directSecurities: new Map([
      [apple.securityId, apple],
      [microsoft.securityId, microsoft],
    ]),
    cashWeight: 0,
  });

  assert.deepEqual(result.positions.map((position) => position.weight), [150, -50]);
  assert.equal(result.netExposureWeight, 100);
  assert.equal(result.grossExposureWeight, 200);
  assert.equal(result.top10Concentration, 200);
});

test("recalculates component weights when prices diverge while shares stay fixed", () => {
  const items: PortfolioItem[] = [
    {
      id: "fund",
      kind: "etf",
      referenceId: "acwi-us",
      ticker: "ACWI",
      name: "iShares MSCI ACWI ETF",
      allocationWeight: 50,
      quantity: 10,
    },
    {
      id: "stock",
      kind: "security",
      referenceId: apple.securityId,
      ticker: apple.ticker,
      name: apple.name,
      allocationWeight: 50,
      quantity: 5,
    },
  ];
  const marketPrice = (assetKind: "etf" | "security", assetId: string, priceUsd: number) => ({
    assetKind,
    assetId,
    providerSymbol: assetKind === "etf" ? "ACWI" : "AAPL",
    price: priceUsd,
    currency: "USD",
    fxToUsd: 1,
    priceUsd,
    asOf: "2026-07-31T00:00:00.000Z",
    fetchedAt: "2026-07-31T00:00:00.000Z",
    sourceStatus: "cached" as const,
  });

  const initial = valuePortfolioPositions(
    items,
    new Map([
      ["etf:acwi-us", marketPrice("etf", "acwi-us", 100)],
      ["security:US0378331005", marketPrice("security", apple.securityId, 200)],
    ]),
  );
  const diverged = valuePortfolioPositions(
    items,
    new Map([
      ["etf:acwi-us", marketPrice("etf", "acwi-us", 150)],
      ["security:US0378331005", marketPrice("security", apple.securityId, 200)],
    ]),
  );

  assert.equal(initial.items[0].allocationWeight, 50);
  assert.equal(initial.items[1].allocationWeight, 50);
  assert.equal(diverged.items[0].allocationWeight, 60);
  assert.equal(diverged.items[1].allocationWeight, 40);
  assert.equal(diverged.totalMarketValueUsd, 2_500);
});

test("keeps canonical Alphabet share classes in portfolio data", () => {
  const alphabetSnapshot = {
    ...snapshot,
    holdings: [
      {
        ...apple,
        securityId: "alphabet-a",
        ticker: "GOOGL",
        name: "ALPHABET INC CLASS A",
        weight: 55,
      },
      {
        ...microsoft,
        securityId: "alphabet-c",
        ticker: "GOOG",
        name: "ALPHABET INC CLASS C",
        weight: 45,
      },
    ],
  } as HoldingsSnapshot;

  const result = analyzePortfolio({
    items: [
      {
        id: "fund",
        kind: "etf",
        referenceId: "acwi-us",
        ticker: "ACWI",
        name: "iShares MSCI ACWI ETF",
        allocationWeight: 100,
      },
    ],
    etfSnapshots: new Map([["acwi-us", alphabetSnapshot]]),
    directSecurities: new Map(),
  });

  assert.equal(result.positions.length, 2);
  assert.deepEqual(
    result.positions.map(({ securityId, ticker, weight }) => ({
      securityId,
      ticker,
      weight,
    })),
    [
      { securityId: "alphabet-a", ticker: "GOOGL", weight: 55 },
      { securityId: "alphabet-c", ticker: "GOOG", weight: 45 },
    ],
  );
});

test("merges Alphabet share classes only for portfolio display", () => {
  const alphabetSnapshot = {
    ...snapshot,
    holdings: [
      {
        ...apple,
        securityId: "alphabet-a",
        ticker: "GOOGL",
        name: "ALPHABET INC CLASS A",
        weight: 55,
      },
      {
        ...microsoft,
        securityId: "alphabet-c",
        ticker: "GOOG",
        name: "ALPHABET INC CLASS C",
        weight: 45,
      },
    ],
  } as HoldingsSnapshot;

  const result = analyzePortfolioForDisplay({
    items: [
      {
        id: "fund",
        kind: "etf",
        referenceId: "acwi-us",
        ticker: "ACWI",
        name: "iShares MSCI ACWI ETF",
        allocationWeight: 100,
      },
    ],
    etfSnapshots: new Map([["acwi-us", alphabetSnapshot]]),
    directSecurities: new Map(),
  });

  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].ticker, "GOOG / GOOGL");
  assert.equal(result.positions[0].weight, 100);
  assert.equal(result.positions[0].quoteSecurityId, "alphabet-a");
  assert.equal(result.positions[0].quoteTicker, "GOOGL");
});

test("uses the highest-weight listing as the quote reference for a grouped position", () => {
  const tsmcSnapshot = {
    ...snapshot,
    holdings: [
      {
        ...apple,
        securityId: "tsmc-adr",
        ticker: "TSM",
        name: "TAIWAN SEMICONDUCTOR ADR",
        country: "Taiwan",
        weight: 20,
      },
      {
        ...microsoft,
        securityId: "tsmc-primary",
        ticker: "2330",
        name: "TAIWAN SEMICONDUCTOR MANUFACTURING",
        country: "Taiwan",
        weight: 80,
      },
    ],
  } as HoldingsSnapshot;

  const result = analyzePortfolioForDisplay({
    items: [
      {
        id: "fund",
        kind: "etf",
        referenceId: "acwi-us",
        ticker: "ACWI",
        name: "iShares MSCI ACWI ETF",
        allocationWeight: 100,
      },
    ],
    etfSnapshots: new Map([["acwi-us", tsmcSnapshot]]),
    directSecurities: new Map(),
  });

  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].ticker, "TSM / 2330");
  assert.equal(result.positions[0].quoteSecurityId, "tsmc-primary");
  assert.equal(result.positions[0].quoteTicker, "2330");
});

test("keeps a dominant direct depositary ticker over its canonical local listing", () => {
  const canonicalTsmc = {
    ...apple,
    securityId: "tsmc-primary",
    ticker: "2330",
    name: "TAIWAN SEMICONDUCTOR MANUFACTURING",
    country: "Taiwan",
  };
  const localSnapshot = {
    ...snapshot,
    holdings: [{ ...canonicalTsmc, weight: 100 }],
  } as HoldingsSnapshot;

  const result = analyzePortfolioForDisplay({
    items: [
      {
        id: "direct-adr",
        kind: "security",
        referenceId: canonicalTsmc.securityId,
        ticker: "TSM",
        name: canonicalTsmc.name,
        allocationWeight: 60,
      },
      {
        id: "fund",
        kind: "etf",
        referenceId: "acwi-us",
        ticker: "ACWI",
        name: "iShares MSCI ACWI ETF",
        allocationWeight: 40,
      },
    ],
    etfSnapshots: new Map([["acwi-us", localSnapshot]]),
    directSecurities: new Map([[canonicalTsmc.securityId, canonicalTsmc]]),
  });

  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].quoteSecurityId, "tsmc-primary");
  assert.equal(result.positions[0].quoteTicker, "TSM");
});

test("preserves leveraged ETF exposure above portfolio NAV", () => {
  const leveragedSnapshot = {
    ...snapshot,
    etf: {
      ...snapshot.etf,
      exposureMultiplier: 2,
    },
    holdings: [{ ...apple, weight: 200 }],
  } as HoldingsSnapshot;

  const result = analyzePortfolio({
    items: [
      {
        id: "qld",
        kind: "etf",
        referenceId: "qld-us",
        ticker: "QLD",
        name: "ProShares Ultra QQQ",
        allocationWeight: 50,
      },
    ],
    etfSnapshots: new Map([["qld-us", leveragedSnapshot]]),
    directSecurities: new Map(),
  });

  assert.equal(result.positions[0].weight, 100);
  assert.equal(result.explicitCashWeight, 50);
  assert.equal(result.financingWeight, -50);
  assert.equal(result.cashWeight, 0);
});

test("values leverage against explicit negative cash", () => {
  const items: PortfolioItem[] = [
    {
      id: "stock",
      kind: "security",
      referenceId: apple.securityId,
      ticker: apple.ticker,
      name: apple.name,
      allocationWeight: 0,
      quantity: 200,
    },
  ];
  const marketPrice = {
    assetKind: "security" as const,
    assetId: apple.securityId,
    providerSymbol: "AAPL",
    price: 1_000,
    currency: "USD",
    fxToUsd: 1,
    priceUsd: 1_000,
    asOf: "2026-08-12T00:00:00.000Z",
    fetchedAt: "2026-08-12T00:00:00.000Z",
    sourceStatus: "cached" as const,
  };

  const result = valuePortfolioPositions(
    items,
    new Map([[`security:${apple.securityId}`, marketPrice]]),
    -100_000,
  );

  assert.equal(result.totalMarketValueUsd, 100_000);
  assert.equal(result.items[0].allocationWeight, 200);
});
