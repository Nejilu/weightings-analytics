import "server-only";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { databasePath } from "@/db/client";
import { findSecuritiesByIds } from "@/db/repositories/catalog-repository";
import { loadPortfolioById } from "@/db/repositories/portfolio-repository";
import { adjustDividendPayment, confirmDividendPayment, deferDividendRefresh, loadDividendObservation, loadDividendPayments, loadDividendSettings, loadDividendTracking, loadSecurityBalances, persistDividendObservation, recordAutomaticDividendPayment, recordPortfolioSecurityBalances } from "@/db/repositories/dividend-repository";
import { directDividendPositions, dividendAmounts, DividendRequestError, eligibleDividendQuantity, type DividendEvent, type DividendObservation, type DividendPayment, type PortfolioDividends } from "@/domain/dividends";
import { securityListingQuoteSymbol } from "@/domain/security-equivalence";
import { dateInTimezone } from "@/domain/upcoming-earnings";
import { mapWithConcurrency } from "@/domain/async-utils";
import { dividendWithholdingRate } from "@/data/dividend-withholding";
import { fetchYahooDividends } from "@/data/providers/yahoo-dividends";
import { findMarketPrice } from "@/db/repositories/market-price-repository";
import { getDb } from "@/db/client";
import { portfolioItems, portfolioSecurityBalances } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SUPPORTED_CASH_CURRENCIES } from "@/domain/portfolio";

const TTL_MS = 86_400_000;
const RETRY_MS = 15 * 60_000;
const inFlight = new Map<string, Promise<{ observation: DividendObservation | undefined; sourceStatus: DividendEvent["sourceStatus"] }>>();
const failures = new Map<string, number>();

