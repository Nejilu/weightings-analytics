import assert from "node:assert/strict";
import test from "node:test";

import type { Holding, HoldingsSnapshot } from "@/domain/etf";
import type { SecurityEstimateSeries, SecurityMetricValues } from "@/domain/metrics";
import type { PortfolioItem, PortfolioSecurity } from "@/domain/portfolio";
import { analyzePortfolio } from "@/domain/processors/analyze-portfolio";
import {
  buildComponentValuation,
  buildEtfMetricsOverview,
} from "./metrics-overview-model";

const holding = (securityId: string, weight: number): Holding => ({
  securityId,
  ticker: securityId,
  name: `${securityId} Corporation`,
  sector: "Technology",
  assetClass: "Equity",
  country: "United States",
  exchange: "NASDAQ",
  weight,
});

const series: SecurityEstimateSeries = {
  providerSymbol: "NASDAQ:COMPAT",
  currency: "USD",
  price: 100,
  points: Array.from({ length: 8 }, (_, index) => ({
    fiscalPeriod: `202${index < 4 ? 4 : 5}-Q${(index % 4) + 1}`,
    estimate: index < 4 ? 2 : 3,
    isHistorical: index < 4,
    estimateDate: null,
    analystCount: 10,
  })),
};

test("retains the published v1 component fields while exposing transparent counts", () => {
  const values: SecurityMetricValues = {
    securityId: "COMPAT",
    providerSymbol: series.providerSymbol,
    values: {
      pe_estimate_window_0: 12.5,
      pe_estimate_window_4: 8.33,
      eps_growth_estimate_forward_4q: 50,
    },
    estimateSeries: series,
  };
  const view = buildComponentValuation(
    [holding("COMPAT", 80), holding("MISSING", 20)],
    new Map([["COMPAT", values]]),
  );

  assert.equal(view.eligibleCount, 1);
  assert.equal(view.eligibleHoldingCount, 2);
  assert.equal(view.displayedCount, 1);
  assert.equal(view.missingMetricCount, 1);
  assert.equal(view.excludedNonPositivePeCount, 0);
  assert.equal(view.truncatedCount, 0);
  assert.equal(view.excludedOutlierCount, 0);
  assert.equal(view.points[0]?.securityId, "COMPAT");
  assert.equal(view.points[0]?.providerSymbol, "NASDAQ:COMPAT");
  assert.equal(view.points[0]?.historicalEstimateSum, 8);
  assert.equal(view.points[0]?.forwardEstimateSum, 12);
  assert.deepEqual(view.points[0]?.estimatePoints, series.points);
  assert.equal(view.points[0]?.epsGrowthNextQuarterVsQMinus3, 50);
  assert.equal(view.points[0]?.peQMinus3Annualized, 100 / 8);
  assert.equal(view.points[0]?.peNextQuarterAnnualized, 100 / 12);
});

test("keeps finite extreme component growth visible with dynamic axes", () => {
  const extreme: SecurityMetricValues = {
    securityId: "EXTREME",
    providerSymbol: "NASDAQ:EXTREME",
    values: {
      pe_estimate_window_0: 100,
      pe_estimate_window_4: 1,
      eps_growth_estimate_forward_4q: 9_900,
    },
    estimateSeries: {
      ...series,
      providerSymbol: "NASDAQ:EXTREME",
      points: series.points.map((point, index) =>
        index === 0 ? { ...point, estimate: 0.03 } : point),
    },
  };
  const view = buildComponentValuation(
    [holding("EXTREME", 100)],
    new Map([["EXTREME", extreme]]),
  );

  assert.equal(view.displayedCount, 1);
  assert.equal(view.excludedOutlierCount, 0);
  assert.equal(view.points[0]?.ticker, "EXTREME");
  assert.equal(view.axisLimits.maxGrowth, 9_900);
});

