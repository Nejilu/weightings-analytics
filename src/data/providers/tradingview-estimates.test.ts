import assert from "node:assert/strict";
import test from "node:test";

import type { SecurityEstimateSeries } from "@/domain/metrics";

import {
  fetchTradingViewEstimateSeriesDetailed,
  fetchTradingViewEstimateSeries,
  parseTradingViewEstimateSeries,
  parseTradingViewFrames,
} from "./tradingview-estimates";

test("parses framed TradingView messages", () => {
  const first = JSON.stringify({ m: "one" });
  const second = "~h~123";
  assert.deepEqual(
    parseTradingViewFrames(`~m~${first.length}~m~${first}~m~${second.length}~m~${second}`),
    [first, second],
  );
});

test("selects four historical estimates and four future estimates without using Actual", () => {
  const points = Array.from({ length: 10 }, (_, index) => ({
    Actual: 1_000 + index,
    Estimate: { average: index + 1, date: 1_700_000_000 + index, est_num: 20 + index },
    FiscalPeriod: `Q${index + 1}`,
    IsReported: index < 6,
  }));
  const result = parseTradingViewEstimateSeries("NASDAQ:TEST", {
    lp: 100,
    currency_code: "USD",
    eps_estimates_fq_h: points,
  });
  assert.deepEqual(result?.points.map((point) => point.estimate), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(result?.points.some((point) => point.estimate >= 1_000), false);
});

test("keeps malformed estimate dates nullable instead of throwing", () => {
  const points = Array.from({ length: 8 }, (_, index) => ({
    Estimate: {
      average: index + 1,
      date: index === 0 ? Number.MAX_VALUE : 1_700_000_000 + index,
      est_num: 20,
    },
    FiscalPeriod: `Q${index + 1}`,
    IsReported: index < 4,
  }));
  const result = parseTradingViewEstimateSeries("NASDAQ:TEST", {
    lp: 100,
    currency_code: "USD",
    eps_estimates_fq_h: points,
  });
  assert.equal(result?.points[0]?.estimateDate, null);
});

test("rejects estimate points without an explicit reported flag", () => {
  const points = Array.from({ length: 8 }, (_, index) => ({
    Estimate: { average: index + 1, date: 1_700_000_000 + index, est_num: 20 },
    FiscalPeriod: `Q${index + 1}`,
    ...(index === 3 ? {} : { IsReported: index < 4 }),
  }));
  assert.equal(parseTradingViewEstimateSeries("NASDAQ:TEST", {
    lp: 100,
    currency_code: "USD",
    eps_estimates_fq_h: points,
}), null);
});

test("rejects duplicate fiscal periods before persistence", () => {
  const points = Array.from({ length: 8 }, (_, index) => ({
    Estimate: { average: index + 1, date: 1_700_000_000 + index, est_num: 20 },
    FiscalPeriod: index === 7 ? "Q1" : `Q${index + 1}`,
    IsReported: index < 4,
  }));
  assert.equal(parseTradingViewEstimateSeries("NASDAQ:TEST", {
    lp: 100,
    currency_code: "USD",
    eps_estimates_fq_h: points,
  }), null);
});

function validSeries(providerSymbol: string): SecurityEstimateSeries {
  return {
    providerSymbol,
    currency: "USD",
    price: 100,
    points: Array.from({ length: 8 }, (_, index) => ({
      fiscalPeriod: `2026-Q${index + 1}`,
      estimate: index + 1,
      isHistorical: index < 4,
      estimateDate: null,
      analystCount: null,
    })),
  };
}

test("does not count an empty estimate batch as a successful provider response", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
  process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = "25";
  try {
    const symbols = Array.from({ length: 50 }, (_, index) =>
      `NASDAQ:TEST${String(index).padStart(3, "0")}`,
    );
    const result = await fetchTradingViewEstimateSeries(symbols, async (batch) =>
      batch[0]?.endsWith("000")
        ? []
        : batch.map((symbol) => validSeries(symbol)),
    );
    assert.equal(result.length, 25);
    assert.ok(result.every((series) => Number(series.providerSymbol.match(/\d+$/)?.[0]) >= 25));
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
    else process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = previousBatchSize;
  }
});

test("returns an empty result when every estimate batch has no EPS coverage", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
  process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = "25";
  try {
    const result = await fetchTradingViewEstimateSeries(
      Array.from({ length: 25 }, (_, index) => `NASDAQ:EMPTY${index}`),
      async () => [],
    );
    assert.deepEqual(result, []);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
    else process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = previousBatchSize;
  }
});

