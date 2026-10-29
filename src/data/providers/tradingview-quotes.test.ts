import assert from "node:assert/strict";
import test from "node:test";
import { createTradingViewQuoteLoader } from "./tradingview-quotes";
import type { MarketQuote } from "@/domain/market-quote";

const quote = (symbol: string): MarketQuote => ({ symbol, price: 100, currency: "USD", asOf: new Date().toISOString(), source: "TradingView", session: "regular" });

test("simultaneous lookups share symbols, batch requests and bound socket concurrency", async () => {
  const batches: string[][] = [];
  let active = 0;
  let maxActive = 0;
  const load = createTradingViewQuoteLoader(async (symbols) => {
    batches.push(symbols); active++; maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return new Map(symbols.map((symbol) => [symbol, quote(symbol)]));
  });
  const first = load("NASDAQ:AAPL");
  assert.equal(load("NASDAQ:AAPL"), first);
  const symbols = Array.from({ length: 205 }, (_, index) => `NASDAQ:T${index}`);
  const results = await Promise.all([first, ...symbols.map(load)]);
  assert.equal(results.length, 206);
  assert.equal(batches.length, 3);
  assert.equal(maxActive, 2);
  assert.equal(batches.flat().filter((symbol) => symbol === "NASDAQ:AAPL").length, 1);
  await load("NASDAQ:AAPL");
  assert.equal(batches.length, 4, "there is no hidden provider cache to defeat forced refreshes");
});

test("failed and partial batches settle every caller and allow a later retry", async () => {
  let attempts = 0;
  const load = createTradingViewQuoteLoader(async () => {
    if (++attempts === 1) throw new Error("transport failure");
    return new Map([["NASDAQ:AAPL", quote("NASDAQ:AAPL")]]);
  });
  assert.deepEqual(await Promise.all([load("NASDAQ:AAPL"), load("NASDAQ:MISSING")]), [null, null]);
  const results = await Promise.all([load("NASDAQ:AAPL"), load("NASDAQ:MISSING")]);
  assert.equal(results[0]?.symbol, "NASDAQ:AAPL");
  assert.equal(results[1], null);
});
