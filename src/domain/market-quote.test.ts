import assert from "node:assert/strict";
import test from "node:test";
import { loadPreferredQuote, selectTradingViewQuote, selectYahooQuote } from "./market-quote";
import { tradingViewPriceSymbols } from "@/data/providers/market-quote-symbols";
import { valuePortfolioPositions } from "./processors/value-portfolio";

const now = Date.parse("2026-10-29T23:10:00Z");
const seconds = (iso: string) => Date.parse(iso) / 1_000;
const regular = { lp: 100, lp_time: seconds("2026-10-29T20:00:00Z"), currency_code: "USD" };

test("post-market uses the newer extended trade and its actual timestamp", () => {
  const quote = selectTradingViewQuote("NASDAQ:AAPL", { ...regular, current_session: "post_market",
    rtc: 112, rtc_time: seconds("2026-10-29T23:09:00Z") }, now)!;
  assert.equal(quote.price, 112);
  assert.equal(quote.session, "post-market");
  assert.equal(quote.asOf, "2026-10-29T23:09:00.000Z");
  const valued = valuePortfolioPositions([{ id: "a", kind: "security", referenceId: "a", ticker: "AAPL", name: "Apple", quantity: 10, allocationWeight: 0 }],
    new Map([["security:a", { ...quote, assetKind: "security", assetId: "a", providerSymbol: quote.symbol,
      priceUsd: quote.price, fxToUsd: 1, fetchedAt: new Date(now).toISOString(), sourceStatus: "live" }]]), 880);
  assert.equal(valued.totalMarketValueUsd, 2000);
  assert.equal(valued.items[0].currentValueUsd, 1120);
  assert.ok(Math.abs(valued.items[0].allocationWeight - 56) < 1e-10);
});
test("premarket supersedes yesterday's regular close; regular trading ignores stale rtc", () => {
  const pre = { ...regular, current_session: "pre_market", rtc: 105, rtc_time: seconds("2026-10-30T12:00:00Z") };
  assert.equal(selectTradingViewQuote("NASDAQ:AAPL", pre, Date.parse("2026-10-30T12:01:00Z"))?.session, "pre-market");
  const market = selectTradingViewQuote("NASDAQ:AAPL", { ...pre, current_session: "market", lp: 107,
    lp_time: seconds("2026-10-30T14:00:00Z") }, Date.parse("2026-10-30T14:01:00Z"))!;
  assert.equal(market.price, 107);
  assert.equal(market.session, "regular");
});

test("a regular-price timestamp updated after the close never hides an available post-market trade", () => {
  const quote = selectTradingViewQuote("AMEX:IVV", { ...regular, lp: 772.97,
    lp_time: seconds("2026-10-29T23:14:32Z"), rtc: 767.5, rtc_time: seconds("2026-10-29T23:13:21Z"),
    current_session: "post_market", timezone: "America/New_York" }, Date.parse("2026-10-29T23:18:00Z"))!;
  assert.equal(quote.price, 767.5);
  assert.equal(quote.session, "post-market");
  const nextMorning = selectTradingViewQuote("AMEX:IVV", { ...regular, rtc: 767.5,
    rtc_time: seconds("2026-10-29T23:13:21Z"), current_session: "pre_market", timezone: "America/New_York" },
  Date.parse("2026-10-30T12:00:00Z"))!;
  assert.equal(nextMorning.price, regular.lp);
  assert.equal(nextMorning.session, "regular");
});

test("missing, stale, invalid or future rtc keeps TradingView regular; closed sessions retain the last newer post-market trade", () => {
  for (const fields of [{}, { rtc: 0, rtc_time: now / 1_000 }, { rtc: 99, rtc_time: seconds("2026-10-28T23:00:00Z") },
    { rtc: 99, rtc_time: seconds("2026-10-30T23:00:00Z") }]) {
    assert.equal(selectTradingViewQuote("NASDAQ:ACWI", { ...regular, ...fields, current_session: "post_market" }, now)?.price, 100);
  }
  assert.equal(selectTradingViewQuote("NASDAQ:AAPL", { ...regular, rtc: 109,
    rtc_time: seconds("2026-10-29T23:00:00Z"), current_session: "out_of_session" }, now)?.price, 109);
  assert.equal(selectTradingViewQuote("NASDAQ:AAPL", { lp: 100, currency_code: "USD" }, now), null);
  assert.equal(selectTradingViewQuote("NASDAQ:AAPL", { ...regular, currency_code: "" }, now), null);
});

