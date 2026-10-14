import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb, getSqlite } from "../client";
import { applicationSettings, portfolioCashPositions, portfolioDividendPayments, portfolioDividendTracking, portfolioSecurityBalances, portfolios, securities, securityDividendObservations } from "../schema";
import { dividendAmounts, DividendRequestError, validateDividendSettings, type DividendObservation, type DividendPayment, type DividendSettings } from "@/domain/dividends";
import { SUPPORTED_CASH_CURRENCIES } from "@/domain/portfolio";
import { securityListingQuoteSymbol } from "@/domain/security-equivalence";

export function loadDividendSettings(): DividendSettings {
  const row = getDb().select().from(applicationSettings).where(eq(applicationSettings.key, "dividends")).get();
  return row ? validateDividendSettings(JSON.parse(row.valueJson)) : { countryRates: {}, securityRates: {} };
}

export function persistDividendSettings(value: unknown) {
  const settings = validateDividendSettings(value);
  getDb().insert(applicationSettings).values({ key: "dividends", valueJson: JSON.stringify(settings), updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: applicationSettings.key, set: { valueJson: JSON.stringify(settings), updatedAt: new Date().toISOString() } }).run();
  return settings;
}

export function loadDividendObservation(securityId: string) {
  const row = getDb().select().from(securityDividendObservations).where(eq(securityDividendObservations.securityId, securityId)).get();
  if (!row) return undefined;
  return { observation: JSON.parse(row.valueJson) as DividendObservation, retryAfter: row.retryAfter };
}

export function persistDividendObservation(securityId: string, observation: DividendObservation) {
  const previous = loadDividendObservation(securityId)?.observation;
  const paymentDates = { ...(previous?.providerSymbol === observation.providerSymbol ? previous.paymentDates : {}), ...observation.paymentDates };
  for (const calendar of [previous?.providerSymbol === observation.providerSymbol ? previous.upcoming : null, observation.upcoming]) {
    if (calendar?.exDate && calendar.paymentDate && calendar.paymentDate >= calendar.exDate) paymentDates[calendar.exDate] = calendar.paymentDate;
  }
  observation = { ...observation, paymentDates };
  const values = { securityId, providerSymbol: observation.providerSymbol, valueJson: JSON.stringify(observation), capturedAt: observation.capturedAt, retryAfter: null };
  getDb().insert(securityDividendObservations).values(values).onConflictDoUpdate({ target: securityDividendObservations.securityId, set: values }).run();
}

export function deferDividendRefresh(securityId: string, retryAfter: string) {
  getDb().update(securityDividendObservations).set({ retryAfter }).where(eq(securityDividendObservations.securityId, securityId)).run();
}

// Called inside composition transactions, so no observer can see the temporary
// delete/reinsert state. Record only changes, including zero after a sale.
export function recordPortfolioSecurityBalances(portfolioId: string, now = new Date().toISOString()) {
  const sqlite = getSqlite();
  sqlite.transaction(() => {
    if (!sqlite.prepare("SELECT 1 FROM portfolios WHERE id = ?").get(portfolioId)) return;
    sqlite.prepare("INSERT INTO portfolio_dividend_tracking (portfolio_id, started_at) VALUES (?, ?) ON CONFLICT DO NOTHING").run(portfolioId, now);
    const previous = sqlite.prepare(`SELECT security_id AS securityId, quantity, provider_symbol AS providerSymbol FROM portfolio_security_balances
      WHERE id IN (SELECT max(id) FROM portfolio_security_balances WHERE portfolio_id = ? GROUP BY security_id)`).all(portfolioId) as Array<{ securityId: string; quantity: number | null; providerSymbol: string | null }>;
    const rows = sqlite.prepare(`SELECT p.security_id AS securityId, p.quantity, p.price_symbol AS providerSymbol,
      s.primary_ticker AS ticker, s.name, coalesce(s.country, '') AS country,
      CASE WHEN json_valid(s.identifiers_json) THEN json_extract(s.identifiers_json, '$.exchange') END AS exchange
      FROM portfolio_items p JOIN securities s ON s.id = p.security_id WHERE p.portfolio_id = ? AND p.asset_type = 'security'`).all(portfolioId) as Array<(typeof previous)[number] & { ticker: string; name: string; country: string; exchange: string }>;
    const current = rows.map((row) => ({ ...row, providerSymbol: row.providerSymbol ?? securityListingQuoteSymbol(row) ?? null }));
    const existing = new Map(previous.map((row) => [row.securityId, row]));
    const updated = new Map(current.map((row) => [row.securityId, row]));
    const insert = sqlite.prepare("INSERT INTO portfolio_security_balances (portfolio_id, security_id, effective_at, quantity, provider_symbol) VALUES (?, ?, ?, ?, ?)");
    for (const id of new Set([...existing.keys(), ...updated.keys()])) {
      const row = updated.get(id) ?? { securityId: id, quantity: 0, providerSymbol: existing.get(id)!.providerSymbol };
      const old = existing.get(id);
      if (!old || old.quantity !== row.quantity || old.providerSymbol !== row.providerSymbol) insert.run(portfolioId, id, now, row.quantity, row.providerSymbol);
    }
  })();
}

