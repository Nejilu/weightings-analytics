import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getSqlite, getDb } from "@/db/client";
import { etfs } from "@/db/schema";
import { ISHARES_HOLDINGS_HASH_PREFIX } from "@/data/providers/ishares-csv";
import { findEtfById } from "@/db/repositories/catalog-repository";
import { persistSnapshot } from "@/db/repositories/holdings-repository";
import { persistMarketPrice, persistFxRate } from "@/db/repositories/market-price-repository";
import { loadDefaultPortfolio, loadPortfolioById, replaceDefaultPortfolio, saveDefaultPortfolioAsEtf } from "@/db/repositories/portfolio-repository";
import { replacePortfolioEtfRecord } from "@/db/repositories/local-etf-repository";
import type { PortfolioItem } from "@/domain/portfolio";
import { clonePortfolio } from "./portfolio-clone-service";
import { previewPortfolio, savePortfolio, savePortfolioAsEtf } from "./portfolio-service";
import { POST } from "@/app/api/v1/portfolio/clone/route";
import { POST as previewPOST, GET as portfolioGET } from "@/app/api/v1/portfolio/route";
import { POST as createPOST } from "@/app/api/v1/portfolio/save-as-etf/route";
import { PortfolioCloneRequestError } from "@/domain/portfolio-clone";

