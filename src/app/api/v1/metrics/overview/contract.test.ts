import assert from "node:assert/strict";
import test from "node:test";

import type { MetricsOverviewResult } from "@/domain/metrics";
import { metricsOverviewHttpResponse } from "./etag";

const result: MetricsOverviewResult = {
  calculatedAt: "2026-08-03T12:00:00.000Z",
  fundamentalsCaptureWindow: {
    oldest: "2026-08-02T08:00:00.000Z",
    latest: "2026-08-03T08:00:00.000Z",
  },
  estimatesCaptureWindow: {
    oldest: "2026-08-01T08:00:00.000Z",
    latest: "2026-08-03T09:00:00.000Z",
  },
  source: "TradingView Screener + Estimates",
  sourceStatus: "partial",
  sourceWarnings: ["estimates-partial"],
  cacheTtlHours: 24,
  definitions: [],
  etfs: [{
    etfId: "ivv-us",
    ticker: "IVV",
    name: "iShares Core S&P 500 ETF",
    asOf: "2026-07-31",
    holdingsCount: 2,
    mappedHoldings: 2,
    mappingCoverageWeight: 100,
    metrics: [{
      key: "eps_growth_estimate_forward_4q",
      value: 25,
      coverageWeight: 80,
      coveredHoldings: 1,
      totalHoldings: 2,
      captureWindow: {
        oldest: "2026-08-01T08:00:00.000Z",
        latest: "2026-08-03T09:00:00.000Z",
      },
    }],
    consensusWindows: {
      "4q": {
        quarters: 4,
        annualizationFactor: 1,
        valuationPath: Array.from({ length: 5 }, (_, index) => ({
          value: 20 - index,
          coverageWeight: 80,
          coveredHoldings: 1,
          totalHoldings: 2,
          captureWindow: null,
        })),
        growth: { value: 25, coverageWeight: 80, coveredHoldings: 1, totalHoldings: 2, captureWindow: null },
      },
      "2q": {
        quarters: 2,
        annualizationFactor: 2,
        valuationPath: Array.from({ length: 7 }, (_, index) => ({
          value: 19 - index,
          coverageWeight: 80,
          coveredHoldings: 1,
          totalHoldings: 2,
          captureWindow: null,
        })),
        growth: { value: 20, coverageWeight: 80, coveredHoldings: 1, totalHoldings: 2, captureWindow: null },
      },
      "1q": {
        quarters: 1,
        annualizationFactor: 4,
        valuationPath: Array.from({ length: 8 }, (_, index) => ({
          value: 18 - index,
          coverageWeight: 80,
          coveredHoldings: 1,
          totalHoldings: 2,
          captureWindow: null,
        })),
        growth: { value: 15, coverageWeight: 80, coveredHoldings: 1, totalHoldings: 2, captureWindow: null },
      },
    },
    componentValuation: {
      points: [{
        securityId: "security:compat",
        ticker: "COMPAT",
        name: "Compatibility Corp",
        sector: "Technology",
        country: "United States",
        providerSymbol: "NASDAQ:COMPAT",
        weight: 80,
        peHistoricalEstimate4q: 20,
        peForwardEstimate4q: 16,
        epsGrowthEstimate4q: 25,
        historicalEstimateSum: 5,
        forwardEstimateSum: 6.25,
        price: 100,
        currency: "USD",
        estimatePoints: Array.from({ length: 8 }, (_, index) => ({
          fiscalPeriod: `202${index < 4 ? 5 : 6}-Q${(index % 4) + 1}`,
          estimate: index < 4 ? 1.25 : 1.5625,
          isHistorical: index < 4,
          estimateDate: null,
          analystCount: 12,
        })),
      }],
      eligibleCount: 1,
      eligibleHoldingCount: 2,
      displayedCount: 1,
      excludedOutlierCount: 0,
      missingMetricCount: 1,
      excludedNonPositivePeCount: 0,
      truncatedCount: 0,
      representedWeight: 80,
      axisLimits: { minGrowth: -10, maxGrowth: 30, maxPe: 30 },
    },
  }],
};

test("serializes the complete published v1 metrics contract into the HTTP response", async () => {
  const response = metricsOverviewHttpResponse(result, null);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "private, max-age=60, stale-while-revalidate=300");

  const payload = await response.json() as { data: MetricsOverviewResult };
  const view = payload.data.etfs[0].componentValuation;
  const point = view.points[0];
  assert.equal(payload.data.sourceStatus, "partial");
  assert.deepEqual(payload.data.sourceWarnings, ["estimates-partial"]);
  assert.equal(view.eligibleCount, 1);
  assert.equal(view.eligibleHoldingCount, 2);
  assert.equal(view.missingMetricCount, 1);
  assert.equal(point.securityId, "security:compat");
  assert.equal(point.providerSymbol, "NASDAQ:COMPAT");
  assert.equal(point.historicalEstimateSum, 5);
  assert.equal(point.forwardEstimateSum, 6.25);
  assert.equal(point.estimatePoints.length, 8);
  assert.equal(point.estimatePoints.filter((item) => item.isHistorical).length, 4);
  assert.equal(payload.data.etfs[0].consensusWindows["2q"].annualizationFactor, 2);
  assert.equal(payload.data.etfs[0].consensusWindows["2q"].valuationPath.length, 7);
  assert.equal(payload.data.etfs[0].consensusWindows["1q"].valuationPath.length, 8);
});

test("invalidates the HTTP ETag for any serialized contract change", async () => {
  const first = metricsOverviewHttpResponse(result, null);
  const firstEtag = first.headers.get("etag");
  assert.ok(firstEtag);

  const conditional = metricsOverviewHttpResponse(result, firstEtag);
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");

  const changed: MetricsOverviewResult = {
    ...result,
    etfs: [{
      ...result.etfs[0],
      componentValuation: {
        ...result.etfs[0].componentValuation,
        missingMetricCount: 2,
      },
    }],
  };
  const changedResponse = metricsOverviewHttpResponse(changed, firstEtag);
  assert.equal(changedResponse.status, 200);
  assert.notEqual(changedResponse.headers.get("etag"), firstEtag);
});
