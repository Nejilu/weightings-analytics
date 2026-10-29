import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ensureLocalDatabase } from "../src/db/bootstrap";
import { closeDatabase, getSqlite } from "../src/db/client";
import { getMarketPrice, getMarketPrices } from "../src/data/services/market-price-service";
import { ETF_CATALOG } from "../src/data/catalog";
import { tradingViewPriceSymbols } from "../src/data/providers/market-quote-symbols";
import { fetchTradingViewQuoteBatch } from "../src/data/providers/tradingview-quotes";
import { persistMarketPrice } from "../src/db/repositories/market-price-repository";

// Live smoke test with an isolated database. Never writes provider observations
// or fixture securities into the application's real portfolios/database.
const previousPath = process.env.DATABASE_PATH;
const directory = mkdtempSync(join(tmpdir(), "market-quotes-live-"));
try {
  process.env.DATABASE_PATH = join(directory, "test.sqlite");
  closeDatabase(); ensureLocalDatabase();
  for (const ticker of ["AAPL", "GOOGL"]) {
    getSqlite().prepare(`INSERT INTO securities (id, primary_ticker, name, asset_class, country, identifiers_json)
      VALUES (?, ?, ?, 'Equity', 'United States', '{"exchange":"NASDAQ"}')`).run(`trial:${ticker}`, ticker, ticker);
  }
  // A pre-upgrade, fresh Yahoo cache must not postpone the provider switch.
  persistMarketPrice({ assetKind: "security", assetId: "trial:AAPL", providerSymbol: "AAPL", price: 1,
    currency: "USD", fxToUsd: 1, priceUsd: 1, asOf: new Date().toISOString(),
    fetchedAt: new Date().toISOString(), sourceStatus: "live", source: "Yahoo Finance" });
  assert.equal((await getMarketPrice("security", "trial:AAPL")).source, "TradingView");
  const assets = [
    { kind: "security" as const, referenceId: "trial:AAPL" },
    { kind: "security" as const, referenceId: "trial:GOOGL" },
    { kind: "etf" as const, referenceId: "ivv-us" },
    { kind: "etf" as const, referenceId: "acwi-us" },
    { kind: "etf" as const, referenceId: "cspx-ucits" },
  ];
  const prices = await getMarketPrices(assets, { forceRefresh: true, requireFresh: true });
  for (const asset of assets) {
    const price = prices.get(`${asset.kind}:${asset.referenceId}`)!;
    assert.ok(price.price > 0);
    assert.equal(price.source, "TradingView");
    const cached = await getMarketPrice(asset.kind, asset.referenceId);
    assert.equal(cached.sourceStatus, "cached");
    assert.equal(cached.asOf, price.asOf);
    assert.equal(cached.quoteSession, price.quoteSession);
  }
  console.table([...prices.values()].map((price) => ({ symbol: price.providerSymbol, source: price.source,
    session: price.quoteSession, price: price.price, currency: price.currency, asOf: price.asOf, delaySeconds: price.delaySeconds ?? 0 })));
  console.log("Five live TradingView lookups and their persisted cache round trips passed.");
  const catalog = ETF_CATALOG.flatMap((group) => group.variants).filter((etf) => etf.fundType !== "custom" && etf.fundType !== "portfolio");
  const symbols = catalog.map((etf) => tradingViewPriceSymbols({ ...etf, country: "" }, etf.priceSymbol ?? etf.ticker)[0]);
  assert.ok(symbols.every(Boolean), "Every catalog instrument has a TradingView listing candidate");
  const observations = await fetchTradingViewQuoteBatch(symbols);
  const missing = symbols.filter((symbol) => !observations.has(symbol));
  assert.deepEqual(missing, [], "Catalog listings unavailable on TradingView");
  console.log(`Catalog coverage: ${observations.size}/${catalog.length} instrument quotes received.`);
} finally {
  closeDatabase();
  if (previousPath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousPath;
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