test("clones ETF and portfolio weights in EUR without saving or linking sources; saved quantities remain independent", async () => {
  const oldPath = process.env.DATABASE_PATH;
  const oldMode = process.env.SITE_ACCESS_MODE;
  const oldFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "portfolio-clone-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    process.env.SITE_ACCESS_MODE = "local";
    closeDatabase(); ensureLocalDatabase();
    globalThis.fetch = async () => { throw new Error("No provider calls are expected with cached fixtures."); };
    const etf = { ...findEtfById("qtop-us")!, id: "clone-source-etf", ticker: "CLNF", isin: "LOCAL-CLONE-SOURCE" };
    getDb().insert(etfs).values({ ...etf, issuer: etf.issuer ?? "iShares" }).run();
    persistSnapshot({ etf, asOf: "2026-10-09", fetchedAt: new Date().toISOString(), sourceUrl: etf.holdingsUrl, sourceHash: `${ISHARES_HOLDINGS_HASH_PREFIX}clone`, holdings: [
      { securityId: "CLONE-A", ticker: "CLA", name: "Clone A", assetClass: "Equity", sector: "Technology", country: "United States", weight: 60 },
      { securityId: "CLONE-B", ticker: "CLB", name: "Clone B", assetClass: "Equity", sector: "Technology", country: "United States", weight: 40 },
      ...["C", "D", "E"].map((ticker) => ({ securityId: `CLONE-${ticker}`, ticker: `CL${ticker}`, name: `Clone ${ticker}`, assetClass: "Equity", sector: "Technology", country: "United States", weight: 0 })),
    ] });
    const now = new Date().toISOString();
    for (const [assetId, price] of [["CLONE-A", 20], ["CLONE-B", 100]] as const) persistMarketPrice({ assetKind: "security", assetId, price, priceUsd: price, currency: "USD", fxToUsd: 1, providerSymbol: assetId === "CLONE-A" ? "CLA" : "CLB", asOf: now, fetchedAt: now, sourceStatus: "cached" });
    persistFxRate({ currency: "EUR", rateToUsd: 1.2, providerSymbol: "EURUSD=X", asOf: now, fetchedAt: now, sourceStatus: "cached" });
    await savePortfolio([{ id: "source-a", kind: "security", referenceId: "CLONE-A", inputMode: "value", inputAmount: 5_000 }], [{ currency: "USD", amount: 5_000 }]);
    const source = await savePortfolioAsEtf({ ticker: "SRC", name: "Source portfolio" });
    const before = JSON.stringify(loadDefaultPortfolio());
    const count = getSqlite().prepare("SELECT COUNT(*) AS count FROM portfolios").get();
    const draft = { amount: 100_000, currency: "EUR" as const, sources: [{ sourceId: source.id, allocation: 50 }, { sourceId: etf.id, allocation: 50 }] };
    const result = await clonePortfolio(draft);
    assert.equal(JSON.stringify(loadDefaultPortfolio()), before);
    assert.deepEqual(getSqlite().prepare("SELECT COUNT(*) AS count FROM portfolios").get(), count);
    assert.ok(result.portfolio.items.every((item) => item.kind === "security"));
    assert.equal(result.portfolio.items.find((item) => item.referenceId === "CLONE-A")!.quantity, 3300);
    assert.equal(result.portfolio.items.find((item) => item.referenceId === "CLONE-B")!.quantity, 240);
    assert.equal(result.portfolio.cashPositions[0].amount, 25_000);
    assert.equal(result.portfolio.cashPositions[0].currency, "EUR");
    assert.equal(result.portfolio.analysis!.totalMarketValueUsd, 120_000);
    assert.equal(result.sources[0].amount, 50_000);
    const drafts = result.portfolio.items.map((item) => ({ id: item.id, kind: item.kind, referenceId: item.referenceId, inputMode: "shares" as const, inputAmount: item.quantity! }));
    await savePortfolio(drafts, result.portfolio.cashPositions);
    const saved = await savePortfolioAsEtf({ ticker: "COPY", name: "Independent clone" });
    const quantities = loadPortfolioById(saved.portfolioId!)!.items.map((item) => item.quantity);
    getSqlite().prepare("UPDATE portfolio_items SET quantity=1 WHERE portfolio_id=?").run(source.portfolioId);
    assert.deepEqual(loadPortfolioById(saved.portfolioId!)!.items.map((item) => item.quantity), quantities);
    assert.ok(loadPortfolioById(saved.portfolioId!)!.items.every((item) => item.kind === "security"));
    await assert.rejects(clonePortfolio({ ...draft, sources: [{ sourceId: "missing", allocation: 100 }] }), PortfolioCloneRequestError);
    const headers = { host: "localhost", "content-type": "application/json", origin: "http://localhost" };
    assert.equal((await POST(new Request("http://localhost/api/v1/portfolio/clone", { method: "POST", headers, body: JSON.stringify({ ...draft, amount: -1 }) }))).status, 400);
    const response = await POST(new Request("http://localhost/api/v1/portfolio/clone", { method: "POST", headers, body: JSON.stringify({ ...draft, sources: [{ sourceId: etf.id, allocation: 100 }] }) }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.portfolio.items.length, 2);
    const countBeforePreview = getSqlite().prepare("SELECT count(*) AS count FROM portfolios").get();
    assert.equal((await portfolioGET(new Request("http://localhost/api/v1/portfolio", { headers }))).status, 200);
    const previewResponse = await previewPOST(new Request("http://localhost/api/v1/portfolio", {
      method: "POST", headers, body: JSON.stringify({ items: drafts, cashPositions: result.portfolio.cashPositions }),
    }));
    assert.equal(previewResponse.status, 200);
    assert.deepEqual(getSqlite().prepare("SELECT count(*) AS count FROM portfolios").get(), countBeforePreview);
    const directResponse = await createPOST(new Request("http://localhost/api/v1/portfolio/save-as-etf", {
      method: "POST", headers, body: JSON.stringify({ ticker: "DIRECT", name: "Direct creation", items: drafts, cashPositions: result.portfolio.cashPositions }),
    }));
    assert.equal(directResponse.status, 201);
    const direct = (await directResponse.json()).data;
    assert.deepEqual(loadPortfolioById(direct.portfolioId)!.items.map(item => item.quantity), quantities);
    assert.equal(loadPortfolioById("default-portfolio"), undefined);
    const invalidCreate = await createPOST(new Request("http://localhost/api/v1/portfolio/save-as-etf", {
      method: "POST", headers, body: JSON.stringify({ ticker: "INVALID", name: "Invalid creation", items: {} }),
    }));
    assert.equal(invalidCreate.status, 400);
    const negativeCash = await createPOST(new Request("http://localhost/api/v1/portfolio/save-as-etf", {
      method: "POST", headers, body: JSON.stringify({ ticker: "BORROW", name: "Negative cash", items: [], cashPositions: [{ currency: "USD", amount: -100 }] }),
    }));
    assert.equal(negativeCash.status, 400);
    // An entirely cash allocation is valid and can be saved as a portfolio.
    const cash = await previewPortfolio([], [{ currency: "EUR", amount: 10_000 }]);
    assert.equal(cash.analysis!.totalMarketValueUsd, 12_000);
    await savePortfolio([], [{ currency: "EUR", amount: 10_000 }]);
    const cashSaved = await savePortfolioAsEtf({ ticker: "CASHCOPY", name: "Cash portfolio" });
    assert.equal(loadPortfolioById(cashSaved.portfolioId!)!.items.length, 0);
    // Broad index copies must survive SQLite's bound-parameter limit on creation and editing.
    const insertSecurity = getSqlite().prepare("INSERT INTO securities (id, primary_ticker, name, asset_class, sector, country) VALUES (?, ?, ?, ?, ?, ?)");
    const large = Array.from({ length: 3000 }, (_, index): PortfolioItem => ({ id: `large-${index}`, kind: "security", referenceId: `large-security-${index}`, ticker: `L${index}`, name: `Large ${index}`, allocationWeight: 100 / 3000, quantity: 1, inputMode: "shares", inputAmount: 1 }));
    getSqlite().transaction(() => large.forEach((item) => insertSecurity.run(item.referenceId, item.ticker, item.name, "Equity", "Technology", "United States")))();
    replaceDefaultPortfolio(large, []);
    assert.equal(loadDefaultPortfolio().items.length, 3000);
    const largeSaved = saveDefaultPortfolioAsEtf({ ticker: "LARGE", name: "Large cloned allocation", description: "" });
    assert.equal(loadPortfolioById(largeSaved.portfolioId!)!.items.length, 3000);
    replacePortfolioEtfRecord({ id: largeSaved.id, portfolioId: largeSaved.portfolioId!, ticker: "LARGE", name: "Edited large allocation", description: "", editableDescription: "", items: large.map((item) => ({ ...item, quantity: 2 })), cashPositions: [] });
    assert.ok(loadPortfolioById(largeSaved.portfolioId!)!.items.every((item) => item.quantity === 2));
  } finally {
    globalThis.fetch = oldFetch;
    closeDatabase();
    if (oldPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = oldPath;
    if (oldMode === undefined) delete process.env.SITE_ACCESS_MODE; else process.env.SITE_ACCESS_MODE = oldMode;
    rmSync(directory, { recursive: true, force: true });
  }
});
