export const PORTFOLIO_HISTORY_TIMEZONE = "America/New_York";
export const PORTFOLIO_HISTORY_CLOSE_MINUTES = 16 * 60 + 10;
export const PORTFOLIO_HISTORY_RETRY_MS = 5 * 60_000;

export interface PortfolioValueSnapshot {
  invested?: import("./portfolio-invested-return").InvestedSnapshot | null;
  date: string;
  capturedAt: string;
  valueUsd: number;
  valueEur: number;
  eurToUsd: number;
  quotesAsOf: string;
  fxAsOf: string;
  reason: "initial" | "scheduled" | "catchup";
}

export interface PortfolioHistory {
  enabled: boolean;
  snapshots: PortfolioValueSnapshot[];
  lastAttemptAt: string | null;
  lastError: string | null;
}

export function portfolioHistoryClock(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PORTFOLIO_HISTORY_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, minutes: Number(part("hour")) * 60 + Number(part("minute")) };
}

// One observation per New York calendar day. A restart records today's actual
// valuation, never manufactured historical closing values for missed days.
export function portfolioSnapshotDue(now: Date, latest?: Pick<PortfolioValueSnapshot, "date" | "capturedAt">): PortfolioValueSnapshot["reason"] | null {
  const clock = portfolioHistoryClock(now);
  if (!latest) return "initial";
  if (latest.date >= clock.date) return null;
  if (clock.minutes >= PORTFOLIO_HISTORY_CLOSE_MINUTES) return "scheduled";
  if (now.getTime() - Date.parse(latest.capturedAt) > 86_400_000) return "catchup";
  return null;
}
