import assert from "node:assert/strict";
import test from "node:test";

import { SOURCE_METRIC_DEFINITIONS } from "@/domain/metrics";
import { fetchTradingViewMetrics, parseTradingViewScanResponse } from "./tradingview-screener";

test("requests the earnings calendar alongside fundamentals only when opted in", async () => {
  for (const includeUpcomingEarnings of [false, true]) {
    let calls = 0;
    const result = await fetchTradingViewMetrics(["NASDAQ:MSFT"], async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.price_conversion, { to_currency: "usd" });
      assert.equal(body.columns.includes("earnings_release_next_date"), includeUpcomingEarnings);
      assert.equal(body.columns.includes("timezone"), includeUpcomingEarnings);
      return Response.json({ data: [{ s: "NASDAQ:MSFT", d: ["MSFT", "Microsoft", "Technology",
        ...SOURCE_METRIC_DEFINITIONS.map(() => 10),
        ...(includeUpcomingEarnings ? [1793102400, "America/New_York"] : []),
      ] }] });
    }, { includeUpcomingEarnings });
    assert.equal(calls, 1);
    assert.equal(result.observations[0].values.price_earnings_ttm, 10);
    assert.equal(result.observations[0].values.beta_1y, 10);
    assert.deepEqual(result.observations[0].upcomingEarnings, includeUpcomingEarnings
      ? { reportDate: "2026-10-27", exchangeTimezone: "America/New_York" } : undefined);
  }
});

test("maps non-EPS screener fundamentals without deriving earnings metrics", () => {
  const source = Object.fromEntries(SOURCE_METRIC_DEFINITIONS.map((definition, index) => [
    definition.key,
    index + 1,
  ]));
  const result = parseTradingViewScanResponse({
    data: [{
      s: "NASDAQ:MSFT",
      d: ["MSFT", "Microsoft Corporation", "Technology Services", ...Object.values(source)],
    }],
  })[0];
  assert.equal(result.symbol, "NASDAQ:MSFT");
  assert.equal(result.description, "Microsoft Corporation");
  assert.deepEqual(result.values, source);
  assert.equal("pe_ttm" in result.values, false);
  assert.equal("eps_diluted_fq" in result.values, false);
});

test("keeps missing provider values absent", () => {
  const result = parseTradingViewScanResponse({
    data: [{ s: "NYSE:TEST", d: ["TEST", "Test Company", "Industrials"] }],
  })[0];
  assert.deepEqual(result.values, {});
});

