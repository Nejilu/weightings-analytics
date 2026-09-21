import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase } from "@/db/client";
import { findEtfById } from "@/db/repositories/catalog-repository";
import { persistSnapshot } from "@/db/repositories/holdings-repository";
import { getHoldingsSnapshot } from "./holdings-service";
import { analyzeHoldings } from "@/domain/processors/analyze-holdings";
import { compareHoldings } from "@/domain/processors/compare-holdings";

test("403 survives stale fallback, aliases, analysis and comparison; relay refresh clears it", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "holdings-refresh-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    delete process.env.ISHARES_RELAY_URL;
    ensureLocalDatabase();
    const etf = findEtfById("qtop-us")!;
    persistSnapshot({
      etf, asOf: "2026-09-11", fetchedAt: new Date().toISOString(),
      sourceUrl: etf.holdingsUrl, sourceHash: "ishares-holdings-v3:fixture",
      holdings: Array.from({ length: 6 }, (_, i) => ({
        securityId: `TEST${i}`, ticker: `T${i}`, name: `Company ${i}`,
        sector: "Technology", assetClass: "Equity", country: "United States", weight: 100 / 6,
      })),
    });
    globalThis.fetch = async () => new Response("Access Denied", { status: 403 });
    const stale = await getHoldingsSnapshot("qtop-us", { forceRefresh: true });
    assert.equal(stale.sourceStatus, "stale");
    assert.equal(stale.asOf, "2026-09-11");
    assert.equal(stale.sourceIssues?.[0].code, "HTTP_403");
    const reloaded = await getHoldingsSnapshot("qtop-us");
    assert.equal(reloaded.sourceStatus, "stale");
    assert.equal(reloaded.sourceIssues?.[0].code, "HTTP_403");
    const alias = await getHoldingsSnapshot("qtop-ucits", { forceRefresh: true });
    assert.deepEqual(alias.sourceIssues, stale.sourceIssues);
    const clean = { ...stale, sourceStatus: "live" as const, sourceIssues: [] };
    assert.deepEqual(analyzeHoldings(clean, stale).sourceIssues, stale.sourceIssues);
    assert.deepEqual(compareHoldings(clean, stale).right.sourceIssues, stale.sourceIssues);
    await assert.rejects(getHoldingsSnapshot("ivv-us", { forceRefresh: true }), /HTTP_403/);

    process.env.ISHARES_RELAY_URL = "https://relay.example.test/";
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const relay = new URL(String(input));
      assert.equal(relay.origin, "https://relay.example.test");
      const upstream = new URL(relay.searchParams.get("url")!);
      requested.push(upstream.toString());
      const points = upstream.searchParams.has("asOfDate") ? {
        asOfDate: { value: 20260918 },
        ticker: { value: ["SPCX", "A", "B", "C", "D", "E"] },
        issueName: { value: ["SpaceX", "A", "B", "C", "D", "E"] },
        holdingPercent: { value: [3.71811, 20, 20, 20, 20, 16.28189] },
      } : { dateList: { value: [20260911, 20260918] } };
      return Response.json({ componentsByNameMap: { holdings: { containersByNameMap: {
        all: { dataPointsByNameMap: points },
      } } } });
    };
    const fresh = await getHoldingsSnapshot("qtop-us", { forceRefresh: true });
    assert.equal(fresh.sourceStatus, "live");
    assert.equal(fresh.asOf, "2026-09-18");
    assert.equal(fresh.holdings.find((h) => h.ticker === "SPCX")?.weight, 3.71811);
    assert.equal(fresh.sourceIssues, undefined);
    assert.equal(requested.length, 2);
    assert.match(fresh.sourceUrl, /^https:\/\/www.blackrock.com/);
    const cached = await getHoldingsSnapshot("qtop-us");
    assert.equal(cached.sourceStatus, "cached");
    assert.equal(cached.sourceIssues, undefined);
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase();
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
