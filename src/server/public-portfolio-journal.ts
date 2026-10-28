import "server-only";
import { journalEntryTitle, reconstructPortfolio, type JournalComposition, type JournalPosition, type PortfolioJournal } from "@/domain/portfolio-journal";
import type { PublishedJournalComposition, PublishedJournalEntry, PublishedJournalValuation, PublishedPortfolioCounterfactual, PublishedPortfolioJournal } from "@/domain/published-portfolio-journal";
import type { getPortfolioCounterfactual } from "@/data/services/portfolio-journal-service";
import { requirePublicEtf, type PublicationCatalog } from "./public-data";
import { AccessError } from "./site-access";

type CounterfactualResult = Awaited<ReturnType<typeof getPortfolioCounterfactual>>;
export interface PublicCounterfactualInput { journal: PortfolioJournal; result: CounterfactualResult }
const visiblePosition = (position: JournalPosition, catalog: PublicationCatalog) => position.kind !== "etf" || catalog.visible(position.referenceId);

export function requirePublishedJournalState(journal: PortfolioJournal, entryId: number, catalog: PublicationCatalog): JournalComposition {
  let state;
  try { state = reconstructPortfolio(journal, entryId); }
  catch { throw new AccessError(404, "Portfolio state unavailable."); }
  if (!state.items.every((position) => visiblePosition(position, catalog))) throw new AccessError(404, "Portfolio state unavailable.");
  return state;
}

function positionView(position: JournalPosition, amountsVisible: boolean) {
  return { kind: position.kind, referenceId: position.referenceId, ticker: position.ticker, name: position.name, short: (position.quantity ?? 0) < 0,
    ...(amountsVisible ? { quantity: position.quantity } : {}) };
}
function compositionView(composition: JournalComposition, name: string, amountsVisible: boolean): PublishedJournalComposition {
  return { name, items: composition.items.map((position) => positionView(position, amountsVisible)),
    cashPositions: composition.cashPositions.map((cash) => ({ currency: cash.currency, borrowing: cash.amount < 0, ...(amountsVisible ? { amount: cash.amount } : {}) })) };
}

export function publicPortfolioJournal(journal: PortfolioJournal, reference: string, catalog: PublicationCatalog): PublishedPortfolioJournal {
  const etf = requirePublicEtf(catalog, reference);
  if (etf.fundType !== "portfolio" || etf.portfolioId !== journal.portfolioId) throw new AccessError(404, "Portfolio unavailable.");
  const amountsVisible = etf.visibility === "public";
  const entries = journal.entries.flatMap((entry): PublishedJournalEntry[] => {
    let composition;
    try { composition = requirePublishedJournalState(journal, entry.id, catalog); } catch { return []; }
    // A removed private ETF must not leak through an otherwise visible entry's title.
    const items = entry.patch.items.filter((change) => [change.before, change.after].every((position) => !position || visiblePosition(position, catalog)));
    const safeEntry = { ...entry, patch: { items, cash: entry.patch.cash } };
    return [{ id: entry.id, capturedAt: entry.capturedAt, kind: entry.kind, title: journalEntryTitle(safeEntry),
      positionChanges: items.length, cashChanges: entry.patch.cash.length,
      composition: compositionView(composition, etf.name, amountsVisible),
      changes: items.map((change) => ({ ticker: (change.after ?? change.before)!.ticker,
        action: !change.before ? "added" : !change.after ? "removed" : "resized",
        ...(amountsVisible ? { beforeQuantity: change.before ? change.before.quantity : 0, afterQuantity: change.after ? change.after.quantity : 0 } : {}),
      })),
      cash: entry.patch.cash.map((change) => ({ currency: change.currency, ...(amountsVisible ? { beforeAmount: change.before, afterAmount: change.after } : {}) })),
      ...(amountsVisible ? { valueUsd: entry.valueUsd } : {}),
    }];
  });
  return { portfolioId: etf.id, amountsVisible, current: { name: etf.name }, entries };
}

function valuationView(valuation: CounterfactualResult["valuation"], amountsVisible: boolean): PublishedJournalValuation {
  const weight = (value: number | null) => value !== null && valuation.valueUsd !== null && valuation.valueUsd > 0 && Number.isFinite(value / valuation.valueUsd * 100) ? value / valuation.valueUsd * 100 : null;
  return { items: valuation.items.map((position) => ({ ...positionView(position, amountsVisible), weight: weight(position.valueUsd), ...(amountsVisible ? { valueUsd: position.valueUsd } : {}) })),
    cash: valuation.cash.map((cash) => ({ currency: cash.currency, borrowing: cash.amount < 0, weight: weight(cash.valueUsd), ...(amountsVisible ? { amount: cash.amount, valueUsd: cash.valueUsd } : {}) })),
    ...(amountsVisible ? { valueUsd: valuation.valueUsd } : {}), missing: valuation.missing, stale: valuation.stale, quotesAsOf: valuation.quotesAsOf };
}
const relative = (value: number | null, base: number | null | undefined) => {
  const result = value !== null && base !== null && base !== undefined && base > 0 ? (value / base - 1) * 100 : NaN;
  return Number.isFinite(result) ? result : null;
};

export function publicPortfolioCounterfactual(input: PublicCounterfactualInput, reference: string, catalog: PublicationCatalog): PublishedPortfolioCounterfactual {
  const etf = requirePublicEtf(catalog, reference);
  if (etf.fundType !== "portfolio" || etf.portfolioId !== input.journal.portfolioId) throw new AccessError(404, "Portfolio unavailable.");
  const { result, journal } = input;
  // Recheck historical source visibility after the asynchronous valuation.
  requirePublishedJournalState(journal, result.entryId, catalog);
  const entry = journal.entries.find((entry) => entry.id === result.entryId)!;
  const amountsVisible = etf.visibility === "public";
  return { entryId: result.entryId, amountsVisible, valuation: valuationView(result.valuation, amountsVisible), currentValuation: valuationView(result.currentValuation, amountsVisible),
    returns: { counterfactualPct: relative(result.valuation.valueUsd, entry.valueUsd), actualPct: relative(result.currentValuation.valueUsd, entry.valueUsd), differencePct: relative(result.valuation.valueUsd, result.currentValuation.valueUsd) } };
}
