import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getSqlite } from "@/db/client";
import { ensureMetricDefinitions, saveProviderSymbolsBatch } from "@/db/repositories/metrics-repository";
import { saveUpcomingEarningsBatch } from "@/db/repositories/upcoming-earnings-repository";
import { SOURCE_METRIC_DEFINITIONS } from "@/domain/metrics";
import { GET } from "@/app/api/v1/portfolio/events/route";
import { getPortfolioEvents, PortfolioEventsRequestError } from "./portfolio-events-service";

test("portfolio calendar shares cached dates, refreshes a batch without estimates and retains stale future dates", async () => {
  const originalPath = process.env.DATABASE_PATH;
  const originalMode = process.env.SITE_ACCESS_MODE;
  const siteConfigKeys = ["SITE_PUBLIC_ORIGIN", "SITE_OWNER_ORIGIN", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "SITE_OWNER_EMAIL"];
  const originalSiteConfig = Object.fromEntries(siteConfigKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "portfolio-events-test-"));
  try {
    process.env.DATABASE_PATH = join(directory, "events.sqlite");
    process.env.SITE_ACCESS_MODE = "local";
    closeDatabase();
    ensureLocalDatabase();
    ensureMetricDefinitions();
    getSqlite().prepare("INSERT INTO securities (id, isin, primary_ticker, name, asset_class, sector, country, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("US5949181045", "US5949181045", "MSFT", "MICROSOFT", "Equity", "Technology", "United States", "USD");
    const ids = ["US55087P1049", "US5949181045"]; // LYFT, Microsoft.
    const symbols = ["NASDAQ:LYFT", "NASDAQ:MSFT"];
    const now = new Date().toISOString();
    const timestamps = [14, 7].map((days) => Math.floor((Date.now() + days * 86_400_000) / 1_000));
    const dates = timestamps.map((timestamp) => new Date(timestamp * 1_000).toISOString().slice(0, 10));
    saveProviderSymbolsBatch(ids.map((securityId, index) => ({ securityId, providerSymbol: symbols[index], status: "resolved", confidence: 1, verifiedAt: now })));
    saveUpcomingEarningsBatch(ids.map((securityId, index) => ({ securityId, observation: { providerSymbol: symbols[index], reportDate: dates[index], exchangeTimezone: "UTC" } })), now);
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Unexpected provider call"); };
    const cached = await getPortfolioEvents(ids);
    assert.equal(calls, 0);
    assert.deepEqual(cached.map((event) => event.securityId), [ids[1], ids[0]]);
    assert.equal(cached[0].sourceStatus, "cached");

    const extraIds = Array.from({ length: 28 }, (_, index) => `calendar-stock-${index}`);
    const insertStock = getSqlite().prepare("INSERT INTO securities (id, primary_ticker, name, asset_class, sector, country, currency) VALUES (?, ?, ?, ?, ?, ?, ?)");
    extraIds.forEach((id, index) => insertStock.run(id, `CAL${index}`, `Calendar stock ${index}`, "Equity", "Technology", "United States", "USD"));
    saveProviderSymbolsBatch(extraIds.map((securityId, index) => ({ securityId, providerSymbol: `NASDAQ:CAL${index}`, status: "resolved", confidence: 1, verifiedAt: now })));
    saveUpcomingEarningsBatch(extraIds.map((securityId, index) => ({ securityId, observation: { providerSymbol: `NASDAQ:CAL${index}`, reportDate: dates[0], exchangeTimezone: "UTC" } })), now);
    const top30Params = new URLSearchParams();
    [...ids, ...extraIds].forEach((id) => top30Params.append("securityId", id));
    const top30Response = await GET(new Request(`http://localhost/api/v1/portfolio/events?${top30Params}`, { headers: { host: "localhost" } }));
    assert.equal(top30Response.status, 200);
    assert.equal((await top30Response.json()).data.length, 30);
    assert.equal(calls, 0);

    Object.assign(process.env, {
      SITE_ACCESS_MODE: "cloudflare",
      SITE_PUBLIC_ORIGIN: "https://public.example.com",
      SITE_OWNER_ORIGIN: "https://owner.example.com",
      CF_ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
      CF_ACCESS_AUD: "test-audience",
      SITE_OWNER_EMAIL: "owner@example.com",
    });
    // Anonymous visitors use the same calendar; dates expose no portfolio amounts.
    for (const count of [10, 30]) {
      const params = new URLSearchParams();
      [...ids, ...extraIds].slice(0, count).forEach((id) => params.append("securityId", id));
      const publicResponse = await GET(new Request(`https://public.example.com/api/v1/portfolio/events?${params}`, {
        headers: { host: "public.example.com" },
      }));
      assert.equal(publicResponse.status, 200);
      assert.equal(publicResponse.headers.get("cache-control"), "private, no-store");
      const publicEvents = (await publicResponse.json()).data;
      assert.equal(publicEvents.length, count);
      assert.equal(publicEvents[0].reportDate, dates[1]);
      assert.ok(publicEvents.every((event: Record<string, unknown>) =>
        Object.keys(event).every((key) => ["securityId", "ticker", "name", "reportDate", "exchangeTimezone", "capturedAt", "sourceStatus"].includes(key))));
    }
    const invalidPublicResponse = await GET(new Request("https://public.example.com/api/v1/portfolio/events", {
      headers: { host: "public.example.com" },
    }));
    assert.equal(invalidPublicResponse.status, 400);
    assert.equal(calls, 0);
    process.env.SITE_ACCESS_MODE = "local";

    getSqlite().prepare("DELETE FROM metric_observations WHERE metric_definition_id = 'security:upcoming_earnings:v1'").run();
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), "https://scanner.tradingview.com/global/scan");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.symbols.tickers.slice().sort(), symbols.slice().sort());
      assert.deepEqual(body.columns.slice(-2), ["earnings_release_next_date", "timezone"]);
      return Response.json({ data: symbols.map((symbol, index) => ({ s: symbol, d: [index === 0 ? "LYFT" : "MSFT", index === 0 ? "LYFT INC CLASS A" : "MICROSOFT", "Technology", ...SOURCE_METRIC_DEFINITIONS.map(() => 10), timestamps[index], "UTC"] })) });
    };
    const pending = getPortfolioEvents(ids);
    assert.equal(getPortfolioEvents(ids.slice().reverse()), pending);
    const refreshed = await pending;
    assert.equal(calls, 1);
    assert.equal(refreshed[0].reportDate, dates[1]);
    assert.equal(refreshed[0].sourceStatus, "live");
    await getPortfolioEvents(ids);
    assert.equal(calls, 1);

    getSqlite().prepare("UPDATE metric_observations SET captured_at = '2000-01-01T00:00:00.000Z' WHERE metric_definition_id = 'security:upcoming_earnings:v1'").run();
    globalThis.fetch = async () => { throw new Error("Calendar transport unavailable"); };
    const stale = await getPortfolioEvents(ids);
    assert.equal(stale[0].reportDate, dates[1]);
    assert.equal(stale[0].sourceStatus, "stale");
    getSqlite().prepare("UPDATE metric_observations SET value_json = json_set(value_json, '$.reportDate', '2000-01-01') WHERE metric_definition_id = 'security:upcoming_earnings:v1'").run();
    assert.ok((await getPortfolioEvents(ids)).every((event) => event.reportDate === null));

    await assert.rejects(getPortfolioEvents([]), PortfolioEventsRequestError);
    await assert.rejects(getPortfolioEvents(["unknown"]), PortfolioEventsRequestError);
    await assert.rejects(getPortfolioEvents(Array.from({ length: 31 }, (_, index) => `s${index}`)), PortfolioEventsRequestError);
    assert.equal((await GET(new Request("http://localhost/api/v1/portfolio/events", { headers: { host: "localhost" } }))).status, 400);
    const response = await GET(new Request(`http://localhost/api/v1/portfolio/events?securityId=${ids[0]}`, { headers: { host: "localhost" } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].securityId, ids[0]);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = originalPath;
    if (originalMode === undefined) delete process.env.SITE_ACCESS_MODE; else process.env.SITE_ACCESS_MODE = originalMode;
    for (const key of siteConfigKeys) {
      if (originalSiteConfig[key] === undefined) delete process.env[key];
      else process.env[key] = originalSiteConfig[key];
    }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
