import type { PortfolioCashPosition, PortfolioItem } from "./portfolio";

export interface JournalPosition {
  kind: "security" | "etf";
  referenceId: string;
  ticker: string;
  name: string;
  quantity: number | null;
}
export interface JournalComposition {
  name: string;
  items: JournalPosition[];
  cashPositions: Array<{ currency: PortfolioCashPosition["currency"]; amount: number }>;
}
export interface JournalPatch {
  name?: { before: string; after: string };
  items: Array<{ key: string; before: JournalPosition | null; after: JournalPosition | null }>;
  cash: Array<{ currency: PortfolioCashPosition["currency"]; before: number | null; after: number | null }>;
}
export interface PortfolioJournalEntry {
  id: number;
  capturedAt: string;
  kind: "baseline" | "created" | "edited" | "resolved";
  patch: JournalPatch;
  valueUsd: number | null;
}
export interface PortfolioJournal {
  portfolioId: string;
  current: JournalComposition;
  entries: PortfolioJournalEntry[];
}
export interface JournalQuote { priceUsd: number; asOf: string; stale: boolean }
export interface CounterfactualMarket {
  prices: Record<string, JournalQuote>;
  fx: Record<string, { rateToUsd: number; asOf: string; stale: boolean }>;
  fetchedAt: string;
}
export const journalPositionKey = (p: Pick<JournalPosition, "kind" | "referenceId">) => `${p.kind}:${p.referenceId}`;
export const emptyJournalComposition = (): JournalComposition => ({ name: "", items: [], cashPositions: [] });

export function journalComposition(source: { name: string; items: PortfolioItem[]; cashPositions: PortfolioCashPosition[] }): JournalComposition {
  return { name: source.name, items: source.items.map((p) => ({ kind: p.kind, referenceId: p.referenceId, ticker: p.ticker, name: p.name,
    quantity: Number.isFinite(p.quantity) ? p.quantity! : p.inputMode === "shares" && Number.isFinite(p.inputAmount) ? p.inputAmount! :
      p.inputMode === "value" && Number.isFinite(p.inputAmount) && (p.initialPriceUsd ?? 0) > 0 ? p.inputAmount! / p.initialPriceUsd! : null,
  })), cashPositions: source.cashPositions.map((p) => ({ currency: p.currency, amount: p.amount })) };
}

export function compositionPatch(before: JournalComposition, after: JournalComposition): JournalPatch {
  const old = new Map(before.items.map((p) => [journalPositionKey(p), p]));
  const next = new Map(after.items.map((p) => [journalPositionKey(p), p]));
  const cashBefore = new Map(before.cashPositions.map((p) => [p.currency, p.amount]));
  const cashAfter = new Map(after.cashPositions.map((p) => [p.currency, p.amount]));
  return {
    ...(before.name === after.name ? {} : { name: { before: before.name, after: after.name } }),
    items: [...new Set([...old.keys(), ...next.keys()])].flatMap((key) => {
      const a = old.get(key) ?? null, b = next.get(key) ?? null;
      return a?.quantity === b?.quantity && Boolean(a) === Boolean(b) ? [] : [{ key, before: a, after: b }];
    }),
    cash: [...new Set([...cashBefore.keys(), ...cashAfter.keys()])].flatMap((currency) => {
      const a = cashBefore.get(currency) ?? null, b = cashAfter.get(currency) ?? null;
      return a === b ? [] : [{ currency, before: a, after: b }];
    }),
  };
}
export const patchIsEmpty = (patch: JournalPatch) => !patch.name && !patch.items.length && !patch.cash.length;

export function applyJournalPatch(state: JournalComposition, patch: JournalPatch, reverse = false): JournalComposition {
  const items = new Map(state.items.map((p) => [journalPositionKey(p), p]));
  const cash = new Map(state.cashPositions.map((p) => [p.currency, p.amount]));
  for (const change of patch.items) {
    const value = reverse ? change.before : change.after;
    if (value) items.set(change.key, value); else items.delete(change.key);
  }
  for (const change of patch.cash) {
    const value = reverse ? change.before : change.after;
    if (value === null) cash.delete(change.currency); else cash.set(change.currency, value);
  }
  return { name: patch.name ? reverse ? patch.name.before : patch.name.after : state.name,
    items: [...items.values()], cashPositions: [...cash].map(([currency, amount]) => ({ currency, amount })) };
}

