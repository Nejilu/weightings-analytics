import assert from "node:assert/strict";
import test from "node:test";

import type { Holding, HoldingsSnapshot } from "../etf";
import { compareHoldings } from "./compare-holdings";

function snapshot(ticker: string, holdings: Holding[]): HoldingsSnapshot {
  return {
    etf: {
      id: `${ticker.toLowerCase()}-test`,
      ticker,
      name: ticker,
      benchmarkId: "test",
      isin: `TEST-${ticker}`,
      wrapper: "UCITS",
      domicile: "Test",
      exchange: "Test",
      tradingCurrency: "USD",
      distributionPolicy: "Accumulating",
      ter: 0,
      productUrl: "https://example.com",
      holdingsUrl: "https://example.com/holdings.csv",
    },
    asOf: "2026-07-31",
    fetchedAt: "2026-07-31T00:00:00.000Z",
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
): Holding {
  return {
    securityId,
    ticker,
    name: ticker,
    sector: "Test",
    assetClass: "Equity",
    country: "Test",
    weight,
  };
}

test("calculates overlap before rounding individual positions", () => {
  const left = Array.from({ length: 300 }, (_, index) =>
    holding(`S${index}`, `L${index}`, 1 / 3),
  );
  const right = Array.from({ length: 300 }, (_, index) =>
    holding(`S${index}`, `R${index}`, 1 / 3),
  );

  const result = compareHoldings(snapshot("LEFT", left), snapshot("RIGHT", right));

  assert.equal(result.overlapWeight, 100);
  assert.equal(result.leftActiveWeight, 0);
  assert.equal(result.rightActiveWeight, 0);
});

test("normalises each implicit active sleeve to exactly 100%", () => {
  const result = compareHoldings(
    snapshot("LEFT", [
      holding("A", "A", 60),
      holding("B", "B", 40),
    ]),
    snapshot("RIGHT", [
      holding("A", "A", 20),
      holding("C", "C", 80),
    ]),
  );

  for (const sleeve of Object.values(result.implicitSleeves)) {
    const total = sleeve.positions.reduce(
      (sum, position) => sum + position.normalizedWeight,
      0,
    );
    assert.equal(total, 100);
  }
  assert.equal(result.implicitSleeves.left.positions[0].ticker, "A");
  assert.equal(result.implicitSleeves.right.positions[0].ticker, "C");
});

test("uses market values to preserve differences hidden by rounded source weights", () => {
  const result = compareHoldings(
    snapshot("LEFT", [
      { ...holding("A", "A", 50), marketValue: 5_000.4 },
      { ...holding("B", "B", 50), marketValue: 4_999.6 },
    ]),
    snapshot("RIGHT", [
      { ...holding("A", "A", 50), marketValue: 4_999.6 },
      { ...holding("B", "B", 50), marketValue: 5_000.4 },
    ]),
  );

  const leftActive = result.positions.find(
    (position) => position.ticker === "A",
  );
  const rightActive = result.positions.find(
    (position) => position.ticker === "B",
  );

  assert.equal(leftActive?.leftActiveWeight, 0.008);
  assert.equal(rightActive?.rightActiveWeight, 0.008);
  assert.equal(result.implicitSleeves.left.positions[0].normalizedWeight, 100);
  assert.equal(result.implicitSleeves.right.positions[0].normalizedWeight, 100);
});

test("falls back to official weights when market values are incomplete", () => {
  const result = compareHoldings(
    snapshot("LEFT", [
      { ...holding("A", "A", 60), marketValue: 1_000 },
      holding("B", "B", 40),
    ]),
    snapshot("RIGHT", [
      holding("A", "A", 60),
      holding("B", "B", 40),
    ]),
  );

  assert.equal(result.overlapWeight, 100);
  assert.equal(result.leftActiveWeight, 0);
});

test("excludes cash by default and includes it only when requested", () => {
  const cash = {
    ...holding("CASH:USD", "USD", 50),
    name: "USD CASH",
    assetClass: "Cash",
  };
  const result = compareHoldings(
    snapshot("LEFT", [holding("A", "A", 50), cash]),
    snapshot("RIGHT", [holding("A", "A", 100)]),
  );

  assert.equal(result.overlapWeight, 100);
  assert.equal(result.leftActiveWeight, 0);
  assert.equal(result.rightActiveWeight, 0);
  assert.equal(result.left.holdingsCount, 1);
  assert.equal(result.left.top10Concentration, 100);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].ticker, "A");

  const withCash = compareHoldings(
    snapshot("LEFT", [holding("A", "A", 50), cash]),
    snapshot("RIGHT", [holding("A", "A", 100)]),
    { includeCash: true },
  );
  assert.equal(withCash.overlapWeight, 50);
  assert.equal(withCash.leftActiveWeight, 50);
  assert.equal(withCash.rightActiveWeight, 50);
  assert.equal(withCash.left.holdingsCount, 2);
  assert.equal(withCash.positions.some((position) => position.ticker === "USD"), true);
});

test("shows Alphabet share classes as one economic position", () => {
  const result = compareHoldings(
    snapshot("LEFT", [
      holding("alphabet-a", "GOOGL", 20),
      holding("alphabet-c", "GOOG", 30),
      holding("other", "OTHER", 50),
    ]),
    snapshot("RIGHT", [
      holding("alphabet-a", "GOOGL", 40),
      holding("other", "OTHER", 60),
    ]),
  );

  const alphabet = result.positions.find(
    (position) => position.ticker === "GOOG / GOOGL",
  );
  assert.equal(alphabet?.leftWeight, 50);
  assert.equal(alphabet?.rightWeight, 40);
  assert.equal(result.left.holdingsCount, 2);
  assert.equal(result.right.holdingsCount, 2);
});

test("keeps 2x exposure when comparing a leveraged ETF with its source", () => {
  const qld = snapshot("QLD", [holding("A", "A", 200)]);
  qld.etf.exposureMultiplier = 2;
  const result = compareHoldings(
    qld,
    snapshot("IQQ", [holding("A", "A", 100)]),
  );

  assert.equal(result.positions[0].leftWeight, 200);
  assert.equal(result.positions[0].rightWeight, 100);
  assert.equal(result.overlapWeight, 100);
  assert.equal(result.leftActiveWeight, 100);
  assert.equal(result.rightActiveWeight, 0);
});