test("valid TradingView regular or delayed quotes never cause a Yahoo lookup", async () => {
  let calls = 0;
  for (const fields of [{ current_session: "post_market" }, { current_session: "out_of_session", update_mode: "delayed_streaming_900" }]) {
    const quote = selectTradingViewQuote("NASDAQ:ACWI", { ...regular, ...fields }, now)!;
    const result = await loadPreferredQuote([quote.symbol], { tradingView: async () => quote,
      yahoo: async () => { calls++; throw new Error("Yahoo must not be called"); } });
    assert.equal(result.source, "TradingView");
    assert.equal(result.price, 100);
  }
  assert.equal(calls, 0);
});

test("Yahoo is only used when all TradingView candidates fail, and selects its latest pre/post-market trade", async () => {
  const fallback = selectYahooQuote({ symbol: "AAPL", currency: "USD", marketState: "POST",
    regularMarketPrice: 100, regularMarketTime: new Date("2026-10-29T20:00:00Z"),
    postMarketPrice: 115, postMarketTime: new Date("2026-10-29T23:00:00Z"),
    preMarketPrice: 95, preMarketTime: new Date("2026-10-29T12:00:00Z") }, now)!;
  let calls = 0;
  const result = await loadPreferredQuote(["NASDAQ:AAPL"], { tradingView: async () => { throw new Error("offline"); },
    yahoo: async () => { calls++; return fallback; } });
  assert.equal(calls, 1);
  assert.equal(result.price, 115);
  assert.equal(result.session, "post-market");
  assert.equal(result.source, "Yahoo Finance");
  const pre = selectYahooQuote({ symbol: "AAPL", currency: "USD", marketState: "PRE", regularMarketPrice: 100,
    regularMarketTime: new Date("2026-10-28T20:00:00Z"), preMarketPrice: 106, preMarketTime: new Date("2026-10-29T12:00:00Z") }, now)!;
  assert.equal(pre.session, "pre-market");
  assert.equal(selectYahooQuote({ symbol: "AAPL", currency: "USD", regularMarketPrice: 100 }, now), null);
  await assert.rejects(loadPreferredQuote([], { tradingView: async () => null, yahoo: async () => null }), /No usable/);
});

test("price mappings respect held listings, share classes and receipt ratios instead of reusing an issuer mapping", () => {
  const company = { ticker: "AAPL", name: "Apple", country: "United States", exchange: "NASDAQ" };
  assert.deepEqual(tradingViewPriceSymbols(company, "AAPL", "XETR:APC"), ["NASDAQ:AAPL"]);
  assert.deepEqual(tradingViewPriceSymbols({ ...company, ticker: "IVV", exchange: "NYSE Arca" }, "IVV"), ["AMEX:IVV"]);
  assert.deepEqual(tradingViewPriceSymbols({ ...company, ticker: "CSPX", exchange: "London Stock Exchange" }, "CSPX.L"), ["LSE:CSPX"]);
  assert.deepEqual(tradingViewPriceSymbols({ ...company, ticker: "2330", exchange: "Taiwan Stock Exchange" }, "2330.TW", "NYSE:TSM"), ["TWSE:2330"]);
  assert.deepEqual(tradingViewPriceSymbols({ ...company, ticker: "2330" }, "TSM", "TWSE:2330"), ["NYSE:TSM"]);
  assert.deepEqual(tradingViewPriceSymbols({ ...company, ticker: "005930" }, "SMSN.IL", "KRX:005930"), ["LSIN:SMSN"]);
  assert.deepEqual(tradingViewPriceSymbols({ ...company, ticker: "BRKB", name: "Berkshire" }, "BRK-B"), ["NASDAQ:BRK.B"]);
  assert.deepEqual(tradingViewPriceSymbols({ ...company, ticker: "CSEMAS", exchange: "SIX Swiss Exchange" }, "CSEMAS.SW"), ["SIX:CSEMAS.USD"]);
  assert.deepEqual(tradingViewPriceSymbols({ ...company, ticker: "BGSIX", exchange: "Mutual fund (NAV)" }, "BGSIX"), []);
});
