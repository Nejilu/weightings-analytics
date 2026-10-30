import assert from "node:assert/strict";
import test from "node:test";
import type { Holding, HoldingsSnapshot } from "@/domain/etf";
import type { SecurityMetricValues } from "@/domain/metrics";
import { compareHoldings } from "@/domain/processors/compare-holdings";
import { buildTargetAssetPairs, targetAssetSnapshot } from "./target-asset-metrics-model";

const holding = (id: string, weight: number, ticker = id): Holding => ({
  securityId: id, ticker, name: id, weight, sector: "Technology", country: "US", assetClass: "Equity",
});
const snapshot = (id: string, holdings: Holding[]): HoldingsSnapshot => ({
  etf: { id, ticker: id, name: id }, holdings, asOf: "2026-10-30",
  fetchedAt: "2026-10-30T00:00:00Z", sourceStatus: "cached", sourceUrl: "fixture://test", cacheTtlHours: 24,
} as HoldingsSnapshot);
const values = (id: string, pe: number): SecurityMetricValues => ({
  securityId: id, providerSymbol: `NASDAQ:${id}`, values: { price_earnings_ttm: pe },
  estimateSeries: {
    providerSymbol: `NASDAQ:${id}`, currency: "USD", price: 120,
    points: Array.from({ length: 8 }, (_, index) => ({
      fiscalPeriod: `Q${index}`, estimate: index < 4 ? 2 : 3, isHistorical: index < 4,
      estimateDate: null, analystCount: 10,
    })),
  },
});

test("uses Comparison residual weights for fundamentals, consensus and constituent weights", () => {
  const left = snapshot("LEFT", [holding("A", 60), holding("B", 30), holding("C", 10)]);
  const right = snapshot("RIGHT", [holding("A", 20), holding("B", 20), holding("C", 60)]);
  const metrics = new Map([values("A", 10), values("B", 40), values("C", 30)].map((v) => [v.securityId, v]));
  const [pair] = buildTargetAssetPairs([left, right], new Set(metrics.keys()), metrics);
  assert.equal(pair.overlapWeight, 50);
  const [a, b] = pair.assets;
  assert.equal(a.sourceActiveWeight, 50);
  assert.equal(a.relativeToEtfId, "RIGHT");
  assert.equal(a.mappingCoverageWeight, 100);
  assert.equal(a.holdingsCount, 2);
  assert.ok(Math.abs(a.metrics.find((m) => m.key === "price_earnings_ttm")!.value! - 100 / (80 / 10 + 20 / 40)) < 0.001);
  assert.equal(b.metrics.find((m) => m.key === "price_earnings_ttm")!.value, 30);
  assert.deepEqual(a.componentValuation.points.map((p) => [p.securityId, p.weight]), [["A", 80], ["B", 20]]);
  assert.equal(a.consensusWindows["1q"].valuationPath[4].value, 10);
  assert.equal(a.consensusWindows["4q"].growth.coverageWeight, 100);
  assert.deepEqual(left.holdings.map((h) => h.weight), [60, 30, 10]);
});

test("nets equivalent issuers while retaining original share-class metrics and missing coverage", () => {
  const left = snapshot("LEFT", [holding("class-a", 40, "GOOGL"), holding("class-c", 20, "GOOG"), holding("B", 40)]);
  const right = snapshot("RIGHT", [holding("class-c", 30, "GOOG"), holding("B", 70)]);
  const sleeve = compareHoldings(left, right).implicitSleeves.left;
  const target = targetAssetSnapshot(left, sleeve);
  assert.deepEqual(target.holdings.map((h) => h.securityId), ["class-a", "class-c"]);
  assert.ok(Math.abs(target.holdings[0].weight - 200 / 3) < 1e-8);
  assert.equal(target.holdings.reduce((sum, h) => sum + h.weight, 0), 100);
  const metric = values("class-a", 10);
  const [pair] = buildTargetAssetPairs([left, right], new Set(["class-a"]), new Map([["class-a", metric]]));
  assert.ok(Math.abs(pair.assets[0].mappingCoverageWeight - 200 / 3) < 1e-8);
  assert.equal(pair.assets[0].mappedHoldings, 1);
  assert.equal(pair.assets[0].metrics.find((m) => m.key === "price_earnings_ttm")!.value, 10);
});

test("identical ETFs return empty targets and unavailable metrics instead of full ETF metrics", () => {
  const left = snapshot("LEFT", [holding("A", 100)]);
  const [pair] = buildTargetAssetPairs([left, snapshot("RIGHT", left.holdings)], new Set(["A"]), new Map([["A", values("A", 10)]]));
  for (const asset of pair.assets) {
    assert.equal(asset.sourceActiveWeight, 0);
    assert.equal(asset.holdingsCount, 0);
    assert.equal(asset.mappingCoverageWeight, 0);
    assert.ok(asset.metrics.every((m) => m.value === null));
    assert.equal(asset.componentValuation.points.length, 0);
  }
});

test("builds every pair for three or four ETFs and none for a single ETF", () => {
  const snapshots = ["A", "B", "C", "D"].map((id) => snapshot(id, [holding(id, 100)]));
  assert.equal(buildTargetAssetPairs(snapshots, new Set(), new Map()).length, 6);
  assert.equal(buildTargetAssetPairs(snapshots.slice(0, 3), new Set(), new Map()).length, 3);
  assert.equal(buildTargetAssetPairs(snapshots.slice(0, 1), new Set(), new Map()).length, 0);
});

test("retains tiny active exposures revealed by market values and excludes cash", () => {
  const left = snapshot("LEFT", [
    { ...holding("A", 50), marketValue: 5000.4 },
    { ...holding("B", 50), marketValue: 4999.6 },
    { ...holding("CASH", 5), assetClass: "Cash" },
  ]);
  const right = snapshot("RIGHT", [
    { ...holding("A", 50), marketValue: 4999.6 },
    { ...holding("B", 50), marketValue: 5000.4 },
  ]);
  const [pair] = buildTargetAssetPairs([left, right], new Set(["A", "B"]), new Map([
    ["A", values("A", 10)], ["B", values("B", 40)],
  ]));
  assert.ok(Math.abs(pair.assets[0].sourceActiveWeight - 0.008) < 1e-8);
  assert.deepEqual(pair.assets[0].componentValuation.points.map((p) => [p.securityId, p.weight]), [["A", 100]]);
  assert.deepEqual(pair.assets[1].componentValuation.points.map((p) => [p.securityId, p.weight]), [["B", 100]]);
});
