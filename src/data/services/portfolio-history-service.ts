import "server-only";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { databasePath } from "@/db/client";
import { anchorPortfolioQuantities, loadPortfolioById, type StoredPortfolio } from "@/db/repositories/portfolio-repository";
import {
  claimPortfolioSnapshot, failPortfolioSnapshot, finishPortfolioSnapshot,
  latestPortfolioSnapshot, loadPortfolioHistory, portfolioHistoryIds, setPortfolioHistoryEnabled,
  claimPortfolioHourlySnapshot, failPortfolioHourlySnapshot, finishPortfolioHourlySnapshot,
  latestPortfolioHourlySnapshot, prunePortfolioHourlyHistory,
} from "@/db/repositories/portfolio-history-repository";
import { portfolioHistoryClock, portfolioHourlySlot, portfolioSnapshotDue } from "@/domain/portfolio-history";
import { getFxRate, valueCashPositions, valuePortfolioItems } from "./market-price-service";
import { PortfolioRequestError } from "./portfolio-service";
import { findEtfById } from "@/db/repositories/catalog-repository";
import { buildInvestedSnapshot, investedPositionKey, type InvestedPosition } from "@/domain/portfolio-invested-return";
import type { PortfolioItem } from "@/domain/portfolio";
import type { PortfolioHistoryResolution, PortfolioRecordedSnapshot } from "@/domain/portfolio-history";

const pending = new Map<string, Promise<void>>();
const refresh = { forceRefresh: true, requireFresh: true };
const providers = { getFxRate, valueCashPositions, valuePortfolioItems };

async function captureInvested(date: string, items: PortfolioItem[], eurToUsd: number, previous: PortfolioRecordedSnapshot | undefined, market: typeof providers) {
  try {
    const positions: InvestedPosition[] = items.filter((item) => item.quantity !== 0).map((item) => ({
      kind: item.kind, referenceId: item.referenceId, ticker: item.ticker,
      quantity: item.quantity ?? NaN, priceUsd: item.currentPriceUsd ?? NaN,
      exposureMultiplier: item.kind === "etf" ? Math.abs(findEtfById(item.referenceId)?.exposureMultiplier ?? 1) : 1,
    }));
    if (!positions.length && !previous?.invested?.positions.length) return null;
    const prices = new Map(positions.map((p) => [investedPositionKey(p), p.priceUsd]));
    // Sold positions still need today's quote to mark the previous book. Batch
    // these separately; a missing quote must not prevent the normal NAV capture.
    const missing = previous?.invested?.positions.filter((p) => !prices.has(investedPositionKey(p))) ?? [];
    if (missing.length) {
      const marked = await market.valuePortfolioItems(missing.map((p) => ({
        id: investedPositionKey(p), kind: p.kind, referenceId: p.referenceId, ticker: p.ticker,
        name: p.ticker, quantity: p.quantity, allocationWeight: 1, inputMode: "shares", inputAmount: p.quantity,
      })), 0, refresh);
      for (const item of marked.items) if (item.priceStatus !== "stale" && item.currentPriceUsd) prices.set(investedPositionKey(item), item.currentPriceUsd);
    }
    return buildInvestedSnapshot(date, positions, eurToUsd, previous, prices);
  } catch {
    return null;
  }
}

function composition(stored: StoredPortfolio) {
  return JSON.stringify({ updatedAt: stored.updatedAt, items: stored.items, cash: stored.cashPositions });
}

export function capturePortfolioIfDue(id: string, now = new Date(), market = providers): Promise<void> {
  return capturePortfolioSnapshotIfDue(id, now, market, "daily");
}

export function capturePortfolioHourlyIfDue(id: string, now = new Date(), market = providers): Promise<void> {
  return capturePortfolioSnapshotIfDue(id, now, market, "hourly");
}

