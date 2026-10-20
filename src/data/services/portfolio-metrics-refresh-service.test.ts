import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getSqlite } from "@/db/client";
import { findEtfById } from "@/db/repositories/catalog-repository";
import { refreshPortfolioMetricsIfDue } from "./portfolio-metrics-refresh-service";

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
    const refresh = {
      holdings: async (id: string) => {
        calls.push(id);
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
