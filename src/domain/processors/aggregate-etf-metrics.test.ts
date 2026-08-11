import assert from "node:assert/strict";
import test from "node:test";

import type { Holding } from "@/domain/etf";
import type { SecurityEstimateSeries, SecurityMetricValues } from "@/domain/metrics";
import { aggregateConsensusWindow, aggregateEtfMetrics } from "./aggregate-etf-metrics";

function holding(securityId: string, weight: number, assetClass = "Equity"): Holding {
  return {
    securityId,
    ticker: securityId,
    name: securityId,
    sector: "Test",
    assetClass,
    country: "United States",
    weight,
  };
}

function estimateSeries(
  providerSymbol: string,
  historicalEstimate: number,
  forwardEstimate: number,
): SecurityEstimateSeries {
  return {
    providerSymbol,
    currency: "USD",
    price: 100,
    points: Array.from({ length: 8 }, (_, index) => ({
      fiscalPeriod: `${index < 4 ? "2025" : "2026"}-Q${(index % 4) + 1}`,
      estimate: index < 4 ? historicalEstimate : forwardEstimate,
      isHistorical: index < 4,
      estimateDate: null,
      analystCount: 10,
    })),
  };
}

test("calculates a holding-weighted harmonic P/E on covered equity weight", () => {
  const values = new Map<string, SecurityMetricValues>([
    ["A", { securityId: "A", providerSymbol: "NASDAQ:A", values: { pe_estimate_window_4: 10 } }],
    ["B", { securityId: "B", providerSymbol: "NYSE:B", values: { pe_estimate_window_4: 20 } }],
  ]);
  const result = aggregateEtfMetrics([
    holding("A", 60),
    holding("B", 20),
    holding("MISSING", 20),
    holding("CASH", 5, "Cash"),
  ], values).find((metric) => metric.key === "pe_estimate_window_4");

  assert.ok(Math.abs((result?.value ?? 0) - 80 / 7) < 0.0001);
  assert.equal(result?.coverageWeight, 80);
  assert.equal(result?.coveredHoldings, 2);
  assert.equal(result?.totalHoldings, 3);
});

test("uses harmonic aggregation for market-cap valuation ratios and arithmetic aggregation for yields", () => {
  const values = new Map<string, SecurityMetricValues>([
    ["A", { securityId: "A", providerSymbol: "NASDAQ:A", values: { price_to_book: 10, price_to_sales: 5, dividend_yield: 2 } }],
    ["B", { securityId: "B", providerSymbol: "NYSE:B", values: { price_to_book: 20, price_to_sales: 10, dividend_yield: 4 } }],
  ]);
  const result = aggregateEtfMetrics([holding("A", 60), holding("B", 20)], values);

  assert.ok(Math.abs((result.find((metric) => metric.key === "price_to_book")?.value ?? 0) - 80 / 7) < 0.0001);
  assert.ok(Math.abs((result.find((metric) => metric.key === "price_to_sales")?.value ?? 0) - 80 / 14) < 0.0001);
  assert.equal(result.find((metric) => metric.key === "dividend_yield")?.value, 2.5);
});

test("reconstructs ETF earnings growth from historical and forward earnings yields", () => {
  const values = new Map<string, SecurityMetricValues>([
    ["A", {
      securityId: "A",
      providerSymbol: "NASDAQ:A",
      values: { pe_estimate_window_0: 10, pe_estimate_window_4: 20 },
    }],
    ["B", {
      securityId: "B",
      providerSymbol: "NYSE:B",
      values: { pe_estimate_window_0: 20, pe_estimate_window_4: 10 },
    }],
  ]);
  const result = aggregateEtfMetrics([holding("A", 60), holding("B", 20)], values)
    .find((metric) => metric.key === "eps_growth_estimate_forward_4q");

  // (0.6 / 20 + 0.2 / 10) / (0.6 / 10 + 0.2 / 20) - 1 = -28.5714%.
  assert.ok(Math.abs((result?.value ?? 0) - (-28.5714285714)) < 0.0001);
  // The former weighted average of individual growth rates would be -12.5%.
  assert.ok(Math.abs((result?.value ?? 0) - (-12.5)) > 1);
  assert.equal(result?.coverageWeight, 100);
  assert.equal(result?.coveredHoldings, 2);
  assert.equal(result?.totalHoldings, 2);
});

