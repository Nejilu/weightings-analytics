import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { getDb, getSqlite } from "../client";
import { portfolioHistorySettings, portfolioValueSnapshots, portfolioHourlyHistorySettings, portfolioHourlySnapshots, portfolios } from "../schema";
import type { PortfolioHistory, PortfolioHourlySnapshot, PortfolioValueSnapshot } from "@/domain/portfolio-history";
import { portfolioHourlyCutoff, PORTFOLIO_HISTORY_RETRY_MS } from "@/domain/portfolio-history";

export function portfolioHistoryIds(): string[] {
  return getDb().select({ id: portfolios.id }).from(portfolios).all().map((row) => row.id);
}

export function loadPortfolioHistory(id: string, now = new Date()): PortfolioHistory {
  const settings = getDb().select().from(portfolioHistorySettings).where(eq(portfolioHistorySettings.portfolioId, id)).get();
  const hourly = getDb().select().from(portfolioHourlyHistorySettings).where(eq(portfolioHourlyHistorySettings.portfolioId, id)).get();
  return {
    enabled: settings?.enabled ?? true,
    lastAttemptAt: settings?.lastAttemptAt ?? null,
    lastError: settings?.lastError ?? null,
    snapshots: getDb().select().from(portfolioValueSnapshots).where(eq(portfolioValueSnapshots.portfolioId, id)).orderBy(asc(portfolioValueSnapshots.date)).all(),
    hourlySnapshots: loadPortfolioHourlySnapshots(id, now),
    hourlyLastAttemptAt: hourly?.lastAttemptAt ?? null,
    hourlyLastError: hourly?.lastError ?? null,
  };
}

export function loadPortfolioHourlySnapshots(id: string, now = new Date()): PortfolioHourlySnapshot[] {
  return getDb().select().from(portfolioHourlySnapshots).where(and(
    eq(portfolioHourlySnapshots.portfolioId, id), gte(portfolioHourlySnapshots.slotAt, portfolioHourlyCutoff(now)),
  )).orderBy(asc(portfolioHourlySnapshots.slotAt)).all();
}

export function latestPortfolioHourlySnapshot(id: string, now: Date) {
  return getDb().select().from(portfolioHourlySnapshots).where(and(
    eq(portfolioHourlySnapshots.portfolioId, id), gte(portfolioHourlySnapshots.slotAt, portfolioHourlyCutoff(now)),
  )).orderBy(desc(portfolioHourlySnapshots.slotAt)).limit(1).get();
}

export function prunePortfolioHourlyHistory(now = new Date()) {
  return getDb().delete(portfolioHourlySnapshots).where(lt(portfolioHourlySnapshots.slotAt, portfolioHourlyCutoff(now))).run().changes;
}

// The hourly lease is independent of the daily lease. Check enabled and the
// unique slot atomically, including when separate server workers race.
export function claimPortfolioHourlySnapshot(id: string, slotAt: string, now: Date): boolean {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    sqlite.prepare("INSERT INTO portfolio_history_settings (portfolio_id) VALUES (?) ON CONFLICT DO NOTHING").run(id);
    sqlite.prepare("INSERT INTO portfolio_hourly_history_settings (portfolio_id) VALUES (?) ON CONFLICT DO NOTHING").run(id);
    return sqlite.prepare(`UPDATE portfolio_hourly_history_settings SET slot_at = ?, last_attempt_at = ?
      WHERE portfolio_id = ?
      AND EXISTS (SELECT 1 FROM portfolio_history_settings WHERE portfolio_id = ? AND enabled = 1)
      AND NOT EXISTS (SELECT 1 FROM portfolio_hourly_snapshots WHERE portfolio_id = ? AND slot_at >= ?)
      AND (last_attempt_at IS NULL OR last_attempt_at <= ?)`)
      .run(slotAt, now.toISOString(), id, id, id, slotAt, new Date(now.getTime() - PORTFOLIO_HISTORY_RETRY_MS).toISOString()).changes === 1;
  })();
}

export function finishPortfolioHourlySnapshot(id: string, snapshot: PortfolioHourlySnapshot, attemptedAt: Date) {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const owned = sqlite.prepare(`SELECT 1 FROM portfolio_hourly_history_settings h
      JOIN portfolio_history_settings s ON s.portfolio_id = h.portfolio_id
      WHERE h.portfolio_id = ? AND h.slot_at = ? AND h.last_attempt_at = ? AND s.enabled = 1`)
      .get(id, snapshot.slotAt, attemptedAt.toISOString());
    if (!owned) return false;
    const inserted = getDb().insert(portfolioHourlySnapshots).values({ ...snapshot, portfolioId: id }).onConflictDoNothing().run();
    getDb().update(portfolioHourlyHistorySettings).set({ lastError: null }).where(eq(portfolioHourlyHistorySettings.portfolioId, id)).run();
    return inserted.changes === 1;
  })();
}

export function failPortfolioHourlySnapshot(id: string, attemptedAt: Date, error: string) {
  getDb().update(portfolioHourlyHistorySettings).set({ lastError: error.slice(0, 500) }).where(and(
    eq(portfolioHourlyHistorySettings.portfolioId, id), eq(portfolioHourlyHistorySettings.lastAttemptAt, attemptedAt.toISOString()),
  )).run();
}

export function latestPortfolioSnapshot(id: string) {
  return getDb().select().from(portfolioValueSnapshots).where(eq(portfolioValueSnapshots.portfolioId, id)).orderBy(desc(portfolioValueSnapshots.date)).limit(1).get();
}

export function setPortfolioHistoryEnabled(id: string, enabled: boolean) {
  getDb().insert(portfolioHistorySettings).values({ portfolioId: id, enabled }).onConflictDoUpdate({
    target: portfolioHistorySettings.portfolioId, set: { enabled },
  }).run();
}

// Atomic claim also prevents separate Next workers from refreshing the same
// portfolio simultaneously. Failed/interrupted claims expire after five minutes.
export function claimPortfolioSnapshot(id: string, now: Date): boolean {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    sqlite.prepare("INSERT INTO portfolio_history_settings (portfolio_id) VALUES (?) ON CONFLICT DO NOTHING").run(id);
    return sqlite.prepare(`UPDATE portfolio_history_settings SET last_attempt_at = ?
      WHERE portfolio_id = ? AND enabled = 1 AND (last_attempt_at IS NULL OR last_attempt_at <= ?)`)
      .run(now.toISOString(), id, new Date(now.getTime() - PORTFOLIO_HISTORY_RETRY_MS).toISOString()).changes === 1;
  })();
}

export function finishPortfolioSnapshot(id: string, snapshot: PortfolioValueSnapshot) {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const settings = getDb().select().from(portfolioHistorySettings).where(eq(portfolioHistorySettings.portfolioId, id)).get();
    if (!settings?.enabled) return false;
    const inserted = getDb().insert(portfolioValueSnapshots).values({ ...snapshot, portfolioId: id }).onConflictDoNothing().run();
    getDb().update(portfolioHistorySettings).set({ lastError: null }).where(eq(portfolioHistorySettings.portfolioId, id)).run();
    return inserted.changes === 1;
  })();
}

export function failPortfolioSnapshot(id: string, error: string) {
  getDb().update(portfolioHistorySettings).set({ lastError: error.slice(0, 500) }).where(eq(portfolioHistorySettings.portfolioId, id)).run();
}
