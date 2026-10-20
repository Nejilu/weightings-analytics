import assert from "node:assert/strict";
import test from "node:test";
import { refreshMetricSources } from "./metrics-source-refresh";
import type { Holding } from "@/domain/etf";
import type { ProviderSymbolRecord } from "@/db/repositories/metrics-repository";
import type { RefreshEstimateSeriesResult } from "./metrics-overview-estimates";

const holding = (id: string): Holding => ({ securityId: id, ticker: id, name: id,
  sector: "Technology", assetClass: "Equity", country: "United States", weight: 50 });
const record = (id: string, symbol: string): ProviderSymbolRecord => ({ securityId: id,
  providerSymbol: symbol, status: "resolved", lastVerifiedAt: new Date().toISOString(), metadata: null });
const emptyEstimates = (): RefreshEstimateSeriesResult => ({ cachedEstimateSeries: new Map(),
  estimateCoverageGaps: new Set(), warnings: [], hasLiveSource: false,
  hasPartialCoverage: false, hasStaleSource: false });
function inputs() {
  const holdings = [holding("known"), holding("new")];
  const providerSymbols = new Map([["known", record("known", "NASDAQ:KNOWN")]]);
  return {
    screener: { holdings, providerSymbols, cachedMetrics: new Map(), securityIds: ["known", "new"],
      needsRefresh: new Set(["known", "new"]),
      candidatesBySecurity: new Map([["known", ["NASDAQ:KNOWN"]], ["new", ["NASDAQ:NEW"]]]),
      candidateDetailsBySecurity: new Map(), requestedSymbols: ["NASDAQ:KNOWN", "NASDAQ:NEW"],
      missingSourceMetricTtlMs: 900_000, sourceMetricCoverageGaps: new Set<string>() },
    estimates: { holdings, providerSymbols, securityIds: ["known", "new"], ttlSeconds: 86_400,
      missingEstimateTtlMs: 900_000 },
  };
}

test("loads known estimates while Screener is pending and resolves only new symbols afterwards", { timeout: 1000 }, async () => {
  const input = inputs();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[][] = [];
  const request = refreshMetricSources(input.screener, input.estimates, {
    screener: async () => {
      await gate;
      return { providerSymbols: new Map([...input.screener.providerSymbols, ["new", record("new", "NASDAQ:NEW")]]),
        cachedMetrics: new Map(), sourceMetricCoverageGaps: new Set(), warnings: [],
        hasLiveSource: true, hasPartialCoverage: false, hasStaleSource: false };
    },
    estimates: async (plan) => {
      calls.push([...plan.securityIds]);
      if (plan.securityIds.includes("new")) assert.equal(plan.providerSymbols.get("new")?.providerSymbol, "NASDAQ:NEW");
      return emptyEstimates();
    },
  });
  assert.deepEqual(calls, [["known"]]);
  release();
  await request;
  assert.deepEqual(calls, [["known"], ["new"]]);
});

test("refetches changed mappings and does not speculate on conflicting cached symbols", async () => {
  const input = inputs();
  input.screener.candidatesBySecurity.set("known", ["NYSE:KNOWN"]);
  const calls: string[][] = [];
  await refreshMetricSources(input.screener, input.estimates, {
    screener: async () => ({ providerSymbols: new Map([["known", record("known", "NYSE:KNOWN")]]),
      cachedMetrics: new Map(), sourceMetricCoverageGaps: new Set(), warnings: [],
      hasLiveSource: true, hasPartialCoverage: true, hasStaleSource: false }),
    estimates: async (plan) => {
      calls.push([...plan.securityIds]);
      if (plan.securityIds.includes("known")) assert.equal(plan.providerSymbols.get("known")?.providerSymbol, "NYSE:KNOWN");
      return emptyEstimates();
    },
  });
  assert.deepEqual(calls, [[], ["known", "new"]]);
});

test("surfaces an estimates outage after both branches settle", async () => {
  const input = inputs();
  const failure = new Error("estimates unavailable");
  await assert.rejects(refreshMetricSources(input.screener, input.estimates, {
    screener: async () => ({ providerSymbols: input.screener.providerSymbols,
      cachedMetrics: new Map(), sourceMetricCoverageGaps: new Set(), warnings: [],
      hasLiveSource: false, hasPartialCoverage: false, hasStaleSource: false }),
    estimates: async () => { throw failure; },
  }), failure);
});

test("publishes fundamentals while known estimates are still pending", { timeout: 1000 }, async () => {
  const input = inputs();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let published = false;
  const operation = refreshMetricSources(input.screener, input.estimates, {
    screener: async () => ({ providerSymbols: input.screener.providerSymbols,
      cachedMetrics: new Map(), sourceMetricCoverageGaps: new Set(), warnings: [],
      hasLiveSource: true, hasPartialCoverage: false, hasStaleSource: false }),
    estimates: async () => { await gate; return emptyEstimates(); },
  }, () => { published = true; });
  await Promise.resolve();
  assert.equal(published, true);
  release(); await operation;
});

test("starts newly resolved symbols before the known-symbol stream finishes", { timeout: 1000 }, async () => {
  const input = inputs();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[][] = [];
  const operation = refreshMetricSources(input.screener, input.estimates, {
    screener: async () => ({ providerSymbols: new Map([...input.screener.providerSymbols,
      ["new", record("new", "NASDAQ:NEW")]]), cachedMetrics: new Map(),
      sourceMetricCoverageGaps: new Set(), warnings: [], hasLiveSource: true,
      hasPartialCoverage: false, hasStaleSource: false }),
    estimates: async (plan) => {
      calls.push([...plan.securityIds]);
      if (plan.securityIds.includes("known")) await gate;
      return emptyEstimates();
    },
  });
  await Promise.resolve();
  assert.deepEqual(calls, [["known"], ["new"]]);
  release(); await operation;
});