export function loadDividendTracking(portfolioId: string) {
  return getDb().select().from(portfolioDividendTracking).where(eq(portfolioDividendTracking.portfolioId, portfolioId)).get();
}

export function loadSecurityBalances(portfolioId: string) {
  return getDb().select().from(portfolioSecurityBalances).where(eq(portfolioSecurityBalances.portfolioId, portfolioId)).orderBy(asc(portfolioSecurityBalances.effectiveAt), asc(portfolioSecurityBalances.id)).all();
}

export function loadDividendPayments(portfolioId: string): DividendPayment[] {
  return getDb().select().from(portfolioDividendPayments).where(eq(portfolioDividendPayments.portfolioId, portfolioId)).orderBy(asc(portfolioDividendPayments.createdAt)).all().map((row) => JSON.parse(row.valueJson) as DividendPayment);
}

export function dividendSettingsCatalog() {
  const rows = getDb().select({ id: securities.id, ticker: securities.primaryTicker, name: securities.name, country: securities.country }).from(securities).all();
  return { countries: [...new Set(rows.map((row) => row.country ?? "Not reported"))].sort(), securities: rows };
}

function validatePayment(input: Omit<DividendPayment, "id" | "grossAmount" | "netAmount">) {
  const amounts = dividendAmounts(input.quantity, input.amountPerShare, input.withholdingRate, input.fees);
  if (!SUPPORTED_CASH_CURRENCIES.includes(input.currency as typeof SUPPORTED_CASH_CURRENCIES[number])) throw new DividendRequestError("Select a supported payment currency.");
  const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!validDate(input.exDate) || !validDate(input.paymentDate) || input.paymentDate < input.exDate || input.paymentDate > new Date().toISOString().slice(0, 10)) throw new DividendRequestError("A valid ex-date and past or current payment date are required.");
  return amounts;
}

export function confirmDividendPayment(portfolioId: string, providerSymbol: string, input: Omit<DividendPayment, "id" | "grossAmount" | "netAmount">) {
  const amounts = validatePayment(input);
  const db = getDb();
  return db.transaction((tx) => {
    if (!tx.select().from(portfolios).where(eq(portfolios.id, portfolioId)).get()) throw new DividendRequestError("Portfolio unavailable.");
    const existing = tx.select().from(portfolioDividendPayments).where(and(eq(portfolioDividendPayments.portfolioId, portfolioId), eq(portfolioDividendPayments.securityId, input.securityId), eq(portfolioDividendPayments.exDate, input.exDate))).get();
    if (existing) throw new DividendRequestError("This dividend has already been recorded. Cash was not credited again.");
    const now = new Date().toISOString();
    const payment: DividendPayment = { ...input, ...amounts, id: randomUUID() };
    tx.insert(portfolioDividendPayments).values({ id: payment.id, portfolioId, securityId: input.securityId, providerSymbol, exDate: input.exDate, valueJson: JSON.stringify(payment), createdAt: now }).run();
    if (input.cashCredited && amounts.netAmount !== 0) {
      const current = tx.select().from(portfolioCashPositions).where(and(eq(portfolioCashPositions.portfolioId, portfolioId), eq(portfolioCashPositions.currency, input.currency))).get();
      const amount = (current?.amount ?? 0) + amounts.netAmount;
      if (!Number.isFinite(amount)) throw new DividendRequestError("The resulting cash balance is too large.");
      if (amount === 0) tx.delete(portfolioCashPositions).where(and(eq(portfolioCashPositions.portfolioId, portfolioId), eq(portfolioCashPositions.currency, input.currency))).run();
      else tx.insert(portfolioCashPositions).values({ portfolioId, currency: input.currency, amount, updatedAt: now }).onConflictDoUpdate({ target: [portfolioCashPositions.portfolioId, portfolioCashPositions.currency], set: { amount, updatedAt: now } }).run();
      tx.update(portfolios).set({ updatedAt: now }).where(eq(portfolios.id, portfolioId)).run();
    }
    return payment;
  });
}

