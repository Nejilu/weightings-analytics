import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getSqlite } from "@/db/client";
import { loadDividendObservation, loadDividendPayments, loadDividendSettings, loadSecurityBalances, persistDividendObservation, persistDividendSettings, recordPortfolioSecurityBalances } from "@/db/repositories/dividend-repository";
import { getPortfolioDividends, recordDividendPayment, refreshPortfolioDividends, updateDividendPayment } from "./portfolio-dividends-service";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/v1/settings/route";
import { GET as dividendsGET, POST as dividendsPOST, PATCH as dividendsPATCH } from "@/app/api/v1/portfolio/dividends/route";
import type { DividendObservation } from "@/domain/dividends";

test("direct-stock caching, dated ownership, failures, cash deduplication, persistence and owner routes", async () => {
  const previousPath = process.env.DATABASE_PATH;
  const previousMode = process.env.SITE_ACCESS_MODE;
  const directory = mkdtempSync(join(tmpdir(), "dividend-service-test-"));
  let calls = 0;
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite"); process.env.SITE_ACCESS_MODE = "local";
    ensureLocalDatabase();
    const db = getSqlite();
    db.exec(`INSERT INTO securities (id, name, primary_ticker, asset_class, country, identifiers_json) VALUES ('test-stock', 'Stock', 'TEST', 'Equity', 'United States', '{"exchange":"NASDAQ"}');
      INSERT INTO portfolios (id, name) VALUES ('first', 'First'), ('second', 'Second'), ('etf-only', 'ETF only');
      INSERT INTO portfolio_items (id, portfolio_id, asset_type, security_id, allocation_weight, quantity, price_symbol) VALUES
      ('first-line', 'first', 'security', 'test-stock', 100, 100, 'TEST'), ('second-line', 'second', 'security', 'test-stock', 100, 50, 'TEST');
      INSERT INTO portfolio_items (id, portfolio_id, asset_type, etf_id, allocation_weight, quantity) VALUES ('etf-line', 'etf-only', 'etf', 'ivv-us', 100, 10);
      INSERT INTO portfolio_cash_positions (portfolio_id, currency, amount) VALUES ('first', 'USD', 1000);`);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const before = new Date(Date.now() - 4 * 86_400_000).toISOString();
    recordPortfolioSecurityBalances("first", before);
    recordPortfolioSecurityBalances("second", before);
    const fetcher = async (symbol: string): Promise<DividendObservation> => {
      calls++;
      return { providerSymbol: symbol, currency: "USD", exchangeTimezone: "UTC", capturedAt: new Date().toISOString(),
        historical: [{ exDate: yesterday, amountPerShare: 1.2 }], upcoming: null, calendarAvailable: true };
    };
    const [first, second] = await Promise.all([getPortfolioDividends("first", fetcher), getPortfolioDividends("second", fetcher)]);
    assert.equal(calls, 1);
    assert.equal(first.events[0].eligibleQuantity, 100);
    assert.equal(first.events[0].estimatedNet, 84);
    assert.equal(second.events[0].eligibleQuantity, 50);
    assert.deepEqual((await getPortfolioDividends("etf-only", fetcher)).events, []);
    assert.equal(calls, 1);
    persistDividendSettings({ countryRates: { "United States": 15 }, securityRates: {} });
    assert.equal((await getPortfolioDividends("first", fetcher)).events[0].estimatedNet, 102);
    const input = { securityId: "test-stock", ticker: "untrusted", exDate: yesterday, paymentDate: yesterday, quantity: 100, amountPerShare: 1.2, currency: "USD", withholdingRate: 15, fees: 2, cashCredited: true };
    const payment = recordDividendPayment("first", input);
    assert.equal(payment.netAmount, 100);
    assert.equal(payment.ticker, "TEST");
    assert.deepEqual(db.prepare("SELECT amount FROM portfolio_cash_positions WHERE portfolio_id = 'first'").get(), { amount: 1100 });
    assert.throws(() => recordDividendPayment("first", input), /already been recorded/);
    assert.equal(loadDividendPayments("first").length, 1);
    assert.throws(() => recordDividendPayment("etf-only", input), /directly held/);
    assert.throws(() => recordDividendPayment("second", { ...input, currency: "KRW" }), /supported/);
    assert.equal(loadDividendPayments("second").length, 0);
    recordDividendPayment("second", { ...input, quantity: 50, cashCredited: false });
    assert.equal(db.prepare("SELECT amount FROM portfolio_cash_positions WHERE portfolio_id = 'second'").get(), undefined);
    db.prepare("UPDATE portfolio_items SET quantity = 0 WHERE portfolio_id = 'first'").run();
    recordPortfolioSecurityBalances("first");
    assert.equal(loadSecurityBalances("first").at(-1)?.quantity, 0);
    assert.equal((await getPortfolioDividends("first", fetcher)).events[0].eligibleQuantity, 100);
    const old = { ...loadDividendObservation("test-stock")!.observation, capturedAt: "2000-01-01T00:00:00Z" };
    db.prepare("UPDATE security_dividend_observations SET value_json = ?, captured_at = ? WHERE security_id = 'test-stock'").run(JSON.stringify(old), old.capturedAt);
    const fail = async () => { calls++; throw new Error("rate limit"); };
    assert.equal((await getPortfolioDividends("first", fail)).events[0].sourceStatus, "stale");
    const previousCalls = calls;
    assert.equal((await getPortfolioDividends("first", fail)).events[0].sourceStatus, "stale");
    assert.equal(calls, previousCalls);
    db.prepare("DELETE FROM portfolio_items WHERE portfolio_id = 'first'").run();
    recordPortfolioSecurityBalances("first");
    assert.equal((await getPortfolioDividends("first", fail)).events[0].eligibleQuantity, 100);
    assert.equal(calls, previousCalls, "sold securities must use cached events without another provider call");
    const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, { ...init, headers: { host: "localhost", origin: "http://localhost", "Content-Type": "application/json" } });
    assert.equal((await settingsGET(request("/api/v1/settings"))).status, 200);
    assert.equal((await settingsPUT(request("/api/v1/settings", { method: "PUT", body: '{"dividends":{"countryRates":{"United States":101},"securityRates":{}}}' }))).status, 400);
    assert.equal((await dividendsGET(request("/api/v1/portfolio/dividends?portfolioId=first"))).status, 200);
    assert.equal((await dividendsGET(request("/api/v1/portfolio/dividends?portfolioId=unknown"))).status, 400);
    assert.equal((await dividendsPOST(request("/api/v1/portfolio/dividends?portfolioId=first", { method: "POST", body: JSON.stringify(input) }))).status, 400);
    assert.equal((await settingsGET(new Request("http://external/api/v1/settings", { headers: { host: "external" } }))).status, 403);
    closeDatabase(); ensureLocalDatabase();
    assert.equal(loadDividendSettings().countryRates["United States"], 15);
    assert.equal(loadDividendPayments("first")[0].netAmount, 100);
    getSqlite().prepare("DELETE FROM portfolio_items WHERE portfolio_id = 'second'").run();
    recordPortfolioSecurityBalances("second");
    closeDatabase(); ensureLocalDatabase();
    assert.equal(loadDividendPayments("first")[0].netAmount, 100, "catalog cleanup must preserve sold securities with dividend history");
    getSqlite().prepare("DELETE FROM portfolios WHERE id = 'first'").run();
    assert.equal(loadDividendPayments("first").length, 0);
  } finally {
    closeDatabase();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    if (previousMode === undefined) delete process.env.SITE_ACCESS_MODE; else process.env.SITE_ACCESS_MODE = previousMode;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("automatic settlement preserves payment dates across rollovers, uses ex-date ownership and credits once across refreshes and restarts", async () => {
  const previousPath = process.env.DATABASE_PATH;
  const previousMode = process.env.SITE_ACCESS_MODE;
  const directory = mkdtempSync(join(tmpdir(), "dividend-auto-test-"));
  const date = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const exDate = date(-10);
  const paymentDate = date(-1);
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite"); process.env.SITE_ACCESS_MODE = "local";
    ensureLocalDatabase();
    const db = getSqlite();
    db.exec(`INSERT INTO securities (id, name, primary_ticker, asset_class, country, identifiers_json) VALUES ('auto-stock', 'Auto stock', 'AUTO', 'Equity', 'Taiwan', '{"exchange":"NYSE"}');
      INSERT INTO portfolios (id, name) VALUES ('held', 'Held'), ('sold', 'Sold'), ('late', 'Late');
      INSERT INTO portfolio_items (id, portfolio_id, asset_type, security_id, allocation_weight, quantity, price_symbol) VALUES
      ('held-line', 'held', 'security', 'auto-stock', 100, 100, 'AUTO'), ('sold-line', 'sold', 'security', 'auto-stock', 100, 50, 'AUTO'),
      ('late-line', 'late', 'security', 'auto-stock', 100, 20, 'AUTO');
      INSERT INTO portfolio_cash_positions (portfolio_id, currency, amount) VALUES ('held', 'USD', 1000);`);
    recordPortfolioSecurityBalances("held", `${date(-30)}T12:00:00Z`);
    recordPortfolioSecurityBalances("sold", `${date(-30)}T12:00:00Z`);
    recordPortfolioSecurityBalances("late");
    db.prepare("DELETE FROM portfolio_items WHERE portfolio_id = 'sold'").run(); recordPortfolioSecurityBalances("sold");
    persistDividendObservation("auto-stock", { providerSymbol: "AUTO", currency: "USD", exchangeTimezone: "UTC", capturedAt: "2000-01-01T00:00:00Z",
      historical: [], upcoming: { exDate, paymentDate }, calendarAvailable: true });
    let calls = 0;
    const fetcher = async (): Promise<DividendObservation> => {
      calls++;
      return { providerSymbol: "AUTO", currency: "USD", exchangeTimezone: "UTC", capturedAt: new Date().toISOString(),
        historical: [{ exDate, amountPerShare: 1.2 }, { exDate: date(-2), amountPerShare: 2 }], upcoming: { exDate: date(-2), paymentDate: date(10) }, calendarAvailable: true };
    };
    const [held, duplicate, sold, late] = await Promise.all([getPortfolioDividends("held", fetcher), getPortfolioDividends("held", fetcher), getPortfolioDividends("sold", fetcher), getPortfolioDividends("late", fetcher)]);
    assert.equal(calls, 1);
    assert.equal(Number(held.cashUpdated) + Number(duplicate.cashUpdated), 1);
    assert.equal(held.payments.length, 1, "future payments stay unposted");
    assert.equal(held.payments[0].automatic, true);
    assert.ok(Math.abs(held.payments[0].netAmount - 94.8) < 1e-9);
    assert.equal(sold.payments[0].quantity, 50, "selling after the ex-date preserves rights");
    assert.ok(Math.abs(sold.payments[0].netAmount - 47.4) < 1e-9);
    assert.equal(late.payments.length, 0, "today's first observation must not invent prior ownership");
    assert.equal(loadDividendObservation("auto-stock")!.observation.paymentDates?.[exDate], paymentDate);
    assert.equal(held.events.find((event) => event.exDate === exDate)?.paymentDate, paymentDate);
    assert.deepEqual(held.cashBalances, [{ currency: "USD", amount: 1094.8 }], "the client can detect a cash balance changed by another request or the scheduler");
    assert.deepEqual(db.prepare("SELECT amount FROM portfolio_cash_positions WHERE portfolio_id = 'held'").get(), { amount: 1094.8 });
    await getPortfolioDividends("held", fetcher);
    closeDatabase(); ensureLocalDatabase();
    await refreshPortfolioDividends();
    assert.equal(loadDividendPayments("held").length, 1);
    assert.deepEqual(getSqlite().prepare("SELECT amount FROM portfolio_cash_positions WHERE portfolio_id = 'held'").get(), { amount: 1094.8 });
    const payment = loadDividendPayments("held")[0];
    const corrected = updateDividendPayment("held", { ...payment, paymentId: payment.id, amountPerShare: 1, fees: 1 });
    assert.equal(corrected.netAmount, 78);
    assert.equal(corrected.id, payment.id);
    assert.deepEqual(getSqlite().prepare("SELECT amount FROM portfolio_cash_positions WHERE portfolio_id = 'held'").get(), { amount: 1078 });
    assert.throws(() => updateDividendPayment("sold", { ...payment, paymentId: payment.id }), /unavailable/);
    assert.throws(() => updateDividendPayment("held", { ...payment, paymentId: payment.id, fees: -1 }));
    assert.equal(loadDividendPayments("held")[0].netAmount, 78, "invalid corrections roll back payment and cash");
    persistDividendSettings({ countryRates: { Taiwan: 0 }, securityRates: {} });
    await getPortfolioDividends("held", fetcher);
    assert.equal(loadDividendPayments("held")[0].netAmount, 78, "refreshes and changed tax settings preserve adjusted payments");
    updateDividendPayment("held", { ...corrected, paymentId: payment.id, currency: "EUR" });
    assert.deepEqual(getSqlite().prepare("SELECT currency, amount FROM portfolio_cash_positions WHERE portfolio_id = 'held' ORDER BY currency").all(), [{ currency: "EUR", amount: 78 }, { currency: "USD", amount: 1000 }]);
    const correction = { ...corrected, paymentId: payment.id, amountPerShare: 1.1, fees: 0 };
    const request = new Request("http://localhost/api/v1/portfolio/dividends?portfolioId=held", { method: "PATCH", headers: { host: "localhost", origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify(correction) });
    assert.equal((await dividendsPATCH(request)).status, 200);
    assert.equal((await dividendsPATCH(new Request("http://external/api/v1/portfolio/dividends?portfolioId=held", { method: "PATCH", headers: { host: "external" }, body: JSON.stringify(correction) }))).status, 403);
    assert.equal(loadDividendPayments("held").length, 1);
  } finally {
    closeDatabase();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    if (previousMode === undefined) delete process.env.SITE_ACCESS_MODE; else process.env.SITE_ACCESS_MODE = previousMode;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("automatic payments wait for complete entitlement, date, tax and currency data", async () => {
  const previousPath = process.env.DATABASE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "dividend-missing-test-"));
  const date = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite"); ensureLocalDatabase();
    const db = getSqlite();
    db.exec(`INSERT INTO portfolios (id, name) VALUES ('incomplete', 'Incomplete');`);
    for (const [id, country, currency, paymentDate] of [
      ["no-rate", "Unknown", "USD", date(-1)], ["no-currency", "United States", "KRW", date(-1)],
      ["no-date", "United States", "USD", null], ["future", "United States", "USD", date(1)],
      ["conditional", "Australia", "AUD", date(-1)], ["short", "United States", "USD", date(-1)],
    ] as const) {
      db.prepare("INSERT INTO securities (id, name, primary_ticker, asset_class, country) VALUES (?, ?, ?, 'Equity', ?)").run(id, id, id, country);
      db.prepare("INSERT INTO portfolio_items (id, portfolio_id, asset_type, security_id, allocation_weight, quantity, price_symbol) VALUES (?, 'incomplete', 'security', ?, 10, ?, ?)").run(id, id, id === "short" ? -10 : 10, id);
      persistDividendObservation(id, { providerSymbol: id, currency, exchangeTimezone: "UTC", capturedAt: new Date().toISOString(), historical: [{ exDate: date(-10), amountPerShare: 1 }], upcoming: { exDate: date(-10), paymentDate }, calendarAvailable: true });
    }
    recordPortfolioSecurityBalances("incomplete", `${date(-20)}T12:00:00Z`);
    const unused = async (): Promise<DividendObservation> => { throw new Error("cached observations should be used"); };
    const result = await getPortfolioDividends("incomplete", unused);
    assert.equal(result.payments.length, 0);
    assert.equal(result.cashUpdated, false);
    assert.deepEqual(db.prepare("SELECT count(*) AS count FROM portfolio_cash_positions").get(), { count: 0 });
    persistDividendSettings({ countryRates: { Unknown: 0 }, securityRates: {} });
    assert.equal((await getPortfolioDividends("incomplete", unused)).payments[0].netAmount, 10, "a configured zero rate is valid for automatic settlement");
  } finally {
    closeDatabase();
    if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
