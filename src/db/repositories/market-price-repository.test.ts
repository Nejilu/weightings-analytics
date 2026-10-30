import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase } from "@/db/client";
import { findMarketPrice, persistMarketPrice } from "./market-price-repository";

test("provider, session, delay and trade time survive a cache round trip and database reopen", () => {
  const previousPath = process.env.DATABASE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "market-quote-cache-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    closeDatabase(); ensureLocalDatabase();
    const base = { assetKind: "etf" as const, assetId: "ivv-us", providerSymbol: "AMEX:IVV", price: 110,
      currency: "USD", fxToUsd: 1, priceUsd: 110, asOf: "2026-10-29T22:00:00.000Z",
      fetchedAt: "2026-10-29T22:01:00.000Z", sourceStatus: "live" as const };
    persistMarketPrice({ ...base, source: "TradingView", quoteSession: "post-market", delaySeconds: 900 });
    closeDatabase(); ensureLocalDatabase();
    const cached = findMarketPrice("etf", "ivv-us")!;
    assert.equal(cached.source, "TradingView");
    assert.equal(cached.quoteSession, "post-market");
    assert.equal(cached.delaySeconds, 900);
    assert.equal(cached.asOf, base.asOf);
    assert.equal(cached.sourceStatus, "cached");
    persistMarketPrice({ ...base, providerSymbol: "IVV", source: "Yahoo Finance", quoteSession: "regular" });
    assert.equal(findMarketPrice("etf", "ivv-us")?.source, "Yahoo Finance");
    assert.equal(findMarketPrice("etf", "ivv-us")?.delaySeconds, undefined);
    persistMarketPrice({ ...base, assetId: "bgsix-us", providerSymbol: "BGSIX", source: "BlackRock", quoteSession: "nav", asOf: "2026-10-29" });
    closeDatabase(); ensureLocalDatabase();
    const nav = findMarketPrice("etf", "bgsix-us")!;
    assert.equal(nav.source, "BlackRock");
    assert.equal(nav.quoteSession, "nav");
    assert.equal(nav.asOf, "2026-10-29");
  } finally {
    closeDatabase();
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
