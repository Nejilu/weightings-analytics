export type QuoteSession = "regular" | "pre-market" | "post-market";
export type QuoteSource = "TradingView" | "Yahoo Finance";

export interface MarketQuote {
  symbol: string;
  price: number;
  currency: string;
  asOf: string;
  source: QuoteSource;
  session: QuoteSession;
  delaySeconds?: number;
  activeSession?: string;
}

function observation(price: unknown, seconds: unknown, now: number) {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 ||
    typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds * 1_000 > now + 60_000) return null;
  return { price, time: seconds * 1_000 };
}

function localClock(time: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(time);
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}

export function selectTradingViewQuote(symbol: string, values: Record<string, unknown>, now = Date.now()): MarketQuote | null {
  if (typeof values.currency_code !== "string" || !values.currency_code.trim()) return null;
  const regular = observation(values.lp, values.lp_time, now);
  const extended = observation(values.rtc, values.rtc_time, now);
  const activeSession = typeof values.current_session === "string" ? values.current_session : "";
  const timezone = typeof values.timezone === "string" ? values.timezone : "America/New_York";
  let useExtended = false;
  let extendedSession: QuoteSession = "post-market";
  if (extended && activeSession !== "market" && activeSession !== "regular") {
    try {
      const trade = localClock(extended.time, timezone);
      extendedSession = trade.hour < 12 ? "pre-market" : "post-market";
      const expected = activeSession === "pre_market" ? "pre-market" : activeSession === "post_market" ? "post-market" : null;
      // lp_time may advance after the close without lp becoming a post-market
      // price. Prefer the actual active-session trade even in that case.
      // Conversely, yesterday's rtc must not masquerade as today's premarket.
      useExtended = expected ? trade.date === localClock(now, timezone).date && extendedSession === expected
        : !regular || extended.time > regular.time ||
          (trade.date === localClock(regular.time, timezone).date && extendedSession === "post-market");
    } catch { /* Invalid session timezone: retain the regular observation. */ }
  }
  const selected = useExtended ? extended : regular;
  if (!selected) return null;
  const delay = typeof values.update_mode === "string" ? /delayed_streaming_(\d+)/.exec(values.update_mode) : null;
  return {
    symbol, price: selected.price, currency: values.currency_code.trim(),
    asOf: new Date(selected.time).toISOString(), source: "TradingView",
    session: useExtended ? extendedSession : "regular",
    activeSession, ...(delay ? { delaySeconds: Number(delay[1]) } : {}),
  };
}

export interface YahooQuoteValues {
  symbol: string;
  currency?: string;
  marketState?: string;
  regularMarketPrice?: number;
  regularMarketTime?: Date;
  preMarketPrice?: number;
  preMarketTime?: Date;
  postMarketPrice?: number;
  postMarketTime?: Date;
}

export function selectYahooQuote(values: YahooQuoteValues, now = Date.now()): MarketQuote | null {
  const candidates = ([
    ["regular", values.regularMarketPrice, values.regularMarketTime],
    ["pre-market", values.preMarketPrice, values.preMarketTime],
    ["post-market", values.postMarketPrice, values.postMarketTime],
  ] as const).flatMap(([session, price, time]) => {
    if (values.marketState === "REGULAR" && session !== "regular") return [];
    const selected = observation(price, time instanceof Date ? time.getTime() / 1_000 : undefined, now);
    return selected ? [{ ...selected, session }] : [];
  }).sort((a, b) => b.time - a.time);
  const selected = candidates[0];
  if (!selected || !values.currency?.trim()) return null;
  return { symbol: values.symbol, price: selected.price, currency: values.currency,
    asOf: new Date(selected.time).toISOString(), source: "Yahoo Finance", session: selected.session };
}

export async function loadPreferredQuote(
  symbols: string[],
  providers: { tradingView: (symbol: string) => Promise<MarketQuote | null>; yahoo: () => Promise<MarketQuote | null> },
): Promise<MarketQuote> {
  let primary: MarketQuote | null = null;
  for (const symbol of symbols) {
    try { primary = await providers.tradingView(symbol); } catch { /* Try another exact-listing alias or Yahoo. */ }
    if (primary) break;
  }
  if (primary) return primary;
  try {
    const fallback = await providers.yahoo();
    if (fallback) return fallback;
  } catch { /* Both providers are unavailable. The service owns the stale-cache fallback. */ }
  throw new Error("No usable TradingView or Yahoo Finance quote is available.");
}
