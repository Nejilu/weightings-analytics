import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getDb, getSqlite } from "@/db/client";
import { findEtfById } from "@/db/repositories/catalog-repository";
import { refreshPortfolioMetricsIfDue } from "./portfolio-metrics-refresh-service";
import { getHoldingsSnapshot, type RefreshOptions } from "./holdings-service";
import { etfs } from "@/db/schema";
import { persistSnapshot } from "@/db/repositories/holdings-repository";

test("refreshes only saved portfolios once per Paris day, shares their universe and survives restarts and failures", async () => {
  const previousPath = process.env.DATABASE_PATH;
  const previousEnabled = process.env.PORTFOLIO_METRICS_DAILY_REFRESH;
  const directory = mkdtempSync(join(tmpdir(), "portfolio-metrics-daily-"));
  try {
    process.env.DATABASE_PATH = join(directory, "metrics.sqlite");
    delete process.env.PORTFOLIO_METRICS_DAILY_REFRESH;
    closeDatabase(); ensureLocalDatabase();
    const sqlite = getSqlite();
    for (const id of ["daily-a", "daily-b"]) {
      sqlite.prepare("INSERT INTO portfolios(id, name) VALUES (?, ?)").run(id, id);
      sqlite.prepare(`INSERT INTO portfolio_items(id, portfolio_id, asset_type, etf_id, allocation_weight)
        VALUES (?, ?, 'etf', 'ivv-us', 100)`).run(id, id);
      sqlite.prepare(`INSERT INTO etfs(id, ticker, isin, name, issuer, benchmark_id, wrapper,
        domicile, exchange, trading_currency, distribution_policy, product_url, holdings_url,
        fund_type, portfolio_id)
        SELECT ?, ?, ?, ?, issuer, benchmark_id, wrapper, domicile, exchange,
          trading_currency, distribution_policy, product_url, holdings_url, 'portfolio', ?
        FROM etfs WHERE id='ivv-us'`).run(id, id, id, id, id);
    }
    const calls: string[] = [];
    let metricCalls = 0;
    let failing = false;
    const scopes: RefreshOptions[] = [];
    const refresh = {
      holdings: async (id: string, options: RefreshOptions = {}) => {
        calls.push(id);
        assert.equal(options.forceRefresh, true);
        assert.ok(options.sharedSnapshots instanceof Map);
        scopes.push(options);
        if (failing && id === "daily-a") throw new Error("composition offline");
        return { etf: findEtfById(id)!, asOf: "2026-10-17", fetchedAt: new Date().toISOString(),
          sourceStatus: "cached" as const, sourceUrl: "https://example.test/holdings", cacheTtlHours: 24,
          holdings: ["shared", id].map((securityId) => ({ securityId, ticker: securityId, name: securityId,
            sector: "Technology", assetClass: "Equity", country: "United States", weight: 50 })) };
      },
      metrics: async (holdings: { securityId: string }[], options: { forceRefresh?: boolean } = {}) => {
        metricCalls++;
        assert.deepEqual(options, { forceRefresh: true });
        assert.equal(new Set(holdings.map((holding) => holding.securityId)).size, holdings.length);
        return { calculatedAt: new Date().toISOString(), fundamentalsCaptureWindow: null,
          estimatesCaptureWindow: null, source: "TradingView Screener + Estimates" as const,
          sourceStatus: "live" as const, sourceWarnings: [], cacheTtlHours: 24, definitions: [],
          metricsBySecurity: new Map(), resolvedSecurityIds: new Set<string>() };
      },
    };
    const first = await refreshPortfolioMetricsIfDue(new Date("2026-10-17T21:50:00Z"), refresh);
    assert.deepEqual(first, { portfolios: 2, securities: 3, errors: [] });
    assert.deepEqual(calls.sort(), ["daily-a", "daily-b"]);
    assert.equal(scopes[0], scopes[1]);
    assert.equal(metricCalls, 1);
    closeDatabase(); ensureLocalDatabase();
    assert.equal(await refreshPortfolioMetricsIfDue(new Date("2026-10-17T21:55:00Z"), refresh), undefined);
    assert.equal(metricCalls, 1);
    // Paris has crossed midnight even though UTC has not.
    failing = true;
    const second = await refreshPortfolioMetricsIfDue(new Date("2026-10-17T22:10:00Z"), refresh);
    assert.equal(second?.securities, 2);
    assert.match(second!.errors[0], /daily-a: composition offline/);
    assert.equal(metricCalls, 2);
    assert.equal(scopes[2], scopes[3]);
    assert.notEqual(scopes[0].sharedSnapshots, scopes[2].sharedSnapshots);
    assert.equal(await refreshPortfolioMetricsIfDue(new Date("2026-10-18T05:00:00Z"), refresh), undefined);
    const state = JSON.parse((getSqlite().prepare("SELECT value_json FROM application_settings WHERE key='portfolio-metrics-daily-refresh'").get() as { value_json: string }).value_json);
    assert.equal(state.date, "2026-10-18");
    assert.equal(state.status, "partial");
    process.env.PORTFOLIO_METRICS_DAILY_REFRESH = "false";
    assert.equal(await refreshPortfolioMetricsIfDue(new Date("2026-10-19T10:00:00Z"), refresh), undefined);
    assert.equal(metricCalls, 2);
  } finally {
    closeDatabase();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    if (previousEnabled === undefined) delete process.env.PORTFOLIO_METRICS_DAILY_REFRESH;
    else process.env.PORTFOLIO_METRICS_DAILY_REFRESH = previousEnabled;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("daily metrics use newly downloaded constituents and share a fresh source across nested ETFs and portfolios", async () => {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "portfolio-daily-compositions-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    delete process.env.PORTFOLIO_METRICS_DAILY_REFRESH;
    delete process.env.ISHARES_RELAY_URL;
    closeDatabase(); ensureLocalDatabase();
    const source = { ...findEtfById("qtop-us")!, id: "daily-source", ticker: "DLYSRC", isin: "DAILY-SOURCE",
      holdingsUrl: "https://www.ishares.com/daily-test.csv", productUrl: "https://www.ishares.com/daily-test-fund" };
    getDb().insert(etfs).values({ ...source, issuer: "Synthetic fixture" }).run();
    getDb().insert(etfs).values({ ...source, id: "daily-alias", ticker: "DLYALIAS", isin: "DAILY-ALIAS",
      issuer: "Synthetic fixture", metadataJson: { holdingsSourceEtfId: source.id } }).run();
    getDb().insert(etfs).values({ ...source, id: "daily-derived", ticker: "DLYDER", isin: "DAILY-DERIVED",
      issuer: "Synthetic fixture", metadataJson: { model: "scaled-source", sourceEtfId: "daily-alias",
        sourceIndexName: "Daily fixture index", compositionSourceUrl: source.holdingsUrl, exposureMultiplier: 2 } }).run();
    persistSnapshot({ etf: source, asOf: "2026-10-16", fetchedAt: new Date().toISOString(),
      sourceUrl: source.holdingsUrl, sourceHash: "ishares-holdings-v3:daily-cached",
      holdings: Array.from({ length: 6 }, (_, i) => ({ securityId: `DAILY-CACHED-${i}`, ticker: `CACHED${i}`,
        name: `Old constituent ${i}`, sector: "Technology", assetClass: "Equity", country: "United States", weight: 100 / 6 })) });
    for (const id of ["daily-a", "daily-b"]) {
      getSqlite().prepare("INSERT INTO portfolios(id, name) VALUES (?, ?)").run(id, id);
      getSqlite().prepare(`INSERT INTO portfolio_items(id, portfolio_id, asset_type, etf_id, allocation_weight)
        VALUES (?, ?, 'etf', ?, 100)`).run(id, id, id === "daily-a" ? "daily-derived" : source.id);
      getDb().insert(etfs).values({ ...source, id, ticker: id.toUpperCase(), isin: id,
        issuer: "Synthetic fixture", fundType: "portfolio", portfolioId: id }).run();
    }
    let downloads = 0;
    let generation = 1;
    globalThis.fetch = async (input) => {
      assert.equal(String(input), source.holdingsUrl, "unrelated catalog ETFs must not be fetched");
      downloads++;
      return new Response([
        'Fund Holdings as of,"Oct 17, 2026"',
        "Ticker,Name,Sector,Asset Class,Weight (%),Location,Currency,Exchange",
        ...Array.from({ length: 6 }, (_, i) => `FRESH${generation}${i},New constituent ${generation} ${i},Technology,Equity,${100 / 6},United States,USD,NASDAQ`),
      ].join("\n"), { headers: { "Content-Type": "text/csv" } });
    };
    let releaseSource!: () => void;
    let sourceReady = new Promise<void>((resolve) => { releaseSource = resolve; });
    let metricCalls = 0;
    const refresh = {
      holdings: async (id: string, options: RefreshOptions = {}) => {
        if (id === "daily-a") {
          try { return await getHoldingsSnapshot("daily-derived", options); }
          finally { releaseSource(); }
        }
        // The second portfolio starts after the common download has finished,
        // exercising reuse beyond the existing in-flight-only deduplication.
        await sourceReady;
        return getHoldingsSnapshot(source.id, options);
      },
      metrics: async (holdings: { securityId: string; ticker: string }[], options: { forceRefresh?: boolean } = {}) => {
        metricCalls++;
        assert.deepEqual(options, { forceRefresh: true });
        assert.equal(downloads, generation);
        assert.equal(holdings.length, 6);
        assert.ok(holdings.every((holding) => holding.ticker.startsWith(`FRESH${generation}`)),
          "metrics must follow the refreshed membership, not yesterday's composition");
        return { calculatedAt: new Date().toISOString(), fundamentalsCaptureWindow: null,
          estimatesCaptureWindow: null, source: "TradingView Screener + Estimates" as const,
          sourceStatus: "live" as const, sourceWarnings: [], cacheTtlHours: 24, definitions: [],
          metricsBySecurity: new Map(), resolvedSecurityIds: new Set<string>() };
      },
    };
    const first = await refreshPortfolioMetricsIfDue(new Date("2026-10-17T10:00:00Z"), refresh);
    assert.deepEqual(first, { portfolios: 2, securities: 6, errors: [] });
    assert.equal(downloads, 1, "a valid 24-hour cache must still be bypassed once by the daily job");
    assert.equal((await getHoldingsSnapshot(source.id)).sourceStatus, "cached");
    assert.equal(downloads, 1, "interactive reads reuse the freshly persisted composition");
    closeDatabase(); ensureLocalDatabase();
    assert.equal(await refreshPortfolioMetricsIfDue(new Date("2026-10-17T11:00:00Z"), refresh), undefined);
    assert.equal(downloads, 1, "a restart must not run today's job twice");
    generation = 2;
    sourceReady = new Promise<void>((resolve) => { releaseSource = resolve; });
    const second = await refreshPortfolioMetricsIfDue(new Date("2026-10-18T10:00:00Z"), refresh);
    assert.deepEqual(second, { portfolios: 2, securities: 6, errors: [] });
    assert.equal(downloads, 2, "the next daily run must get a new scope and bypass the still-fresh cache");
    assert.equal(metricCalls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    closeDatabase();
    process.env = previousEnv;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
