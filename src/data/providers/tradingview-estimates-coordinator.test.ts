import assert from "node:assert/strict";
import test from "node:test";
import type { SecurityEstimateSeries } from "@/domain/metrics";
import { EstimateRequestCoordinator } from "./tradingview-estimates-coordinator";

const series = (providerSymbol: string) => ({ providerSymbol, currency: "USD", price: 100,
  points: [] }) satisfies SecurityEstimateSeries;

test("shares overlapping symbols across requests and bounds all batches together", async () => {
  const coordinator = new EstimateRequestCoordinator(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[][] = [];
  const fetcher = async (symbols: string[]) => { calls.push(symbols); await gate; return symbols.map(series); };
  const first = coordinator.fetch(["A", "B"], fetcher);
  const second = coordinator.fetch(["B", "C"], fetcher);
  assert.deepEqual(calls, [["A", "B"]]);
  release();
  assert.deepEqual((await first).series.map((item) => item.providerSymbol), ["A", "B"]);
  assert.deepEqual((await second).series.map((item) => item.providerSymbol), ["B", "C"]);
  assert.deepEqual(calls, [["A", "B"], ["C"]]);
  // Completion removes every entry: the next request must fetch fresh data.
  await coordinator.fetch(["B"], fetcher);
  assert.deepEqual(calls[2], ["B"]);
});

test("keeps successful shared symbols when another batch fails and permits a retry", async () => {
  const coordinator = new EstimateRequestCoordinator(2);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = coordinator.fetch(["A", "B"], async () => { await gate; throw new Error("transport"); });
  const second = coordinator.fetch(["B", "C"], async (symbols) => symbols.map(series));
  release();
  assert.deepEqual((await first).failedSymbols, ["A", "B"]);
  const result = await second;
  assert.deepEqual(result.failedSymbols, ["B"]);
  assert.deepEqual(result.series.map((item) => item.providerSymbol), ["C"]);
  assert.deepEqual((await coordinator.fetch(["B"], async (symbols) => symbols.map(series))).failedSymbols, []);
});

test("handles empty coverage and a synchronous transport failure without retaining work", async () => {
  const coordinator = new EstimateRequestCoordinator(1);
  assert.deepEqual(await coordinator.fetch(["EMPTY"], async () => []), { series: [], failedSymbols: [] });
  assert.deepEqual((await coordinator.fetch(["FAIL"], () => { throw new Error("sync"); })).failedSymbols, ["FAIL"]);
  assert.deepEqual((await coordinator.fetch(["FAIL"], async (symbols) => symbols.map(series))).failedSymbols, []);
});