test("excludes non-positive P/E from earnings-yield growth and exposes coverage", () => {
  const values = new Map<string, SecurityMetricValues>([
    ["A", {
      securityId: "A",
      providerSymbol: "NASDAQ:A",
      values: { pe_estimate_window_0: 10, pe_estimate_window_4: 20 },
    }],
    ["LOSS", {
      securityId: "LOSS",
      providerSymbol: "NASDAQ:LOSS",
      values: { pe_estimate_window_0: -5, pe_estimate_window_4: 8 },
    }],
  ]);
  const result = aggregateEtfMetrics([holding("A", 70), holding("LOSS", 30)], values)
    .find((metric) => metric.key === "eps_growth_estimate_forward_4q");

  assert.equal(result?.coverageWeight, 70);
  assert.equal(result?.coveredHoldings, 1);
  assert.ok(Math.abs((result?.value ?? 0) - (-50)) < 0.0001);
});

test("keeps extreme but finite earnings-yield growth instead of clipping it", () => {
  const values = new Map<string, SecurityMetricValues>([[
    "EXTREME",
    {
      securityId: "EXTREME",
      providerSymbol: "NASDAQ:EXTREME",
      values: { pe_estimate_window_0: 100, pe_estimate_window_4: 1 },
    },
  ]]);
  const result = aggregateEtfMetrics([holding("EXTREME", 100)], values)
    .find((metric) => metric.key === "eps_growth_estimate_forward_4q");

  assert.ok(Math.abs((result?.value ?? 0) - 9_900) < 0.0001);
  assert.equal(result?.coverageWeight, 100);
});

test("returns no aggregate growth when every historical or forward P/E is zero", () => {
  const values = new Map<string, SecurityMetricValues>([
    ["ZERO-HIST", {
      securityId: "ZERO-HIST",
      providerSymbol: "NASDAQ:ZEROH",
      values: { pe_estimate_window_0: 0, pe_estimate_window_4: 10 },
    }],
    ["ZERO-FWD", {
      securityId: "ZERO-FWD",
      providerSymbol: "NASDAQ:ZEROF",
      values: { pe_estimate_window_0: 10, pe_estimate_window_4: 0 },
    }],
  ]);
  const result = aggregateEtfMetrics([
    holding("ZERO-HIST", 50),
    holding("ZERO-FWD", 50),
  ], values).find((metric) => metric.key === "eps_growth_estimate_forward_4q");

  assert.equal(result?.value, null);
  assert.equal(result?.coverageWeight, 0);
  assert.equal(result?.coveredHoldings, 0);
});

test("aggregates annualized one-quarter consensus with common growth coverage", () => {
  const values = new Map<string, SecurityMetricValues>([
    ["A", {
      securityId: "A",
      providerSymbol: "NASDAQ:A",
      values: {},
      estimateSeries: estimateSeries("NASDAQ:A", 2, 3),
    }],
    ["B", {
      securityId: "B",
      providerSymbol: "NYSE:B",
      values: {},
      estimateSeries: estimateSeries("NYSE:B", 1, 2),
    }],
  ]);
  const result = aggregateConsensusWindow(
    [holding("A", 60), holding("B", 20), holding("MISSING", 20)],
    values,
    1,
  );

  assert.equal(result.annualizationFactor, 4);
  assert.equal(result.valuationPath.length, 8);
  assert.ok(Math.abs((result.valuationPath[3].value ?? 0) - 80 / 5.6) < 1e-9);
  assert.ok(Math.abs((result.valuationPath[4].value ?? 0) - 80 / 8.8) < 1e-9);
  assert.ok(Math.abs((result.growth.value ?? 0) - (8.8 / 5.6 - 1) * 100) < 1e-9);
  assert.equal(result.growth.coverageWeight, 80);
  assert.equal(result.growth.coveredHoldings, 2);
  assert.equal(result.growth.totalHoldings, 3);
});
