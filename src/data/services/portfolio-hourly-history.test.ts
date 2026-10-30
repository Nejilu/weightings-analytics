import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getDb, getSqlite } from "@/db/client";
import { portfolioHourlySnapshots } from "@/db/schema";
import { claimPortfolioHourlySnapshot, finishPortfolioHourlySnapshot, loadPortfolioHistory, prunePortfolioHourlyHistory, setPortfolioHistoryEnabled } from "@/db/repositories/portfolio-history-repository";
import { captureDuePortfolios, capturePortfolioHourlyIfDue, capturePortfolioIfDue } from "./portfolio-history-service";
import type { FxRate, PortfolioItem } from "@/domain/portfolio";

test("hourly history persists independent NAV and invested series, retries and cleans up while paused", async () => {
  const previousPath = process.env.DATABASE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "portfolio-hourly-test-"));
  let now = new Date("2026-10-30T08:05:00.000Z");
  let price = 100, fx = 1.25, cashValue = 1000, calls = 0;
  let fail = false, stale = false, missingSold = false;
  let duringCapture: (() => void) | undefined;
  const market = {
    async getFxRate(): Promise<FxRate> {
      calls++;
      if (fail) throw new Error("Hourly FX offline");
      duringCapture?.();
      return { currency: "EUR", providerSymbol: "EURUSD=X", rateToUsd: fx, asOf: now.toISOString(), fetchedAt: now.toISOString(), sourceStatus: stale ? "stale" : "live" };
    },
    async valueCashPositions() { return [{ currency: "USD" as const, amount: cashValue, valueUsd: cashValue }]; },
    async valuePortfolioItems(items: PortfolioItem[], cash = 0, options = {}) {
      assert.deepEqual(options, { forceRefresh: true, requireFresh: true });
      if (missingSold && items.some((item) => item.referenceId === "hourly-a")) throw new Error("Sold quote unavailable");
      const valued = items.map((item) => ({ ...item, currentPriceUsd: price, currentValueUsd: item.quantity! * price, priceStatus: "live" as const, priceAsOf: now.toISOString() }));
      return { items: valued, totalMarketValueUsd: cash + valued.reduce((sum, item) => sum + item.currentValueUsd, 0) };
    },
  };
  const capture = async (time: string) => { now = new Date(time); await capturePortfolioHourlyIfDue("active", now, market); };
  const history = () => loadPortfolioHistory("active", now);
  try {
    process.env.DATABASE_PATH = join(directory, "history.sqlite");
    ensureLocalDatabase();
    const sql = getSqlite();
    sql.exec("INSERT INTO portfolios (id, name) VALUES ('active', 'Active'), ('other', 'Other'), ('empty', 'Empty')");
    for (const id of ["hourly-a", "hourly-b"]) sql.prepare("INSERT INTO securities (id, primary_ticker, name, sector, asset_class, country) VALUES (?, ?, ?, 'Technology', 'Equity', 'US')").run(id, id, id);
    sql.exec("INSERT INTO portfolio_items (id, portfolio_id, asset_type, security_id, allocation_weight, quantity, input_mode) VALUES ('position', 'active', 'security', 'hourly-a', 100, 10, 'shares')");
    sql.exec("INSERT INTO portfolio_cash_positions (portfolio_id, currency, amount) VALUES ('other', 'USD', 1000)");
    const first = capturePortfolioHourlyIfDue("active", now, market);
    assert.equal(capturePortfolioHourlyIfDue("active", now, market), first);
    await first;
    let points = history().hourlySnapshots!;
    assert.equal(points.length, 1);
    assert.equal(points[0].slotAt, now.toISOString());
    assert.ok(points[0].capturedAt >= points[0].slotAt);
    assert.equal(points[0].valueUsd, 2000);
    assert.equal(points[0].valueEur, 1600);
    assert.equal(points[0].invested!.indexUsd, 100);
    assert.equal(history().snapshots.length, 0);
    await capture("2026-10-30T08:10:00Z");
    assert.equal(calls, 1);
    price = 110; fx = 1.1; cashValue = 50000;
    sql.exec("UPDATE portfolio_items SET quantity = 100 WHERE id = 'position'");
    await capture("2026-10-30T09:05:00Z");
    points = history().hourlySnapshots!;
    assert.equal(points.length, 2);
    assert.equal(points[1].valueUsd, 61000);
    assert.ok(Math.abs(points[1].invested!.indexUsd - 110) < 1e-9);
    assert.ok(Math.abs(points[1].invested!.indexEur - 125) < 1e-9);
    await capturePortfolioIfDue("active", now, market);
    assert.equal(history().snapshots[0].invested!.indexUsd, 100, "daily chaining never starts from hourly data");
    assert.equal(history().hourlySnapshots!.length, 2);

    fail = true;
    await capture("2026-10-30T10:05:00Z");
    assert.match(history().hourlyLastError!, /Hourly FX offline/);
    assert.equal(history().lastError, null);
    const attempts = calls;
    fail = false;
    await capture("2026-10-30T10:06:00Z");
    assert.equal(calls, attempts);
    stale = true;
    await capture("2026-10-30T10:10:00Z");
    assert.equal(history().hourlySnapshots!.length, 2);
    stale = false;
    await capture("2026-10-30T10:15:00Z");
    assert.equal(history().hourlySnapshots![2].slotAt, "2026-10-30T10:05:00.000Z");
    assert.ok(history().hourlySnapshots![2].capturedAt.startsWith("2026-10-30T10:15:"));
    assert.equal(history().hourlyLastError, null);
    // Missing sold marks restart the invested segment within the same day.
    sql.exec("UPDATE portfolio_items SET security_id = 'hourly-b' WHERE id = 'position'");
    missingSold = true;
    await capture("2026-10-30T11:05:00Z");
    assert.equal(history().hourlySnapshots![3].invested, null);
    missingSold = false;
    await capture("2026-10-30T12:05:00Z");
    assert.equal(history().hourlySnapshots![4].invested!.segment, "2026-10-30T12:05:00.000Z");
    assert.equal(history().hourlySnapshots![4].invested!.indexUsd, 100);

    duringCapture = () => setPortfolioHistoryEnabled("active", false);
    await capture("2026-10-30T13:05:00Z");
    assert.equal(history().hourlySnapshots!.length, 5, "pausing during capture prevents insertion");
    duringCapture = undefined;
    setPortfolioHistoryEnabled("active", true);
    duringCapture = () => sql.exec("UPDATE portfolio_items SET quantity = 101 WHERE id = 'position'");
    await capture("2026-10-30T14:05:00Z");
    assert.equal(history().hourlySnapshots!.length, 5);
    assert.match(history().hourlyLastError!, /changed during capture/);
    duringCapture = undefined;
    await capture("2026-10-30T14:10:00Z");
    assert.equal(history().hourlySnapshots!.length, 6);
    const beforeMissed = calls;
    await capture("2026-10-30T15:55:00Z");
    await capture("2026-10-31T12:05:00Z");
    await capture("2026-11-26T12:05:00Z");
    assert.equal(calls, beforeMissed, "missed slots, weekends and holidays do not request prices");

    now = new Date("2026-10-30T20:05:00Z");
    assert.equal(claimPortfolioHourlySnapshot("other", now.toISOString(), now), true);
    assert.equal(claimPortfolioHourlySnapshot("other", now.toISOString(), now), false);
    const secondAttempt = new Date("2026-10-30T20:10:00Z");
    assert.equal(claimPortfolioHourlySnapshot("other", now.toISOString(), secondAttempt), true);
    const sample = { ...history().hourlySnapshots![0], slotAt: now.toISOString(), capturedAt: now.toISOString() };
    assert.equal(finishPortfolioHourlySnapshot("other", sample, now), false, "an expired worker cannot finish a newer lease");
    assert.equal(finishPortfolioHourlySnapshot("other", sample, secondAttempt), true);
    assert.equal(claimPortfolioHourlySnapshot("other", now.toISOString(), new Date("2026-10-30T20:15:00Z")), false);
    // Keep the exact retention boundary and physically delete older rows.
    getDb().insert(portfolioHourlySnapshots).values({ ...sample, portfolioId: "active", slotAt: "2026-10-23T20:05:00.000Z" }).run();
    assert.equal(prunePortfolioHourlyHistory(now), 0);
    assert.ok(history().hourlySnapshots!.some((point) => point.slotAt === "2026-10-23T20:05:00.000Z"));
    assert.equal(prunePortfolioHourlyHistory(new Date(now.getTime() + 1)), 1);
    setPortfolioHistoryEnabled("active", false);
    setPortfolioHistoryEnabled("other", false);
    const beforePurge = calls;
    await captureDuePortfolios(new Date("2026-11-07T20:05:00Z"), market);
    assert.equal(calls, beforePurge);
    assert.equal(sql.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM portfolio_hourly_snapshots").get()!.n, 0);
    assert.equal(history().snapshots.length, 1, "purge never removes daily history");
    // Foreign-key cascade also covers the hourly settings/leases.
    sql.exec("DELETE FROM portfolios WHERE id = 'other'");
    assert.equal(sql.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM portfolio_hourly_history_settings WHERE portfolio_id = 'other'").get()!.n, 0);
    closeDatabase();
    ensureLocalDatabase();
    assert.equal(history().enabled, false);
    assert.equal(history().snapshots.length, 1);
  } finally {
    closeDatabase();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
