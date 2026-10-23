import "server-only";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { getDb } from "@/db/client";
import { loadPortfolioById } from "@/db/repositories/portfolio-repository";
import { deletePortfolioJournalEntry, loadPortfolioJournalEntries, recordPortfolioChange } from "@/db/repositories/portfolio-journal-repository";
import { journalComposition, journalPositionKey, reconstructPortfolio, removeJournalEntry, valueCounterfactual, type CounterfactualMarket, type PortfolioJournal } from "@/domain/portfolio-journal";
import { mapWithConcurrency } from "@/domain/async-utils";
import { getAvailableMarketPrices, getFxRate } from "./market-price-service";

export class PortfolioJournalError extends Error {}

export class PortfolioJournalDeletionError extends PortfolioJournalError {
  constructor(message: string, public status: 404 | 409) { super(message); }
}

export function getPortfolioJournal(portfolioId: string): PortfolioJournal {
  ensureLocalDatabase();
  return getDb().transaction(() => {
    const stored = loadPortfolioById(portfolioId);
    if (!stored) throw new PortfolioJournalError("The saved portfolio no longer exists.");
    const current = journalComposition(stored);
    if (!loadPortfolioJournalEntries(portfolioId).length) recordPortfolioChange(portfolioId, undefined, current, { kind: "baseline" });
    return { portfolioId, current, entries: loadPortfolioJournalEntries(portfolioId) };
  });
}

export function deletePortfolioJournalState(portfolioId: string, entryId: number): PortfolioJournal {
  ensureLocalDatabase();
  return getDb().transaction(() => {
    const stored = loadPortfolioById(portfolioId);
    if (!stored) throw new PortfolioJournalDeletionError("The saved portfolio no longer exists.", 404);
    const journal = { portfolioId, current: journalComposition(stored), entries: loadPortfolioJournalEntries(portfolioId) };
    const index = journal.entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) throw new PortfolioJournalDeletionError("This journal entry is unavailable. Reload the journal.", 404);
    let updated;
    try { updated = removeJournalEntry(journal, entryId); }
    catch (error) { throw new PortfolioJournalDeletionError(error instanceof Error ? error.message : "Journal entry could not be deleted.", 409); }
    deletePortfolioJournalEntry(portfolioId, entryId, updated.entries[index]);
    return { ...updated, entries: loadPortfolioJournalEntries(portfolioId) };
  });
}

const providers = { getAvailableMarketPrices, getFxRate };

export async function getPortfolioCounterfactual(portfolioId: string, entryId: number, market = providers) {
  const journal = getPortfolioJournal(portfolioId);
  let composition;
  try { composition = reconstructPortfolio(journal, entryId); }
  catch (error) { throw new PortfolioJournalError(error instanceof Error ? error.message : "Reconstruction unavailable."); }
  const assets = [...new Map([...composition.items, ...journal.current.items].map((p) => [journalPositionKey(p), p])).values()];
  const currencies = [...new Set([...composition.cashPositions, ...journal.current.cashPositions].map((p) => p.currency))].filter((currency) => currency !== "USD");
  const [quotes, rates] = await Promise.all([
    market.getAvailableMarketPrices(assets),
    mapWithConcurrency(currencies, 3, async (currency) => {
      try { return await market.getFxRate(currency); } catch { return null; }
    }),
  ]);
  const data: CounterfactualMarket = { prices: {}, fx: {}, fetchedAt: new Date().toISOString() };
  for (const [key, quote] of quotes) data.prices[key] = { priceUsd: quote.priceUsd, asOf: quote.asOf, stale: quote.sourceStatus === "stale" };
  for (const rate of rates) if (rate) data.fx[rate.currency] = { rateToUsd: rate.rateToUsd, asOf: rate.asOf, stale: rate.sourceStatus === "stale" };
  const current = getPortfolioJournal(portfolioId);
  if (JSON.stringify(current.entries) !== JSON.stringify(journal.entries) || JSON.stringify(current.current) !== JSON.stringify(journal.current)) {
    throw new PortfolioJournalError("Portfolio changed during valuation. Close and reopen the journal to reload it.");
  }
  return { entryId, market: data, valuation: valueCounterfactual(composition, data), currentValuation: valueCounterfactual(journal.current, data) };
}
