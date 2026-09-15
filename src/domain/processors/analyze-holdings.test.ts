import assert from "node:assert/strict";
import test from "node:test";

import type { EtfShareClass, Holding, HoldingsSnapshot } from "../etf";
import { holdingsCashDisplayPositions } from "../holdings-cash-display";
import { analyzeHoldings } from "./analyze-holdings";

function snapshot(
  id: string,
  ticker: string,
  holdings: Holding[],
): HoldingsSnapshot {
  return {
    etf: {
      id,
      ticker,
      name: ticker,
      benchmarkId: id,
      isin: id,
      wrapper: "US_1940_ACT",
      domicile: "United States",
      exchange: "NYSE Arca",
      tradingCurrency: "USD",
      distributionPolicy: "Distributing",
      ter: 0,
      productUrl: "https://example.com",
      holdingsUrl: "https://example.com/holdings.csv",
    } satisfies EtfShareClass,
    asOf: "2026-08-11",
    fetchedAt: "2026-08-12T08:00:00.000Z",
    sourceStatus: "cached",
    sourceUrl: "https://example.com/holdings.csv",
    cacheTtlHours: 24,
    holdings,
  };
}

function holding(
  securityId: string,
  ticker: string,
  weight: number,
  assetClass = "Equity",
): Holding {
  return {
    securityId,
    ticker,
    name: `${ticker} Inc`,
    sector: "Technology",
    assetClass,
    country: "United States",
    weight,
  };
}

test("returns zero when the ETF matches its ACWI-implied free-float weights", () => {
  const acwi = snapshot("acwi-us", "ACWI", [
    holding("A", "A", 60),
    holding("B", "B", 25),
    holding("C", "C", 15),
  ]);
  const result = analyzeHoldings(acwi, acwi);

  assert.equal(result.distortion.score, 0);
  assert.equal(result.distortion.coverageWeight, 100);
  assert.equal(result.distortion.coverageStatus, "complete");
  assert.equal(result.positions[0].distortionContribution, 0);
});

test("matches the NDX distortion formula and reconciles position contributions", () => {
  const target = snapshot("target", "TARGET", [
    holding("A", "A", 50),
    holding("B", "B", 30),
    holding("C", "C", 20),
  ]);
  const acwi = snapshot("acwi-us", "ACWI", [
    holding("A", "A", 60),
    holding("B", "B", 25),
    holding("C", "C", 15),
  ]);
  const result = analyzeHoldings(target, acwi);

  assert.equal(result.distortion.score, 10);
  assert.equal(
    result.positions.reduce(
      (sum, position) => sum + (position.distortionContribution ?? 0),
      0,
    ),
    10,
  );
  assert.equal(
    result.positions.find((position) => position.ticker === "A")?.weightDelta,
    -10,
  );
});

test("reports ACWI coverage and scores only the common equity universe", () => {
  const target = snapshot("target", "TARGET", [
    holding("A", "A", 50),
    holding("B", "B", 30),
    holding("MISSING", "MISS", 15),
    holding("CASH", "USD", 5, "Cash"),
  ]);
  const acwi = snapshot("acwi-us", "ACWI", [
    holding("A", "A", 70),
    holding("B", "B", 30),
  ]);
  const result = analyzeHoldings(target, acwi);

  assert.equal(result.distortion.coverageWeight, 84.210526);
  assert.equal(result.distortion.coverageStatus, "partial");
  assert.equal(result.distortion.coveredHoldings, 2);
  assert.equal(result.distortion.missingHoldings, 1);
  assert.equal(
    result.positions.find((position) => position.ticker === "MISS")
      ?.distortionStatus,
    "not-in-acwi",
  );
  assert.equal(
    result.positions.find((position) => position.ticker === "USD")
      ?.distortionStatus,
    "non-equity",
  );
  assert.equal(result.cashHoldingsCount, 1);
  assert.equal(result.cashWeight, 5);
  assert.equal(
    result.positions.find((position) => position.ticker === "USD")?.isCash,
    true,
  );
  assert.equal(
    result.positions.find((position) => position.ticker === "A")
      ?.normalizedWeightExCash,
    52.631579,
  );
});