test("does not require legacy 4Q valuation fields for the fixed bubble measures", () => {
  const fixedMeasuresOnly: SecurityMetricValues = {
    securityId: "FIXED",
    providerSymbol: "NASDAQ:FIXED",
    values: {},
    estimateSeries: { ...series, providerSymbol: "NASDAQ:FIXED" },
  };
  const view = buildComponentValuation(
    [holding("FIXED", 100)],
    new Map([["FIXED", fixedMeasuresOnly]]),
  );

  assert.equal(view.displayedCount, 1);
  assert.equal(view.points[0]?.peHistoricalEstimate4q, null);
  assert.equal(view.points[0]?.epsGrowthEstimate4q, null);
  assert.equal(view.points[0]?.epsGrowthNextQuarterVsQMinus3, 50);
  assert.equal(view.points[0]?.peQMinus3Annualized, 100 / 8);
  assert.equal(view.points[0]?.peNextQuarterAnnualized, 100 / 12);
});

test("keeps portfolio share classes canonical through mapping and bubble metrics", () => {
  const alphabetA: PortfolioSecurity = {
    securityId: "US02079K3059",
    ticker: "GOOGL",
    name: "ALPHABET CLASS A",
    sector: "Communication",
    assetClass: "Equity",
    country: "United States",
  };
  const alphabetC: PortfolioSecurity = {
    securityId: "US02079K1079",
    ticker: "GOOG",
    name: "ALPHABET CLASS C",
    sector: "Communication",
    assetClass: "Equity",
    country: "United States",
  };
  const sourceSnapshot = {
    etf: { id: "source", ticker: "SOURCE" },
    asOf: "2026-08-19",
    fetchedAt: "2026-08-19T00:00:00.000Z",
    sourceStatus: "cached",
    sourceUrl: "fixture://source",
    cacheTtlHours: 24,
    holdings: [
      { ...alphabetA, weight: 55 },
      { ...alphabetC, weight: 45 },
    ],
  } as HoldingsSnapshot;
  const items: PortfolioItem[] = [{
    id: "source-item",
    kind: "etf",
    referenceId: "source",
    ticker: "SOURCE",
    name: "Source ETF",
    allocationWeight: 100,
  }];
  const analysis = analyzePortfolio({
    items,
    etfSnapshots: new Map([["source", sourceSnapshot]]),
    directSecurities: new Map(),
  });
  const portfolioSnapshot = {
    ...sourceSnapshot,
    etf: { id: "portfolio", ticker: "PF", name: "Portfolio ETF" },
    holdings: analysis.positions.map((position) => ({
      securityId: position.securityId,
      ticker: position.ticker,
      name: position.name,
      sector: position.sector,
      assetClass: position.assetClass,
      country: position.country,
      weight: position.weight,
    })),
  } as HoldingsSnapshot;
  const metrics = new Map<string, SecurityMetricValues>([
    [alphabetA.securityId, {
      securityId: alphabetA.securityId,
      providerSymbol: "NASDAQ:GOOGL",
      values: {},
      estimateSeries: { ...series, providerSymbol: "NASDAQ:GOOGL" },
    }],
    [alphabetC.securityId, {
      securityId: alphabetC.securityId,
      providerSymbol: "NASDAQ:GOOG",
      values: {},
      estimateSeries: { ...series, providerSymbol: "NASDAQ:GOOG" },
    }],
  ]);

  const overview = buildEtfMetricsOverview(
    portfolioSnapshot,
    new Set([alphabetA.securityId, alphabetC.securityId]),
    metrics,
  );

  assert.equal(overview.mappingCoverageWeight, 100);
  assert.equal(overview.mappedHoldings, 2);
  assert.deepEqual(
    overview.componentValuation.points.map(({ securityId, ticker }) => ({
      securityId,
      ticker,
    })),
    [
      { securityId: alphabetA.securityId, ticker: "GOOGL" },
      { securityId: alphabetC.securityId, ticker: "GOOG" },
    ],
  );
});