function economicKey(state: JournalComposition) {
  return JSON.stringify({ name: state.name, items: state.items.map((p) => [journalPositionKey(p), p.quantity]).sort(),
    cash: state.cashPositions.map((p) => [p.currency, p.amount]).sort() });
}

export function reconstructPortfolio(journal: PortfolioJournal, entryId: number): JournalComposition {
  const index = journal.entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) throw new Error("This journal entry is unavailable. Reload the journal.");
  // Validate the entire chain against the live book before reversing any edits.
  // External SQL edits or an incomplete journal must not produce a false past.
  const replayed = journal.entries.reduce((state, entry) => {
    const positions = new Map(state.items.map((p) => [journalPositionKey(p), p]));
    const cash = new Map(state.cashPositions.map((p) => [p.currency, p.amount]));
    const broken = entry.patch.items.some((change) => {
      const prior = positions.get(change.key) ?? null;
      return Boolean(prior) !== Boolean(change.before) || prior?.quantity !== change.before?.quantity;
    }) || entry.patch.cash.some((change) => (cash.get(change.currency) ?? null) !== change.before)
      || (entry.patch.name && entry.patch.name.before !== state.name);
    if (broken) throw new Error("The change journal is incomplete. This past composition cannot be reconstructed reliably.");
    return applyJournalPatch(state, entry.patch);
  }, emptyJournalComposition());
  if (economicKey(replayed) !== economicKey(journal.current)) throw new Error("The portfolio changed outside this journal. Its past cannot be reconstructed reliably.");
  return journal.entries.slice(index + 1).reverse().reduce((state, entry) => applyJournalPatch(state, entry.patch, true), journal.current);
}

export function valueCounterfactual(composition: JournalComposition, market: CounterfactualMarket) {
  const missing: string[] = [];
  const dates: string[] = [];
  let stale = false;
  const items = composition.items.map((p) => {
    const quote = market.prices[journalPositionKey(p)];
    const valueUsd = p.quantity !== null && quote && quote.priceUsd > 0 && Number.isFinite(quote.priceUsd) ? p.quantity * quote.priceUsd : null;
    if (valueUsd === null || !Number.isFinite(valueUsd)) missing.push(p.ticker);
    if (quote) { dates.push(quote.asOf); stale ||= quote.stale; }
    return { ...p, valueUsd: valueUsd !== null && Number.isFinite(valueUsd) ? valueUsd : null };
  });
  const cash = composition.cashPositions.map((p) => {
    const rate = p.currency === "USD" ? 1 : market.fx[p.currency]?.rateToUsd;
    const quote = market.fx[p.currency];
    const valueUsd = rate !== undefined && Number.isFinite(rate) && rate > 0 ? p.amount * rate : null;
    if (valueUsd === null || !Number.isFinite(valueUsd)) missing.push(`${p.currency} cash`);
    if (quote) { dates.push(quote.asOf); stale ||= quote.stale; }
    return { ...p, valueUsd: valueUsd !== null && Number.isFinite(valueUsd) ? valueUsd : null };
  });
  const valueUsd = missing.length ? null : [...items, ...cash].reduce((sum, p) => sum + p.valueUsd!, 0);
  return { items, cash, valueUsd: valueUsd !== null && Number.isFinite(valueUsd) ? valueUsd : null, missing, stale,
    quotesAsOf: dates.sort()[0] ?? market.fetchedAt };
}

export function journalEntryTitle(entry: PortfolioJournalEntry) {
  if (entry.kind === "baseline") return "Tracking started";
  if (entry.kind === "created") return "Portfolio created";
  if (entry.kind === "resolved") return "Share quantities resolved";
  const { items, cash } = entry.patch;
  const added = items.filter((p) => !p.before).map((p) => p.after!.ticker);
  const removed = items.filter((p) => !p.after).map((p) => p.before!.ticker);
  const resized = items.filter((p) => p.before && p.after).map((p) => p.after!.ticker);
  return [added.length ? `Added ${added.join(", ")}` : "", removed.length ? `Removed ${removed.join(", ")}` : "",
    resized.length ? `Resized ${resized.join(", ")}` : "", cash.length ? `Cash updated (${cash.map((p) => p.currency).join(", ")})` : ""].filter(Boolean).join(" · ") || "Portfolio renamed";
}
