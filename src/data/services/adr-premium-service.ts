import "server-only";
import type { Holding } from "@/domain/etf";
import { ADR_PAIRS, adrPairForSecurity, calculateAdrPremium, type AdrPair, type AdrPairId, type AdrPremiumView } from "@/domain/adr-premium";
import { fetchTradingViewChart, type TradingViewChart } from "../providers/tradingview-chart";

type ChartFetcher = typeof fetchTradingViewChart;
const CACHE_MS = 15 * 60_000;

export function createAdrPremiumLoader(fetchChart: ChartFetcher = fetchTradingViewChart, clock = Date.now) {
  const cache = new Map<string, { view: AdrPremiumView; expiresAt: number }>();
  const inFlight = new Map<string, Promise<AdrPremiumView>>();

  async function retrieve(pair: AdrPair): Promise<AdrPremiumView> {
    const requests = [
      () => fetchChart(pair.localSymbol, "1D", 20),
      () => fetchChart(pair.adrSymbol, "1D", 20),
      () => fetchChart(pair.overnightSymbol, "1", 2_000),
      () => fetchChart(pair.fxSymbol, "5", 2_000),
    ];
    const charts = await Promise.allSettled(requests.map((fetch) => Promise.resolve().then(fetch)));
    // Retry only failed connections once; successful market observations are reused.
    const failedIndexes = charts.flatMap((chart, index) => chart.status === "rejected" ? [index] : []);
    const retries = await Promise.allSettled(failedIndexes.map((index) => Promise.resolve().then(requests[index])));
    failedIndexes.forEach((index, retryIndex) => { charts[index] = retries[retryIndex]; });
    const rows = (index: number, currency: string, timezone?: string) => {
      const chart = charts[index];
      if (chart.status !== "fulfilled" || chart.value.currency !== currency
        || (timezone && chart.value.timezone !== timezone)) return [];
      return (chart.value as TradingViewChart).bars;
    };
    const calculated = calculateAdrPremium(pair, {
      localDaily: rows(0, pair.localCurrency, pair.localTimezone),
      usDaily: rows(1, "USD", "America/New_York"),
      overnight: rows(2, "USD", "America/New_York"),
      fx: rows(3, pair.localCurrency),
    }, clock());
    const previous = cache.get(pair.id)?.view;
    // An intermittent overnight/FX failure must not replace a known aligned
    // comparison with prices from different times for that same Asian session.
    const retainAligned = previous?.observation?.mode === "aligned"
      && calculated.observation?.mode === "closing-prices"
      && previous.observation.localCloseAt === calculated.observation.localCloseAt;
    const view: AdrPremiumView = retainAligned ? {
      ...previous, sourceStatus: "stale",
    } : calculated.observation ? {
      pair, ...calculated, sourceStatus: "live", capturedAt: new Date(clock()).toISOString(),
    } : previous?.observation ? { ...previous, sourceStatus: "stale" } : {
      pair, ...calculated, sourceStatus: "unavailable", capturedAt: new Date(clock()).toISOString(),
    };
    cache.set(pair.id, { view, expiresAt: clock() + (view.sourceStatus === "live" ? CACHE_MS : 60_000) });
    return view;
  }

  return (security: Pick<Holding, "ticker" | "name" | "isin" | "securityId"> | AdrPairId, forceRefresh = false): Promise<AdrPremiumView | null> => {
    const pair = typeof security === "string" ? ADR_PAIRS.find((pair) => pair.id === security) : adrPairForSecurity(security);
    if (!pair) return Promise.resolve(null);
    const running = inFlight.get(pair.id);
    if (running) return running;
    const cached = cache.get(pair.id);
    if (!forceRefresh && cached && cached.expiresAt > clock()) {
      return Promise.resolve({ ...cached.view, sourceStatus: cached.view.sourceStatus === "live" ? "cached" : cached.view.sourceStatus });
    }
    const request = retrieve(pair).finally(() => inFlight.delete(pair.id));
    inFlight.set(pair.id, request);
    return request;
  };
}

export const getAdrPremium = createAdrPremiumLoader();