function capturePortfolioSnapshotIfDue(id: string, now: Date, market: typeof providers, resolution: PortfolioHistoryResolution): Promise<void> {
  const key = `${databasePath()}::${id}::${resolution}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = (async () => {
    const startedAt = Date.now();
    ensureLocalDatabase();
    const stored = loadPortfolioById(id);
    if (!stored || (!stored.items.length && !stored.cashPositions.length)) return;
    const hourly = resolution === "hourly";
    const slotAt = hourly ? portfolioHourlySlot(now) : null;
    if (hourly && !slotAt) return;
    const previous = hourly ? latestPortfolioHourlySnapshot(id, now) : latestPortfolioSnapshot(id);
    const reason = hourly ? null : portfolioSnapshotDue(now, previous);
    if (hourly ? !claimPortfolioHourlySnapshot(id, slotAt!, now) : !reason || !claimPortfolioSnapshot(id, now)) return;
    try {
      const [cash, eur] = await Promise.all([
        market.valueCashPositions(stored.cashPositions, refresh), market.getFxRate("EUR", refresh),
      ]);
      const valued = await market.valuePortfolioItems(stored.items, cash.reduce((sum, position) => sum + (position.valueUsd ?? 0), 0), refresh);
      if (eur.sourceStatus === "stale" || cash.some((position) => position.fxStatus === "stale") || valued.items.some((item) => item.priceStatus === "stale")) {
        throw new Error("Fresh quotes and exchange rates are unavailable. Capture will be retried.");
      }
      const valueUsd = valued.totalMarketValueUsd;
      if (!Number.isFinite(valueUsd) || valueUsd <= 0 || !Number.isFinite(eur.rateToUsd) || eur.rateToUsd <= 0) {
        throw new Error("A positive portfolio value and EUR/USD exchange rate are required.");
      }
      const invested = await captureInvested(slotAt ?? portfolioHistoryClock(now).date, valued.items, eur.rateToUsd, previous, market);
      const current = loadPortfolioById(id);
      if (!current) return;
      if (composition(current) !== composition(stored)) throw new Error("Portfolio changed during capture. Capture will be retried.");
      // Fix legacy value-based positions to shares so future observations track
      // the same holdings rather than resetting to the original input value.
      if (stored.items.some((item) => !item.quantity)) anchorPortfolioQuantities(id, valued.items);
      const capturedAt = new Date(now.getTime() + Date.now() - startedAt).toISOString();
      if (hourly && portfolioHourlySlot(new Date(capturedAt)) !== slotAt) throw new Error("Hourly capture window elapsed. No historical value was reconstructed.");
      const quoteDates = [...valued.items.map((item) => item.priceAsOf), ...cash.map((position) => position.fxAsOf), eur.asOf]
        .filter((date): date is string => Boolean(date)).sort();
      const snapshot = {
        date: portfolioHistoryClock(new Date(capturedAt)).date, capturedAt,
        valueUsd, valueEur: valueUsd / eur.rateToUsd, eurToUsd: eur.rateToUsd,
        invested,
        quotesAsOf: quoteDates[0] ?? eur.asOf, fxAsOf: eur.asOf,
      };
      if (hourly) finishPortfolioHourlySnapshot(id, { ...snapshot, slotAt: slotAt!, reason: "hourly" }, now);
      else finishPortfolioSnapshot(id, { ...snapshot, reason: reason! });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Portfolio capture failed. It will be retried.";
      if (hourly) failPortfolioHourlySnapshot(id, now, message);
      else failPortfolioSnapshot(id, message);
    }
  })().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export async function captureDuePortfolios(now?: Date, market = providers) {
  ensureLocalDatabase();
  // Purge even outside market hours and when every portfolio is paused.
  prunePortfolioHourlyHistory(now ?? new Date());
  // A failed portfolio must not prevent the remaining portfolios being saved.
  for (const id of portfolioHistoryIds()) {
    try {
      await capturePortfolioHourlyIfDue(id, now ?? new Date(), market);
    } catch (error) { console.error("Hourly portfolio capture failed.", error); }
    try {
      await capturePortfolioIfDue(id, now ?? new Date(), market);
    } catch (error) { console.error("Daily portfolio capture failed.", error); }
  }
}

export async function getPortfolioHistory(id: string) {
  ensureLocalDatabase();
  if (!loadPortfolioById(id)) throw new PortfolioRequestError("The saved portfolio no longer exists.");
  await capturePortfolioIfDue(id);
  await capturePortfolioHourlyIfDue(id);
  return loadPortfolioHistory(id);
}

export async function updatePortfolioHistory(id: string, enabled: boolean) {
  ensureLocalDatabase();
  if (!loadPortfolioById(id)) throw new PortfolioRequestError("The saved portfolio no longer exists.");
  setPortfolioHistoryEnabled(id, enabled);
  return getPortfolioHistory(id);
}
