import "server-only";
import YahooFinance from "yahoo-finance2";
import { dateInTimezone } from "@/domain/upcoming-earnings";
import type { DividendObservation } from "@/domain/dividends";

const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"], queue: { concurrency: 2, interval: 500 } });

async function boundedRequest<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Yahoo dividend request timed out.")), 20_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function normalizeYahooDividends(symbol: string, data: {
  meta: { symbol?: string; currency: string; exchangeTimezoneName?: string };
  events?: { dividends?: Array<{ date: Date; amount: number }>; splits?: Array<{ date: Date; numerator: number; denominator: number }> };
}, calendar: { exDividendDate?: Date; dividendDate?: Date } | undefined, capturedAt = new Date().toISOString()): DividendObservation {
  if (data.meta.symbol && data.meta.symbol.toUpperCase() !== symbol.toUpperCase()) throw new Error("Yahoo returned a different dividend listing.");
  let timezone = data.meta.exchangeTimezoneName ?? "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { timezone = "UTC"; }
  const date = (value: Date | undefined) => value instanceof Date && Number.isFinite(value.valueOf()) ? dateInTimezone(value.valueOf(), timezone) : null;
  // Yahoo chart dividends are split-adjusted. Restore the amount in the share
  // units that existed at the ex-date, matching the dated ownership journal.
  const historical = (data.events?.dividends ?? []).flatMap((event) => {
    const exDate = date(event.date);
    const splits = (data.events?.splits ?? []).filter((split) => split.date > event.date);
    if (splits.some((split) => !Number.isFinite(split.numerator) || !Number.isFinite(split.denominator) || split.numerator <= 0 || split.denominator <= 0)) return [];
    const amountPerShare = splits.reduce((amount, split) => amount * split.numerator / split.denominator, event.amount);
    return exDate && Number.isFinite(amountPerShare) && amountPerShare > 0 ? [{ exDate, amountPerShare }] : [];
  }).sort((a, b) => a.exDate.localeCompare(b.exDate));
  // Calendar events are date-only values encoded as UTC midnight, unlike
  // chart events stamped at the exchange session. Preserve the advertised day.
  const calendarDate = (value: Date | undefined) => value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString().slice(0, 10) : null;
  const exDate = calendarDate(calendar?.exDividendDate);
  const paymentDate = calendarDate(calendar?.dividendDate);
  // Dates are exposed independently; never invent a payment date or divide
  // annual dividendRate by four to manufacture a declared dividend amount.
  const currency = /^[A-Z]{3}$/.test(data.meta.currency) && data.meta.currency !== "GBX" ? data.meta.currency : null;
  return { providerSymbol: symbol, currency, exchangeTimezone: timezone, capturedAt, historical,
    upcoming: exDate || paymentDate ? { exDate, paymentDate: paymentDate && (!exDate || paymentDate >= exDate) ? paymentDate : null } : null,
    calendarAvailable: calendar !== undefined };
}

export async function fetchYahooDividends(symbol: string): Promise<DividendObservation> {
  const started = new Date();
  const from = new Date(started); from.setUTCFullYear(from.getUTCFullYear() - 2);
  const chart = await boundedRequest(yahoo.chart(symbol, { period1: from, period2: started, interval: "1d", events: "div|split" }));
  let calendar;
  try {
    calendar = (await boundedRequest(yahoo.quoteSummary(symbol, { modules: ["calendarEvents"] }))).calendarEvents;
  } catch { /* A calendar failure must not erase a successful history response. */ }
  return normalizeYahooDividends(symbol, chart, calendar);
}