test("groups cash, money-market funds and unclassified cash rows as cash", () => {
  const target = snapshot("target", "TARGET", [
    holding("A", "A", 96),
    { ...holding("USD", "USD", 1, "Cash"), name: "USD CASH" },
    { ...holding("MMF", "MMF", 2, "Money Market"), name: "Treasury fund" },
    { ...holding("EUR", "EUR", 1, "Unclassified"), name: "EUR CASH" },
  ]);
  const acwi = snapshot("acwi-us", "ACWI", [holding("A", "A", 100)]);

  const result = analyzeHoldings(target, acwi);

  assert.equal(result.cashHoldingsCount, 3);
  assert.equal(result.cashWeight, 4);
  assert.equal(
    result.positions.find((position) => position.ticker === "A")
      ?.normalizedWeightExCash,
    100,
  );
  assert.equal(
    result.positions.find((position) => position.ticker === "MMF")?.isCash,
    true,
  );
});

test("preserves borrowed cash and net asset weights while normalizing securities separately", () => {
  const target = snapshot("target", "TARGET", [
    holding("A", "A", 120),
    holding("CASH:USD", "USD", 10, "Cash"),
    holding("CASH:EUR", "EUR", -30, "Cash"),
  ]);
  const acwi = snapshot("acwi-us", "ACWI", [holding("A", "A", 100)]);
  const result = analyzeHoldings(target, acwi);
  assert.equal(result.cashHoldingsCount, 2);
  assert.equal(result.cashWeight, -20);
  assert.equal(result.positions.find((p) => p.securityId === "CASH:EUR")?.publishedWeight, -30);
  assert.equal(result.positions.find((p) => p.securityId === "CASH:EUR")?.normalizedWeightExCash, null);
  assert.equal(result.positions.find((p) => p.securityId === "A")?.publishedWeight, 120);
  assert.equal(result.positions.find((p) => p.securityId === "A")?.normalizedWeightExCash, 100);
  assert.equal(result.positions.reduce((sum, p) => sum + p.publishedWeight, 0), 100);
});

test("preserves offsetting cash currencies even when net cash is zero", () => {
  const target = snapshot("target", "TARGET", [
    holding("A", "A", 100),
    holding("CASH:USD", "USD", 20, "Cash"),
    holding("CASH:EUR", "EUR", -20, "Cash"),
  ]);
  const result = analyzeHoldings(target, target);
  assert.equal(result.cashHoldingsCount, 2);
  assert.equal(result.cashWeight, 0);
  assert.equal(result.positions.find((p) => p.securityId === "CASH:EUR")?.publishedWeight, -20);
});


test("cash display grouping preserves signed totals and canonical positions", () => {
  for (const negativeCash of [-30, -10]) {
    const target = snapshot("target", "TARGET", [
      holding("A", "A", 90 - negativeCash),
      holding("CASH:USD", "USD", 10, "Cash"),
      holding("CASH:EUR", "EUR", negativeCash, "Cash"),
    ]);
    const analysis = analyzeHoldings(target, target);
    const original = structuredClone(analysis.positions);
    const combined = holdingsCashDisplayPositions(analysis.positions, "combined");
    const separate = holdingsCashDisplayPositions(analysis.positions, "positions");
    assert.equal(combined.length, 2);
    assert.equal(combined.find((p) => p.isCash)?.publishedWeight, 10 + negativeCash);
    assert.equal(combined.reduce((sum, p) => sum + p.publishedWeight, 0), 100);
    assert.equal(separate.length, 3);
    assert.equal(separate.find((p) => p.securityId === "CASH:EUR")?.publishedWeight, negativeCash);
    assert.deepEqual(analysis.positions, original);
    assert.deepEqual(combined.filter((p) => !p.isCash), original.filter((p) => !p.isCash));
  }
});
