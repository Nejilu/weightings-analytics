import "server-only";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { loadPortfolioHistory } from "@/db/repositories/portfolio-history-repository";
import { loadPortfolioById } from "@/db/repositories/portfolio-repository";
import { getCatalog } from "./catalog-service";
import type { PortfolioDashboardEntry } from "@/domain/portfolio-dashboard";
import { investedIndices } from "@/domain/portfolio-invested-return";

// Reads saved observations only; the existing scheduler owns snapshot capture.
export function getPortfolioDashboard(): PortfolioDashboardEntry[] {
  ensureLocalDatabase();
  return getCatalog().flatMap((group) => group.variants).flatMap((etf) => {
    if (etf.fundType !== "portfolio" || !etf.portfolioId) return [];
    const stored = loadPortfolioById(etf.portfolioId);
    if (!stored) return [];
    const snapshots = loadPortfolioHistory(etf.portfolioId).snapshots.filter((point) =>
      point.valueUsd > 0 && point.valueEur > 0 && Number.isFinite(point.valueUsd) && Number.isFinite(point.valueEur));
    const base = snapshots[0];
    return [{
      id: etf.id, ticker: etf.ticker, name: etf.name, visibility: etf.visibility ?? "private",
      positionsCount: stored.items.length, cashCount: stored.cashPositions.length,
      snapshots: snapshots.map((point) => ({
        date: point.date, valueUsd: point.valueUsd, valueEur: point.valueEur,
        ...investedIndices(point.invested),
        indexUsd: point.valueUsd / base.valueUsd * 100, indexEur: point.valueEur / base.valueEur * 100,
      })),
    }];
  });
}
