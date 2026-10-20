import "server-only";
import { ensureLocalDatabase } from "@/db/bootstrap";
import {
  claimPortfolioMetricsDay, finishPortfolioMetricsDay, portfolioMetricsTargets, portfolioMetricsDayClaimed,
} from "@/db/repositories/portfolio-metrics-refresh-repository";
import { mapWithConcurrency } from "@/domain/async-utils";
import { uniqueEquityHoldings } from "./metrics-overview-model";
import { getHoldingsSnapshot } from "./holdings-service";
import { retrieveSecurityMetrics } from "./security-metrics-service";

const providers = { holdings: getHoldingsSnapshot, metrics: retrieveSecurityMetrics };
const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
});

// Only source observations are refreshed. No aggregate result is persisted,
// and unrelated ETFs in the catalog are never visited by this task.
export async function refreshPortfolioMetricsIfDue(now = new Date(), refresh = providers) {
  if (process.env.PORTFOLIO_METRICS_DAILY_REFRESH === "false") return;
  ensureLocalDatabase();
  const date = dayFormat.format(now);
  // The fifteen-minute checks read one settings row once today's work has
  // been claimed; they do not repeatedly scan a growing portfolio catalog.
  if (portfolioMetricsDayClaimed(date)) return;
  const ids = portfolioMetricsTargets();
  const startedAt = now.toISOString();
  if (!ids.length || !claimPortfolioMetricsDay(date, startedAt)) return;
  const errors: string[] = [];
  let securities = 0;
  try {
    const snapshots = await mapWithConcurrency(ids, 2, async (id) => {
      try { return await refresh.holdings(id); }
      catch (error) {
        errors.push(`${id}: ${error instanceof Error ? error.message : "Holdings unavailable"}`);
        return null;
      }
    });
    const usable = snapshots.filter((snapshot) => snapshot !== null);
    const holdings = uniqueEquityHoldings(usable);
    securities = holdings.length;
    if (holdings.length) {
      const result = await refresh.metrics(holdings, { forceRefresh: true },
        usable.some((snapshot) => snapshot.sourceStatus === "stale"));
      if (result.sourceStatus === "stale") errors.push(...result.sourceWarnings);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Portfolio metrics refresh failed");
  } finally {
    finishPortfolioMetricsDay(date, startedAt, { portfolios: ids.length, securities, errors });
  }
  return { portfolios: ids.length, securities, errors };
}
