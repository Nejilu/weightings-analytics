import assert from "node:assert/strict";
import test from "node:test";
import { createTradingViewQuoteLoader } from "@/data/providers/tradingview-quotes";
import type { MarketQuote } from "@/domain/market-quote";
import { getMarketPrices } from "./market-price-service";

test("a portfolio reaches TradingView in one batch rather than successive groups of four", async () => {
  const batches: string[][] = [];
  const loadQuote = createTradingViewQuoteLoader(async (symbols) => {
    batches.push(symbols);
    return new Map(symbols.map((symbol): [string, MarketQuote] => [symbol, {
      symbol, price: 100, currency: "USD", asOf: "2026-10-30T15:00:00.000Z",
      source: "TradingView", session: "regular",
    }]));
  });
  const assets = Array.from({ length: 25 }, (_, index) => ({
    kind: "security" as const, referenceId: `NASDAQ:DEMO${index}`,
  }));
  const options = { forceRefresh: true, requireFresh: true };
  const prices = await getMarketPrices([...assets, assets[0]], options, async (kind, id, refresh) => {
    assert.equal(refresh, options);
    const quote = (await loadQuote(id))!;
    return {
      assetKind: kind, assetId: id, providerSymbol: quote.symbol,
      price: quote.price, priceUsd: quote.price, currency: quote.currency,
      fxToUsd: 1, asOf: quote.asOf, fetchedAt: quote.asOf,
      sourceStatus: "live", source: quote.source, quoteSession: quote.session,
    };
  });
  assert.equal(prices.size, 25);
  assert.equal(batches.length, 1, "small outer worker pools defeat the socket provider's batching");
  assert.equal(batches[0].length, 25, "duplicate positions must still share a provider lookup");
  assert.ok([...prices.values()].every((price) => price.source === "TradingView"));
});