async function observationFor(securityId: string, symbol: string, fetcher: typeof fetchYahooDividends) {
  const key = `${databasePath()}::${securityId}::${symbol}`;
  const row = loadDividendObservation(securityId);
  const cached = row?.observation.providerSymbol === symbol ? row.observation : undefined;
  const now = Date.now();
  if (cached && now - Date.parse(cached.capturedAt) < TTL_MS) return { observation: cached, sourceStatus: "cached" as const };
  if ((failures.get(key) ?? 0) > now || (cached && Date.parse(row?.retryAfter ?? "") > now)) return { observation: cached, sourceStatus: cached ? "stale" as const : "unavailable" as const };
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    try {
      const observation = await fetcher(symbol);
      persistDividendObservation(securityId, observation);
      failures.delete(key);
      return { observation: loadDividendObservation(securityId)!.observation, sourceStatus: "live" as const };
    } catch {
      if (failures.size >= 5000) failures.delete(failures.keys().next().value!);
      failures.set(key, now + RETRY_MS);
      if (cached) deferDividendRefresh(securityId, new Date(now + RETRY_MS).toISOString());
      return { observation: cached, sourceStatus: cached ? "stale" as const : "unavailable" as const };
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

export async function getPortfolioDividends(portfolioId: string, fetcher = fetchYahooDividends): Promise<PortfolioDividends> {
  ensureLocalDatabase();
  const portfolio = loadPortfolioById(portfolioId);
  if (!portfolio) throw new DividendRequestError("Portfolio unavailable.");
  recordPortfolioSecurityBalances(portfolioId);
  const tracking = loadDividendTracking(portfolioId)!;
  const positions = directDividendPositions(portfolio.items);
  const balances = loadSecurityBalances(portfolioId);
  const ids = [...new Set([...positions.map((item) => item.referenceId), ...balances.map((row) => row.securityId)])];
  const securities = findSecuritiesByIds(ids);
  const settings = loadDividendSettings();
  const recorded = new Set(loadDividendPayments(portfolioId).map((payment) => `${payment.securityId}:${payment.exDate}`));
  const settlementToday = new Date().toISOString().slice(0, 10);
  let cashUpdated = false;
  const eventGroups = await mapWithConcurrency(ids, 2, async (id): Promise<DividendEvent[]> => {
    const security = securities.get(id);
    if (!security) return [];
    const item = positions.find((item) => item.referenceId === id);
    const history = balances.filter((row) => row.securityId === id);
    const symbol = item?.priceSymbol ?? (item ? findMarketPrice("security", id)?.providerSymbol ?? securityListingQuoteSymbol(security) : history.at(-1)?.providerSymbol);
    const storedObservation = loadDividendObservation(id)?.observation;
    const knownDates = { ...storedObservation?.paymentDates };
    if (storedObservation?.upcoming?.exDate && storedObservation.upcoming.paymentDate) knownDates[storedObservation.upcoming.exDate] = storedObservation.upcoming.paymentDate;
    // A sale after detachment leaves dividend rights in the portfolio. Keep
    // refreshing those rights until paid, without fetching ETF constituents.
    const pendingRights = !item && storedObservation && storedObservation.providerSymbol === symbol && Object.keys(knownDates).some((exDate) => {
      const quantity = eligibleDividendQuantity(history, exDate, storedObservation.exchangeTimezone, symbol!);
      return exDate <= settlementToday && quantity !== null && quantity > 0 && !recorded.has(`${id}:${exDate}`);
    });
    const result = symbol ? item || pendingRights ? await observationFor(id, symbol, fetcher) : { observation: storedObservation, sourceStatus: "cached" as const } : { observation: undefined, sourceStatus: "unavailable" as const };
    const observation = result.observation?.providerSymbol === symbol ? result.observation : undefined;
    const rate = dividendWithholdingRate(id, security.country, settings);
    const base = { securityId: id, ticker: item?.ticker ?? security.ticker, name: security.name, country: security.country,
      providerSymbol: symbol ?? "", currentQuantity: item?.quantity ?? null, withholdingRate: rate, currency: observation?.currency ?? null,
      capturedAt: observation?.capturedAt ?? null, sourceStatus: observation ? result.sourceStatus : "unavailable" as const,
      recordDate: null, calendarAvailable: observation?.calendarAvailable ?? false };
    if (!observation) return [{ ...base, exDate: null, paymentDate: null, amountPerShare: null, eligibleQuantity: null, grossAmount: null, estimatedNet: null }];
    const today = dateInTimezone(Date.now(), observation.exchangeTimezone);
    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const upcoming = observation.upcoming;
    const showUpcoming = upcoming && ((upcoming.exDate && upcoming.exDate >= today) || (upcoming.paymentDate && upcoming.paymentDate >= today));
    const events: DividendEvent[] = observation.historical.map((event) => {
      const quantity = eligibleDividendQuantity(history, event.exDate, observation.exchangeTimezone, symbol!);
      const amounts = quantity !== null && quantity > 0 ? dividendAmounts(quantity, event.amountPerShare, rate ?? 0) : null;
      return { ...base, exDate: event.exDate, amountPerShare: event.amountPerShare,
        eligibleQuantity: quantity, grossAmount: amounts?.grossAmount ?? null, estimatedNet: rate === null || !base.currency ? null : amounts?.netAmount ?? null,
        paymentDate: observation.paymentDates?.[event.exDate] ?? (upcoming?.exDate === event.exDate ? upcoming.paymentDate : null) };
    });
    for (const event of events) {
      if (!event.exDate || !event.paymentDate || event.paymentDate > today || event.paymentDate > settlementToday || event.paymentDate < event.exDate
        || !event.eligibleQuantity || event.eligibleQuantity <= 0 || !event.amountPerShare || event.withholdingRate === null
        || !event.currency || !SUPPORTED_CASH_CURRENCIES.includes(event.currency as typeof SUPPORTED_CASH_CURRENCIES[number])) continue;
      const payment = recordAutomaticDividendPayment(portfolioId, symbol!, { securityId: id, ticker: base.ticker,
        exDate: event.exDate, paymentDate: event.paymentDate, quantity: event.eligibleQuantity,
        amountPerShare: event.amountPerShare, currency: event.currency, withholdingRate: event.withholdingRate, fees: 0, cashCredited: true });
      if (payment) cashUpdated = true;
    }
    if (showUpcoming && !events.some((event) => event.exDate && event.exDate === upcoming.exDate)) {
      events.push({ ...base, exDate: upcoming.exDate, paymentDate: upcoming.paymentDate, amountPerShare: null,
        eligibleQuantity: null, grossAmount: null, estimatedNet: null });
    }
    const visible = events.filter((event) => !event.exDate || event.exDate >= cutoff || (event.paymentDate && event.paymentDate >= today));
    return visible.length ? visible : item ? [{ ...base, exDate: null, paymentDate: null, amountPerShare: null, eligibleQuantity: null, grossAmount: null, estimatedNet: null }] : [];
  });
  return { events: eventGroups.flat().sort((a, b) => (b.exDate ?? b.paymentDate ?? "").localeCompare(a.exDate ?? a.paymentDate ?? "") || a.ticker.localeCompare(b.ticker)),
    payments: loadDividendPayments(portfolioId), trackingStartedAt: tracking.startedAt, cashUpdated,
    cashBalances: loadPortfolioById(portfolioId)?.cashPositions.map(({ currency, amount }) => ({ currency, amount })) ?? [] };
}

// Shared observations mean a stock present in several portfolios is fetched
// once per TTL. Only currently held direct stocks cause provider requests.
export async function refreshPortfolioDividends() {
  ensureLocalDatabase();
  const ids = [...new Set([...getDb().select({ id: portfolioItems.portfolioId }).from(portfolioItems).where(eq(portfolioItems.assetType, "security")).all().map((row) => row.id),
    ...getDb().select({ id: portfolioSecurityBalances.portfolioId }).from(portfolioSecurityBalances).all().map((row) => row.id)])];
  for (const id of ids) {
    try { await getPortfolioDividends(id); } catch { /* A deleted portfolio must not stop other portfolios. */ }
  }
}

export function recordDividendPayment(portfolioId: string, value: unknown): DividendPayment {
  ensureLocalDatabase();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DividendRequestError("Invalid payment.");
  const input = value as Omit<DividendPayment, "id" | "grossAmount" | "netAmount">;
  if (typeof input.securityId !== "string" || typeof input.exDate !== "string" || typeof input.paymentDate !== "string" || typeof input.currency !== "string" || typeof input.cashCredited !== "boolean") throw new DividendRequestError("Invalid payment fields.");
  const observation = loadDividendObservation(input.securityId)?.observation;
  const portfolio = loadPortfolioById(portfolioId);
  const balances = loadSecurityBalances(portfolioId);
  if (!portfolio || (!directDividendPositions(portfolio.items).some((item) => item.referenceId === input.securityId) && !balances.some((row) => row.securityId === input.securityId))) throw new DividendRequestError("Select a stock directly held in this portfolio.");
  if (!observation || !observation.historical.some((event) => event.exDate === input.exDate)) throw new DividendRequestError("Select a known historical dividend.");
  const item = portfolio.items.find((item) => item.kind === "security" && item.referenceId === input.securityId);
  return confirmDividendPayment(portfolioId, observation.providerSymbol, { ...input, ticker: item?.ticker ?? observation.providerSymbol });
}

export function updateDividendPayment(portfolioId: string, value: unknown): DividendPayment {
  ensureLocalDatabase();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DividendRequestError("Invalid payment.");
  const input = value as Record<string, unknown>;
  if (typeof input.paymentId !== "string") throw new DividendRequestError("Select a received dividend.");
  return adjustDividendPayment(portfolioId, input.paymentId, input);
}
