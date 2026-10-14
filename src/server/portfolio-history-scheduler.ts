import "server-only";
import { captureDuePortfolios } from "@/data/services/portfolio-history-service";
import { refreshPortfolioDividends } from "@/data/services/portfolio-dividends-service";

const scheduler = globalThis as typeof globalThis & {
  __portfolioHistoryScheduler?: ReturnType<typeof setTimeout>;
  __portfolioDividendScheduler?: ReturnType<typeof setTimeout>;
};

export function startPortfolioHistoryScheduler() {
  if (!scheduler.__portfolioDividendScheduler) {
    const dividends = async () => {
      try { await refreshPortfolioDividends(); }
      catch (error) { console.error("Portfolio dividend check failed.", error); }
      finally {
        scheduler.__portfolioDividendScheduler = setTimeout(() => void dividends(), 60 * 60_000);
        scheduler.__portfolioDividendScheduler.unref();
      }
    };
    scheduler.__portfolioDividendScheduler = setTimeout(() => void dividends(), 30_000);
    scheduler.__portfolioDividendScheduler.unref();
  }
  if (scheduler.__portfolioHistoryScheduler) return;
  const tick = async () => {
    try {
      await captureDuePortfolios();
    } catch (error) {
      console.error("Portfolio history check failed; retrying in one minute.", error);
    } finally {
      scheduler.__portfolioHistoryScheduler = setTimeout(() => void tick(), 60_000);
      scheduler.__portfolioHistoryScheduler.unref();
    }
  };
  // Do not block server startup on external quote providers. The timer runs
  // without a browser being open, as long as this local Node server is running.
  scheduler.__portfolioHistoryScheduler = setTimeout(() => void tick(), 1_000);
  scheduler.__portfolioHistoryScheduler.unref();
}
