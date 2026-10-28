import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getDb, getSqlite } from "@/db/client";
import { etfs, securities } from "@/db/schema";
import { savePortfolioRecordAsEtf } from "@/db/repositories/portfolio-repository";
import { replacePortfolioEtfRecord } from "@/db/repositories/local-etf-repository";
import { findEtfById } from "@/db/repositories/catalog-repository";
import { persistFxRate, persistMarketPrice } from "@/db/repositories/market-price-repository";
import { getPortfolioCounterfactual, getPortfolioJournal } from "@/data/services/portfolio-journal-service";
import type { PortfolioItem } from "@/domain/portfolio";
import { publicationCatalog } from "./public-data";
import { publicPortfolioJournal } from "./public-portfolio-journal";
import { invalidateSiteResults, siteRuntime } from "./site-runtime";
import { withSiteAccess } from "./site-route";
import { GET as publicJournalGET } from "@/app/api/v1/portfolio/published/[etfId]/journal/route";
import { GET as publicCounterfactualGET } from "@/app/api/v1/portfolio/published/[etfId]/counterfactual/route";
import { GET as ownerJournalGET, DELETE as ownerJournalDELETE } from "@/app/api/v1/portfolio/journal/route";
import { GET as ownerCounterfactualGET } from "@/app/api/v1/portfolio/counterfactual/route";