test("keeps successful Screener batches when another batch fails", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_BATCH_SIZE;
  process.env.TRADINGVIEW_BATCH_SIZE = "25";
  try {
    const symbols = [
      ...Array.from({ length: 25 }, (_, index) => `NASDAQ:A${String(index).padStart(2, "0")}`),
      "NASDAQ:ZFAIL",
    ];
    const result = await fetchTradingViewMetrics(symbols, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { symbols: { tickers: string[] } };
      if (body.symbols.tickers.includes("NASDAQ:ZFAIL")) {
        return new Response("upstream failure", { status: 503 });
      }
      return new Response(JSON.stringify({
        data: body.symbols.tickers.map((symbol) => ({
          s: symbol,
          d: [symbol.split(":")[1], "Test Company", "Technology Services"],
        })),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    assert.equal(result.observations.length, 25);
    assert.deepEqual(result.failedSymbols, ["NASDAQ:ZFAIL"]);
    assert.deepEqual(result.missingSymbols, []);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_BATCH_SIZE;
    else process.env.TRADINGVIEW_BATCH_SIZE = previousBatchSize;
  }
});

test("retries missing symbols in smaller batches", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_BATCH_SIZE;
  process.env.TRADINGVIEW_BATCH_SIZE = "500";
  let calls = 0;
  try {
    const symbols = ["NASDAQ:ARM", "NASDAQ:MSFT", "NASDAQ:GOOGL"];
    const result = await fetchTradingViewMetrics(symbols, async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { symbols: { tickers: string[] } };
      const returned = calls === 1 ? body.symbols.tickers.slice(1) : body.symbols.tickers;
      return new Response(JSON.stringify({
        data: returned.map((symbol) => ({
          s: symbol,
          d: [symbol.split(":")[1], "Test Company", "Technology Services"],
        })),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    assert.equal(calls, 2);
    assert.deepEqual(result.missingSymbols, []);
    assert.deepEqual(result.failedSymbols, []);
    assert.equal(result.observations.length, symbols.length);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_BATCH_SIZE;
    else process.env.TRADINGVIEW_BATCH_SIZE = previousBatchSize;
  }
});

test("keeps a configured 1000-symbol Screener batch intact", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_BATCH_SIZE;
  const previousRetryLimit = process.env.TRADINGVIEW_MISSING_RETRY_LIMIT;
  process.env.TRADINGVIEW_BATCH_SIZE = "1000";
  process.env.TRADINGVIEW_MISSING_RETRY_LIMIT = "0";
  const calls: string[][] = [];
  try {
    const symbols = Array.from({ length: 600 }, (_, index) => `NASDAQ:B${index}`);
    const result = await fetchTradingViewMetrics(symbols, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { symbols: { tickers: string[] } };
      calls.push(body.symbols.tickers);
      return new Response(JSON.stringify({
        data: body.symbols.tickers.map((symbol) => ({
          s: symbol,
          d: [symbol.split(":")[1], "Test Company", "Technology Services"],
        })),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, symbols.length);
    assert.equal(result.observations.length, symbols.length);
    assert.deepEqual(result.missingSymbols, []);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_BATCH_SIZE;
    else process.env.TRADINGVIEW_BATCH_SIZE = previousBatchSize;
    if (previousRetryLimit === undefined) delete process.env.TRADINGVIEW_MISSING_RETRY_LIMIT;
    else process.env.TRADINGVIEW_MISSING_RETRY_LIMIT = previousRetryLimit;
  }
});

test("prioritizes retry symbols in caller order while keeping initial batches sorted", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_BATCH_SIZE;
  const previousRetryLimit = process.env.TRADINGVIEW_MISSING_RETRY_LIMIT;
  process.env.TRADINGVIEW_BATCH_SIZE = "500";
  process.env.TRADINGVIEW_MISSING_RETRY_LIMIT = "2";
  const calls: string[][] = [];
  try {
    const symbols = ["NASDAQ:ZHIGH", "NASDAQ:YHIGH", "NASDAQ:AOTHER"];
    const result = await fetchTradingViewMetrics(symbols, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { symbols: { tickers: string[] } };
      calls.push(body.symbols.tickers);
      const returned = calls.length === 1
        ? ["NASDAQ:AOTHER"]
        : body.symbols.tickers;
      return new Response(JSON.stringify({
        data: returned.map((symbol) => ({
          s: symbol,
          d: [symbol.split(":")[1], "Test Company", "Technology Services"],
        })),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    assert.deepEqual(calls[0], ["NASDAQ:AOTHER", "NASDAQ:YHIGH", "NASDAQ:ZHIGH"]);
    assert.deepEqual(calls[1], ["NASDAQ:ZHIGH", "NASDAQ:YHIGH"]);
    assert.deepEqual(result.missingSymbols, []);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_BATCH_SIZE;
    else process.env.TRADINGVIEW_BATCH_SIZE = previousBatchSize;
    if (previousRetryLimit === undefined) delete process.env.TRADINGVIEW_MISSING_RETRY_LIMIT;
    else process.env.TRADINGVIEW_MISSING_RETRY_LIMIT = previousRetryLimit;
  }
});

test("keeps retry failures visible in failedSymbols", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_BATCH_SIZE;
  process.env.TRADINGVIEW_BATCH_SIZE = "500";
  let calls = 0;
  try {
    const result = await fetchTradingViewMetrics(
      ["NASDAQ:ARM", "NASDAQ:MSFT"],
      async (_input, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { symbols: { tickers: string[] } };
        if (calls === 1) {
          return new Response(JSON.stringify({
            data: [{ s: body.symbols.tickers[1], d: ["MSFT", "Test Company", "Technology Services"] }],
          }), { status: 200 });
        }
        return new Response("retry failure", { status: 503 });
      },
    );
    assert.deepEqual(result.missingSymbols, []);
    assert.deepEqual(result.failedSymbols, ["NASDAQ:ARM"]);
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_BATCH_SIZE;
    else process.env.TRADINGVIEW_BATCH_SIZE = previousBatchSize;
  }
});

test("treats an all-empty Screener response as unavailable", async () => {
  const previousBatchSize = process.env.TRADINGVIEW_BATCH_SIZE;
  process.env.TRADINGVIEW_BATCH_SIZE = "25";
  try {
    await assert.rejects(
      fetchTradingViewMetrics(
        Array.from({ length: 25 }, (_, index) => `NASDAQ:EMPTY${index}`),
        async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      ),
      /unavailable for all batches: TradingView Screener batch returned no observations/,
    );
  } finally {
    if (previousBatchSize === undefined) delete process.env.TRADINGVIEW_BATCH_SIZE;
    else process.env.TRADINGVIEW_BATCH_SIZE = previousBatchSize;
  }
});
