import { usEquitySession } from "./us-equity-calendar";

export const PORTFOLIO_HISTORY_TIMEZONE = "America/New_York";
export const PORTFOLIO_HISTORY_CLOSE_MINUTES = 16 * 60 + 10;
export const PORTFOLIO_HISTORY_RETRY_MS = 5 * 60_000;
export const PORTFOLIO_HOURLY_RETENTION_MS = 7 * 86_400_000;
export type PortfolioHistoryResolution = "daily" | "hourly";

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
  hourlySnapshots?: PortfolioHourlySnapshot[];
  hourlyLastAttemptAt?: string | null;
  hourlyLastError?: string | null;
}

export interface PortfolioHourlySnapshot extends Omit<PortfolioValueSnapshot, "reason"> {
  slotAt: string;
  reason: "hourly";
}

export type PortfolioRecordedSnapshot = PortfolioValueSnapshot | PortfolioHourlySnapshot;

// Capture at HH:05, with a 15-minute retry window. A restart never fills old
// slots with today's prices; capturedAt always records the actual observation.
export function portfolioHourlySlot(now: Date): string | null {
  const clock = portfolioHistoryClock(now);
  const session = usEquitySession(clock.date);
  const hour = Math.floor(clock.minutes / 60), minute = clock.minutes % 60;
  if (!session || hour < session.openHour || hour > session.closeHour || minute < 5 || minute >= 20) return null;
  return new Date(now.getTime() - (minute - 5) * 60_000 - now.getUTCSeconds() * 1_000 - now.getUTCMilliseconds()).toISOString();
}

export function portfolioHourlyCutoff(now: Date): string {
  return new Date(now.getTime() - PORTFOLIO_HOURLY_RETENTION_MS).toISOString();
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
