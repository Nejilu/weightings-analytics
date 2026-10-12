import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getSqlite } from "@/db/client";
import { findEtfByReference } from "@/db/repositories/catalog-repository";
import { persistSnapshot } from "@/db/repositories/holdings-repository";
import { ensureMetricDefinitions, saveProviderSymbolsBatch, saveSecurityMetricsBatch } from "@/db/repositories/metrics-repository";
import { SOURCE_METRIC_DEFINITIONS } from "@/domain/metrics";
import type { Holding } from "@/domain/etf";
import { getCapitalizationReference, CapitalizationReferenceRequestError } from "./capitalization-reference-service";
import { GET } from "@/app/api/v1/holdings/[ticker]/capitalization/route";

test("total-cap service reuses verified mappings, requests issuer metadata in USD, rejects invalid caps and handles outages", async () => {
  const originalPath = process.env.DATABASE_PATH;
  const originalMode = process.env.SITE_ACCESS_MODE;
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "total-cap-test-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    process.env.SITE_ACCESS_MODE = "local";
    closeDatabase();
    ensureLocalDatabase();
    ensureMetricDefinitions();
    const now = new Date().toISOString();
    const holdings: Holding[] = [
      { securityId: "US0378331005", ticker: "AAPL", name: "APPLE INC", assetClass: "Equity", country: "United States", sector: "Technology", exchange: "NASDAQ", weight: 60 },
      { securityId: "US5949181045", ticker: "MSFT", name: "MICROSOFT", assetClass: "Equity", country: "United States", sector: "Technology", exchange: "NASDAQ", weight: 40 },
    ];
    for (const reference of ["ivv-us", "acwi-us"]) persistSnapshot({
      etf: findEtfByReference(reference)!, holdings, asOf: now.slice(0, 10), fetchedAt: now, sourceUrl: "https://example.com", sourceHash: `ishares-holdings-v3:${reference}`,
    });
    // Admit the tiny cache fixture through the provider's fund-size check;
    // the test exercises capitalizations, not iShares download validation.
    getSqlite().prepare("UPDATE holding_snapshots SET row_count = CASE WHEN etf_id = 'acwi-us' THEN 2500 ELSE 500 END").run();
    saveProviderSymbolsBatch(holdings.map((p) => ({ securityId: p.securityId, providerSymbol: `NASDAQ:${p.ticker}`, status: "resolved", confidence: 1, verifiedAt: now })));
    saveSecurityMetricsBatch(holdings.map((p) => ({
      securityId: p.securityId, providerSymbol: `NASDAQ:${p.ticker}`,
      values: Object.fromEntries(SOURCE_METRIC_DEFINITIONS.map((definition) => [definition.key, definition.key === "market_cap" ? 1e12 : 10])),
    })), now);
    let calls = 0;
    let invalidCap = false;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.columns, ["name", "description", "logoid", "market_cap_basic"]);
      assert.deepEqual(body.price_conversion, { to_currency: "usd" });
      return Response.json({ data: holdings.map((p, i) => ({ s: `NASDAQ:${p.ticker}`, d: [p.ticker, p.name, p.ticker.toLowerCase(), invalidCap && i === 0 ? -1 : 1e12] })) });
    };
    const pending = getCapitalizationReference("ivv-us");
    assert.equal(pending, getCapitalizationReference("IVV"));
    const fresh = await pending;
    assert.equal(calls, 1);
    assert.equal(fresh.currency, "USD");
    assert.equal(fresh.observations.length, 2);
    assert.ok(fresh.observations.every((p) => p.status === "available"));
    const response = await GET(new Request("http://localhost/api/v1/holdings/ivv-us/capitalization?universe=market", { headers: { host: "localhost" } }), { params: Promise.resolve({ ticker: "ivv-us" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.universe, "market");
    const invalid = await GET(new Request("http://localhost/api/v1/holdings/ivv-us/capitalization?universe=invalid", { headers: { host: "localhost" } }), { params: Promise.resolve({ ticker: "ivv-us" }) });
    assert.equal(invalid.status, 400);
    await assert.rejects(getCapitalizationReference("unknown-fund"), CapitalizationReferenceRequestError);
    invalidCap = true;
    assert.equal((await getCapitalizationReference("ivv-us")).observations.find((p) => p.securityId === holdings[0].securityId)?.status, "invalid");
    globalThis.fetch = async () => { throw new Error("Provider outage"); };
    await assert.rejects(getCapitalizationReference("ivv-us"), /capitalizations are unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = originalPath;
    if (originalMode === undefined) delete process.env.SITE_ACCESS_MODE; else process.env.SITE_ACCESS_MODE = originalMode;
    const absoluteDirectory = resolve(directory);
    assert.ok(absoluteDirectory.startsWith(`${resolve(tmpdir())}${sep}`));
    rmSync(absoluteDirectory, { recursive: true, force: true });
  }
});
