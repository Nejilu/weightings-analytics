import assert from "node:assert/strict";
import test from "node:test";
import { ETF_CATALOG, getEtfById } from "../catalog";
import { ETF_QUOTE_SOURCES } from "../etf-quote-sources";
import type { MarketPrice } from "@/domain/portfolio";
import type { MarketQuote } from "@/domain/market-quote";
import { etfPriceIsCompatible, fetchEtfQuote } from "./etf-quotes";

const quote = (symbol: string, source: MarketQuote["source"] = "TradingView", currency = "USD"): MarketQuote => ({
  symbol, price: 100, currency, asOf: "2026-10-30T15:30:00.000Z", source, session: "regular",
});
const forbidden = async (): Promise<never> => { throw new Error("Unexpected provider request"); };

test("every listed catalog ETF has an explicit quote source without changing BGSIX", async () => {
  const catalog = ETF_CATALOG.flatMap((group) => group.variants).filter((etf) => etf.id !== "bgsix-us");
  assert.equal(Object.keys(ETF_QUOTE_SOURCES).length, catalog.length);
  assert.equal(ETF_QUOTE_SOURCES["bgsix-us"], undefined);
  for (const etf of catalog) {
    const source = ETF_QUOTE_SOURCES[etf.id];
    assert.ok(source, etf.id);
    assert.equal(source.source, "TradingView");
    if (source.source !== "TradingView") continue;
    let calls = 0;
    const selected = await fetchEtfQuote(etf, {
      tradingView: async (symbol) => {
        calls++;
        assert.equal(symbol, source.symbol);
        const currency = ["swda-ucits", "ssac-ucits"].includes(etf.id) ? "GBX" : etf.tradingCurrency;
        return { ...quote(symbol, "TradingView", currency), delaySeconds: 900 };
      },
      yahoo: forbidden,
    });
    assert.equal(calls, 1);
    assert.equal(selected.source, "TradingView");
    assert.equal(selected.symbol, source.symbol);
    assert.equal(selected.delaySeconds, 900);
  }
  assert.equal(ETF_QUOTE_SOURCES["cspx-ucits"].symbol, "LSE:CSPX");
  assert.equal(ETF_QUOTE_SOURCES["chip-ucits"].symbol, "EURONEXT:CHIP");
  assert.equal(ETF_QUOTE_SOURCES["panx-ucits"].symbol, "EURONEXT:PANX");
  assert.equal(ETF_QUOTE_SOURCES["csemas-ucits"].symbol, "SIX:CSEMAS.USD");
});

test("an ETF only falls back to its own Yahoo listing, preserving the actual source", async () => {
  const etf = getEtfById("chip-ucits")!;
  let calls = 0;
  const selected = await fetchEtfQuote(etf, {
    tradingView: async () => null,
    yahoo: async (symbol) => { calls++; assert.equal(symbol, "CHIP.PA"); return quote(symbol, "Yahoo Finance", "EUR"); },
  });
  assert.equal(calls, 1);
  assert.equal(selected.source, "Yahoo Finance");
});

test("rejects a quote in another currency or from the source ETF used for holdings", async () => {
  const etf = getEtfById("cspx-ucits")!;
  for (const wrong of [quote("AMEX:IVV"), quote("LSE:CSPX", "TradingView", "EUR")]) {
    const selected = await fetchEtfQuote(etf, {
      tradingView: async () => wrong,
      yahoo: async () => quote("CSPX.L", "Yahoo Finance"),
    });
    assert.equal(selected.symbol, "CSPX.L");
  }
  await assert.rejects(fetchEtfQuote(etf, {
    tradingView: async () => null,
    yahoo: async () => quote("CSPX.L", "Yahoo Finance", "EUR"),
  }), /No usable/);
});

test("cache compatibility follows the held ETF listing", () => {
  const price = { assetKind: "etf", assetId: "test", providerSymbol: "AMEX:IVV", price: 100, priceUsd: 100,
    fxToUsd: 1, currency: "USD", asOf: "2026-10-30T15:30:00.000Z", fetchedAt: new Date().toISOString(),
    source: "TradingView", sourceStatus: "cached", quoteSession: "regular" } satisfies MarketPrice;
  assert.equal(etfPriceIsCompatible(getEtfById("cspx-ucits")!, price), false);
  assert.equal(etfPriceIsCompatible(getEtfById("cspx-ucits")!, { ...price, providerSymbol: "LSE:CSPX" }), true);
  assert.equal(etfPriceIsCompatible(getEtfById("swda-ucits")!, { ...price, providerSymbol: "LSE:SWDA", currency: "GBX" }), true);
});
