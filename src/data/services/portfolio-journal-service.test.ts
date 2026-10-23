import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getSqlite } from "@/db/client";
import { loadPortfolioById, savePortfolioRecordAsEtf } from "@/db/repositories/portfolio-repository";
import { replacePortfolioEtfRecord } from "@/db/repositories/local-etf-repository";
import { loadPortfolioJournalEntries } from "@/db/repositories/portfolio-journal-repository";
import { journalComposition, reconstructPortfolio } from "@/domain/portfolio-journal";
import type { MarketPrice, PortfolioItem } from "@/domain/portfolio";
import { getPortfolioCounterfactual, getPortfolioJournal } from "./portfolio-journal-service";
import { GET as journalGET } from "@/app/api/v1/portfolio/journal/route";
import { GET as counterfactualGET } from "@/app/api/v1/portfolio/counterfactual/route";
import { adjustDividendPayment, confirmDividendPayment } from "@/db/repositories/dividend-repository";

test("journal persists atomic diffs, reconstructs past holdings and never saves simulated portfolios", async () => {
  const keys = ["DATABASE_PATH", "SITE_ACCESS_MODE", "SITE_LOCAL_PUBLIC_PREVIEW"];
  const env = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), "portfolio-journal-"));
  const item: PortfolioItem = { id: "line-a", kind: "etf", referenceId: "acwi-us", ticker: "ACWI", name: "World ETF", allocationWeight: 50, quantity: 100, inputMode: "shares", inputAmount: 100, currentValueUsd: 10000 };
  try {
    process.env.DATABASE_PATH = join(directory, "journal.sqlite");
    process.env.SITE_ACCESS_MODE = "local";
    process.env.SITE_LOCAL_PUBLIC_PREVIEW = "true";
    ensureLocalDatabase();
    const etf = savePortfolioRecordAsEtf({ ticker: "LOGTEST", name: "Journal test", description: "" }, { id: "source", name: "Source", baseCurrency: "USD", updatedAt: "", items: [item], cashPositions: [{ currency: "USD", amount: 10000 }] });
    const id = etf.portfolioId!;
    const before = journalComposition(loadPortfolioById(id)!);
    const update = { id: etf.id, portfolioId: id, ticker: etf.ticker, name: etf.name, description: "", editableDescription: "", items: [{ ...item, quantity: -20, currentValueUsd: -2000 }], cashPositions: [{ currency: "USD" as const, amount: 22000 }] };
    replacePortfolioEtfRecord(update);
    const journal = getPortfolioJournal(id);
    assert.equal(journal.entries.length, 2);
    assert.equal(journal.entries[0].valueUsd, 20000);
    assert.equal(journal.entries[1].patch.items[0].before!.quantity, 100);
    assert.equal(journal.entries[1].patch.items[0].after!.quantity, -20);
    assert.deepEqual(reconstructPortfolio(journal, journal.entries[0].id), before);
    replacePortfolioEtfRecord({ ...update, items: [{ ...update.items[0], id: "fresh-generated-id", allocationWeight: 99 }] });
    assert.equal(getPortfolioJournal(id).entries.length, 2); // no log for market weight / row-ID churn
    assert.throws(() => replacePortfolioEtfRecord({ ...update, items: [{ ...item, referenceId: "missing-etf" }] }));
    assert.equal(getPortfolioJournal(id).entries.length, 2);
    assert.equal(loadPortfolioById(id)!.items[0].quantity, -20);
    const count = getSqlite().prepare("SELECT count(*) AS n FROM portfolios").get();
    const market = {
      async getAvailableMarketPrices(assets: Array<{kind: "security" | "etf"; referenceId: string}>) { return new Map(assets.map((p) => [`${p.kind}:${p.referenceId}`, { assetKind: p.kind, assetId: p.referenceId, priceUsd: 120, asOf: "2026-10-22", sourceStatus: "cached" } as MarketPrice])); },
      async getFxRate() { throw new Error("No non-USD cash in this example"); },
    };
    const result = await getPortfolioCounterfactual(id, journal.entries[0].id, market);
    assert.equal(result.valuation.valueUsd, 22000);
    assert.equal(result.currentValuation.valueUsd, 19600);
    assert.deepEqual(getSqlite().prepare("SELECT count(*) AS n FROM portfolios").get(), count);
    assert.equal(loadPortfolioById(id)!.items[0].quantity, -20);
    assert.equal(getPortfolioJournal(id).entries.length, 2);
    const req = (path: string, visitor = false) => new Request(`http://${visitor ? "127.0.0.1" : "localhost"}${path}`, { headers: { host: visitor ? "127.0.0.1" : "localhost" } });
    assert.equal((await journalGET(req(`/api/v1/portfolio/journal?portfolioId=${id}`, true))).status, 403);
    assert.equal((await counterfactualGET(req(`/api/v1/portfolio/counterfactual?portfolioId=${id}&entryId=1`, true))).status, 403);
    assert.equal((await journalGET(req("/api/v1/portfolio/journal"))).status, 400);
    assert.equal((await counterfactualGET(req(`/api/v1/portfolio/counterfactual?portfolioId=${id}&entryId=0`))).status, 400);
    assert.equal((await counterfactualGET(req(`/api/v1/portfolio/counterfactual?portfolioId=${id}&entryId=999999`))).status, 409);
    assert.equal((await journalGET(req(`/api/v1/portfolio/journal?portfolioId=${id}`))).status, 200);
    closeDatabase();
    ensureLocalDatabase();
    assert.deepEqual(getPortfolioJournal(id).entries, journal.entries);
    getSqlite().prepare("INSERT INTO securities (id, primary_ticker, name, sector, asset_class, country) VALUES ('journal-dividend', 'DIV', 'Dividend test', 'Other', 'Equity', 'US')").run();
    const today = new Date().toISOString().slice(0, 10);
    const payment = confirmDividendPayment(id, "DIV", { securityId: "journal-dividend", ticker: "DIV", exDate: today, paymentDate: today, quantity: 10,
      amountPerShare: 1, currency: "USD", withholdingRate: 0, fees: 0, cashCredited: true });
    assert.equal(getPortfolioJournal(id).entries.length, 3);
    assert.equal(reconstructPortfolio(getPortfolioJournal(id), journal.entries[1].id).cashPositions[0].amount, 22000);
    adjustDividendPayment(id, payment.id, { ...payment, amountPerShare: 2 });
    assert.equal(getPortfolioJournal(id).entries.length, 4);
    assert.equal(getPortfolioJournal(id).current.cashPositions[0].amount, 22020);
    assert.deepEqual(reconstructPortfolio(getPortfolioJournal(id), journal.entries[0].id), before);
    // Older portfolios get one honest checkpoint; no history predating tracking is invented.
    getSqlite().prepare("INSERT INTO portfolios (id, name) VALUES ('legacy', 'Legacy')").run();
    const legacy = getPortfolioJournal("legacy");
    assert.equal(legacy.entries[0].kind, "baseline");
    assert.equal(getPortfolioJournal("legacy").entries.length, 1);
    getSqlite().prepare("DELETE FROM etfs WHERE id = ?").run(etf.id);
    getSqlite().prepare("DELETE FROM portfolios WHERE id = ?").run(id);
    assert.deepEqual(loadPortfolioJournalEntries(id), []);
  } finally {
    closeDatabase();
    keys.forEach((key, index) => { if (env[index] === undefined) delete process.env[key]; else process.env[key] = env[index]; });
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