test("visitor journals and counterfactuals enforce publication, omit amounts for weights and never grant mutations", async () => {
  const keys = ["DATABASE_PATH", "SITE_ACCESS_MODE", "SITE_LOCAL_PUBLIC_PREVIEW"];
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), "published-journal-"));
  const originalFetch = globalThis.fetch;
  const context = (etfId: string) => ({ params: Promise.resolve({ etfId }) });
  const request = (path: string, method = "GET") => new Request(`http://127.0.0.1${path}`, { method, headers: { host: "127.0.0.1", origin: "http://127.0.0.1" } });
  const path = (id: string, kind = "journal") => `/api/v1/portfolio/published/${id}/${kind}`;
  const near = (value: number, expected: number) => assert.ok(Math.abs(value - expected) < 1e-8);
  const forbidden = (payload: unknown) => {
    const json = JSON.stringify(payload);
    for (const secret of ["quantity", "Quantity", "beforeAmount", "afterAmount", "valueUsd", "priceUsd", "rateToUsd", "market", "patch", "123.456", "54321.09", "saved-portfolio-", "SECRET"]) assert(!json.includes(secret), secret);
  };
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    process.env.SITE_ACCESS_MODE = "local";
    process.env.SITE_LOCAL_PUBLIC_PREVIEW = "true";
    siteRuntime.limits.clear();
    ensureLocalDatabase();
    const now = new Date().toISOString();
    for (const [id, ticker] of [["journal-a", "AAA"], ["journal-b", "BBB"]]) {
      getDb().insert(securities).values({ id, primaryTicker: ticker, name: ticker, assetClass: "Equity", sector: "Technology", country: "United States" }).run();
      persistMarketPrice({ assetKind: "security", assetId: id, providerSymbol: ticker, price: ticker === "AAA" ? 101 : 80, currency: "USD", fxToUsd: 1,
        priceUsd: ticker === "AAA" ? 101 : 80, asOf: now, fetchedAt: now, sourceStatus: "cached" });
    }
    persistFxRate({ currency: "EUR", providerSymbol: "EURUSD=X", rateToUsd: 1.2, asOf: now, fetchedAt: now, sourceStatus: "cached" });
    globalThis.fetch = async () => { throw new Error("These tests must only use the quote cache"); };
    const item = (id: string, ticker: string, quantity: number, price: number): PortfolioItem => ({ id, kind: "security", referenceId: id, ticker, name: ticker,
      allocationWeight: 1, inputMode: "shares", inputAmount: quantity, quantity, currentValueUsd: quantity * price });
    const created = new Map<string, ReturnType<typeof savePortfolioRecordAsEtf>>();
    for (const visibility of ["public", "weights", "private"] as const) {
      const saved = savePortfolioRecordAsEtf({ ticker: `J${visibility.toUpperCase()}`, name: `Published ${visibility}`, description: "SECRET owner notes", visibility }, {
        id: "source", name: "SECRET owner name", baseCurrency: "USD", updatedAt: now,
        items: [item("journal-a", "AAA", 100, 100)], cashPositions: [{ currency: "USD", amount: 5000 }, { currency: "EUR", amount: 1000, valueUsd: 1100 }],
      });
      replacePortfolioEtfRecord({ id: saved.id, portfolioId: saved.portfolioId!, ticker: saved.ticker, name: saved.name, description: "SECRET owner notes", editableDescription: "SECRET", visibility,
        items: [item("journal-a", "AAA", 123.456, 101), item("journal-b", "BBB", -12.345, 80)],
        cashPositions: [{ currency: "USD", amount: 54321.09 }, { currency: "EUR", amount: 5000, valueUsd: 6000 }] });
      created.set(visibility, saved);
    }
    const countBefore = getSqlite().prepare("SELECT count(*) AS n FROM portfolio_journal_entries").get();
    for (const visibility of ["public", "weights"] as const) {
      const saved = created.get(visibility)!;
      const raw = getPortfolioJournal(saved.portfolioId!);
      const response = await publicJournalGET(request(path(saved.id)), context(saved.id));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control")!, /no-store/);
      const published = (await response.json()).data;
      assert.equal(published.portfolioId, saved.id);
      assert.equal(published.amountsVisible, visibility === "public");
      assert.equal(published.entries.length, 2);
      assert.equal(published.entries[1].composition.items[1].short, true);
      assert(!JSON.stringify(published).includes("SECRET"));
      assert(!JSON.stringify(published).includes(saved.portfolioId!));
      if (visibility === "public") {
        assert.equal(published.entries[0].valueUsd, 16100);
        assert.equal(published.entries[1].composition.items[0].quantity, 123.456);
      } else forbidden(published);
      const selection = `${path(saved.id, "counterfactual")}?entryId=${raw.entries[0].id}`;
      const counterResponse = await publicCounterfactualGET(request(selection), context(saved.id));
      assert.equal(counterResponse.status, 200);
      const result = (await counterResponse.json()).data;
      assert.equal(result.valuation.items[0].ticker, "AAA");
      near(result.returns.counterfactualPct, (16300 / 16100 - 1) * 100);
      near(result.returns.actualPct, (71802.546 / 16100 - 1) * 100);
      near(result.returns.differencePct, (16300 / 71802.546 - 1) * 100);
      near(result.valuation.items[0].weight, 10100 / 16300 * 100);
      assert.equal(result.market, undefined);
      if (visibility === "public") assert.equal(result.valuation.valueUsd, 16300); else forbidden(result);
      assert.equal((await ownerJournalGET(request(`/api/v1/portfolio/journal?portfolioId=${saved.portfolioId}`))).status, 403);
      assert.equal((await ownerJournalDELETE(request(`/api/v1/portfolio/journal?portfolioId=${saved.portfolioId}&entryId=${raw.entries[0].id}`, "DELETE"))).status, 403);
      assert.equal((await ownerCounterfactualGET(request(`/api/v1/portfolio/counterfactual?portfolioId=${saved.portfolioId}&entryId=${raw.entries[0].id}`))).status, 403);
    }
    assert.deepEqual(getSqlite().prepare("SELECT count(*) AS n FROM portfolio_journal_entries").get(), countBefore);
    const hidden = created.get("private")!;
    const visible = created.get("weights")!;
    const privateEntry = getPortfolioJournal(hidden.portfolioId!).entries[0];
    assert.equal((await publicJournalGET(request(path(hidden.id)), context(hidden.id))).status, 404);
    assert.equal((await publicCounterfactualGET(request(`${path(hidden.id, "counterfactual")}?entryId=${privateEntry.id}`), context(hidden.id))).status, 404);
    assert.equal((await publicCounterfactualGET(request(`${path(visible.id, "counterfactual")}?entryId=${privateEntry.id}`), context(visible.id))).status, 404);
    assert.equal((await publicJournalGET(request(path(visible.portfolioId!)), context(visible.portfolioId!))).status, 404);
    assert.equal((await publicJournalGET(request(path("ivv-us")), context("ivv-us"))).status, 404);

    // Disclosure is re-evaluated after the asynchronous handler, even if a DB
    // edit bypassed the usual revision invalidation.
    const full = created.get("public")!;
    const fullJournal = getPortfolioJournal(full.portfolioId!);
    const result = await getPortfolioCounterfactual(full.portfolioId!, fullJournal.entries[0].id);
    const downgrade = withSiteAccess(async () => {
      getDb().update(etfs).set({ visibility: "weights" }).where(eq(etfs.id, full.id)).run();
      return Response.json({ data: { journal: fullJournal, result: { ...result, SECRET: 123456789, market: { ...result.market, SECRET: "do not publish" } } } });
    }, "portfolio-public-counterfactual");
    const downgraded = await downgrade(request(`${path(full.id, "counterfactual")}?entryId=${fullJournal.entries[0].id}`));
    assert.equal(downgraded.status, 200);
    forbidden((await downgraded.json()).data);
    const revoke = withSiteAccess(async () => {
      getDb().update(etfs).set({ visibility: "private" }).where(eq(etfs.id, full.id)).run();
      invalidateSiteResults();
      return Response.json({ data: fullJournal });
    }, "portfolio-public-journal");
    assert.equal((await revoke(request(path(full.id)))).status, 409);

    // Historical sources also obey confidentiality after they are removed from
    // the current book, and their names must not leak through change titles.
    const base = findEtfById("ivv-us")!;
    getDb().insert(etfs).values({ ...base, issuer: base.issuer ?? "Test", id: "hidden-source", ticker: "HIDDEN", isin: "HIDDEN-ISIN", visibility: "private" }).run();
    const history = savePortfolioRecordAsEtf({ ticker: "HISTORY", name: "Published history", description: "", visibility: "public" }, {
      id: "source", name: "Old history", baseCurrency: "USD", updatedAt: now,
      items: [{ ...item("hidden-source", "HIDDEN", 10, 100), kind: "etf" }], cashPositions: [{ currency: "USD", amount: 5000 }],
    });
    replacePortfolioEtfRecord({ id: history.id, portfolioId: history.portfolioId!, ticker: history.ticker, name: history.name, description: "", editableDescription: "", visibility: "public",
      items: [item("journal-a", "AAA", 10, 101)], cashPositions: [{ currency: "USD", amount: 5000 }] });
    const old = getPortfolioJournal(history.portfolioId!);
    const safe = publicPortfolioJournal(old, history.id, publicationCatalog());
    assert.equal(safe.entries.length, 1);
    assert(!JSON.stringify(safe).includes("HIDDEN"));
    assert(!JSON.stringify(safe).includes("hidden-source"));
    assert.equal((await publicCounterfactualGET(request(`${path(history.id, "counterfactual")}?entryId=${old.entries[0].id}`), context(history.id))).status, 404);

    const noLog = savePortfolioRecordAsEtf({ ticker: "NOLOG", name: "No log", description: "", visibility: "weights" }, { id: "source", name: "No log", baseCurrency: "USD", updatedAt: now, items: [], cashPositions: [{ currency: "USD", amount: 1000 }] });
    getSqlite().prepare("DELETE FROM portfolio_journal_entries WHERE portfolio_id = ?").run(noLog.portfolioId);
    const empty = (await (await publicJournalGET(request(path(noLog.id)), context(noLog.id))).json()).data;
    assert.deepEqual(empty.entries, []);
    assert.equal((getSqlite().prepare("SELECT count(*) AS n FROM portfolio_journal_entries WHERE portfolio_id = ?").get(noLog.portfolioId) as { n: number }).n, 0);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