// The event lookup and cash credit share a transaction. Concurrent requests,
// scheduler ticks and restarts must never credit the same distribution twice.
export function recordAutomaticDividendPayment(portfolioId: string, providerSymbol: string, input: Omit<DividendPayment, "id" | "grossAmount" | "netAmount">): DividendPayment | null {
  return getDb().transaction((tx) => {
    const existing = tx.select().from(portfolioDividendPayments).where(and(eq(portfolioDividendPayments.portfolioId, portfolioId), eq(portfolioDividendPayments.securityId, input.securityId), eq(portfolioDividendPayments.exDate, input.exDate))).get();
    return existing ? null : confirmDividendPayment(portfolioId, providerSymbol, { ...input, cashCredited: true, automatic: true });
  });
}

export function adjustDividendPayment(portfolioId: string, paymentId: string, input: Record<string, unknown>): DividendPayment {
  return getDb().transaction((tx) => {
    const row = tx.select().from(portfolioDividendPayments).where(and(eq(portfolioDividendPayments.portfolioId, portfolioId), eq(portfolioDividendPayments.id, paymentId))).get();
    if (!row) throw new DividendRequestError("Payment unavailable.");
    const previous = JSON.parse(row.valueJson) as DividendPayment;
    if (typeof input.currency !== "string" || typeof input.paymentDate !== "string") throw new DividendRequestError("Invalid payment fields.");
    const payment = { ...previous, quantity: input.quantity as number, amountPerShare: input.amountPerShare as number,
      withholdingRate: input.withholdingRate as number, fees: input.fees as number, currency: input.currency, paymentDate: input.paymentDate };
    Object.assign(payment, validatePayment(payment));
    tx.update(portfolioDividendPayments).set({ valueJson: JSON.stringify(payment) }).where(eq(portfolioDividendPayments.id, paymentId)).run();
    if (previous.cashCredited) {
      const deltas = new Map<string, number>([[previous.currency, -previous.netAmount]]);
      deltas.set(payment.currency, (deltas.get(payment.currency) ?? 0) + payment.netAmount);
      const now = new Date().toISOString();
      for (const [currency, delta] of deltas) {
        if (delta === 0) continue;
        const current = tx.select().from(portfolioCashPositions).where(and(eq(portfolioCashPositions.portfolioId, portfolioId), eq(portfolioCashPositions.currency, currency))).get();
        const amount = (current?.amount ?? 0) + delta;
        if (!Number.isFinite(amount)) throw new DividendRequestError("The resulting cash balance is too large.");
        if (amount === 0) tx.delete(portfolioCashPositions).where(and(eq(portfolioCashPositions.portfolioId, portfolioId), eq(portfolioCashPositions.currency, currency))).run();
        else tx.insert(portfolioCashPositions).values({ portfolioId, currency, amount, updatedAt: now }).onConflictDoUpdate({ target: [portfolioCashPositions.portfolioId, portfolioCashPositions.currency], set: { amount, updatedAt: now } }).run();
      }
      tx.update(portfolios).set({ updatedAt: now }).where(eq(portfolios.id, portfolioId)).run();
    }
    return payment;
  });
}