test("still fails when every estimate batch raises a provider error", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
  process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = "25";
  try {
    await assert.rejects(
      fetchTradingViewEstimateSeries(
        Array.from({ length: 25 }, (_, index) => `NASDAQ:ERROR${index}`),
        async () => { throw new Error("socket unavailable"); },
      ),
      /unavailable for all batches: socket unavailable/,
    );
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
    else process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = previousBatchSize;
  }
});

test("does not negative-cache estimate symbols from a failed partial batch", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
  process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = "25";
  try {
    const symbols = Array.from({ length: 50 }, (_, index) =>
      `NASDAQ:PARTIAL${String(index).padStart(3, "0")}`,
    );
    const result = await fetchTradingViewEstimateSeriesDetailed(symbols, async (batch) => {
      if (batch[0]?.endsWith("000")) throw new Error("socket unavailable");
      return batch.map((symbol) => validSeries(symbol));
    });
    assert.equal(result.series.length, 25);
    assert.equal(result.missingSymbols.length, 0);
    assert.equal(result.failedSymbols.length, 25);
    assert.ok(result.failedSymbols.every((symbol) => symbol.includes("PARTIAL")));
    assert.equal(result.batchCount, 2);
    assert.equal(result.completedBatchCount, 1);
    assert.equal(result.nonEmptyBatchCount, 1);
    assert.equal(result.failedBatchCount, 1);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
    else process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = previousBatchSize;
  }
});

test("uses five estimate batches concurrently by default", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
  const previousConcurrency = process.env.TRADINGVIEW_ESTIMATES_CONCURRENCY;
  process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = "25";
  delete process.env.TRADINGVIEW_ESTIMATES_CONCURRENCY;
  let activeBatches = 0;
  let maximumActiveBatches = 0;
  try {
    const symbols = Array.from({ length: 125 }, (_, index) =>
      `NASDAQ:CONCURRENCY${String(index).padStart(3, "0")}`,
    );
    const result = await fetchTradingViewEstimateSeriesDetailed(symbols, async (batch) => {
      activeBatches += 1;
      maximumActiveBatches = Math.max(maximumActiveBatches, activeBatches);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeBatches -= 1;
      return batch.map((symbol) => validSeries(symbol));
    });
    assert.equal(result.series.length, symbols.length);
    assert.equal(maximumActiveBatches, 5);
    assert.equal(result.batchCount, 5);
    assert.equal(result.completedBatchCount, 5);
    assert.equal(result.nonEmptyBatchCount, 5);
    assert.equal(result.failedBatchCount, 0);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
    else process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = previousBatchSize;
    if (previousConcurrency === undefined) delete process.env.TRADINGVIEW_ESTIMATES_CONCURRENCY;
    else process.env.TRADINGVIEW_ESTIMATES_CONCURRENCY = previousConcurrency;
  }
});

test("counts an empty successful batch as completed but not non-empty", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
  process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = "25";
  try {
    const symbols = Array.from({ length: 25 }, (_, index) =>
      `NASDAQ:EMPTY${String(index).padStart(3, "0")}`,
    );
    const result = await fetchTradingViewEstimateSeriesDetailed(symbols, async () => []);
    assert.equal(result.batchCount, 1);
    assert.equal(result.completedBatchCount, 1);
    assert.equal(result.nonEmptyBatchCount, 0);
    assert.equal(result.failedBatchCount, 0);
    assert.deepEqual(result.missingSymbols, symbols);
    assert.deepEqual(result.failedSymbols, []);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
    else process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = previousBatchSize;
  }
});

test("keeps empty and failed estimate batches disjoint in mixed results", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
  process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = "25";
  try {
    const symbols = Array.from({ length: 75 }, (_, index) =>
      `NASDAQ:MIXED${String(index).padStart(3, "0")}`,
    );
    const result = await fetchTradingViewEstimateSeriesDetailed(symbols, async (batch) => {
      if (batch[0]?.endsWith("000")) return batch.map((symbol) => validSeries(symbol));
      if (batch[0]?.endsWith("025")) return [];
      throw new Error("socket unavailable");
    });

    assert.equal(result.series.length, 25);
    assert.equal(result.missingSymbols.length, 25);
    assert.equal(result.failedSymbols.length, 25);
    assert.equal(result.batchCount, 3);
    assert.equal(result.completedBatchCount, 2);
    assert.equal(result.nonEmptyBatchCount, 1);
    assert.equal(result.failedBatchCount, 1);
    assert.equal(result.missingSymbols.some((symbol) => result.failedSymbols.includes(symbol)), false);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE;
    else process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE = previousBatchSize;
  }
});
