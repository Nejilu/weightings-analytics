import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../client";
import { portfolioJournalEntries } from "../schema";
import { compositionPatch, emptyJournalComposition, patchIsEmpty, type JournalComposition, type PortfolioJournalEntry } from "@/domain/portfolio-journal";

export function loadPortfolioJournalEntries(portfolioId: string): PortfolioJournalEntry[] {
  return getDb().select().from(portfolioJournalEntries).where(eq(portfolioJournalEntries.portfolioId, portfolioId)).orderBy(asc(portfolioJournalEntries.id)).all();
}

// The service wraps both operations in the same transaction as reconstruction.
export function deletePortfolioJournalEntry(portfolioId: string, entryId: number, successor: PortfolioJournalEntry) {
  const db = getDb();
  db.update(portfolioJournalEntries).set({ patch: successor.patch, kind: successor.kind })
    .where(and(eq(portfolioJournalEntries.portfolioId, portfolioId), eq(portfolioJournalEntries.id, successor.id))).run();
  db.delete(portfolioJournalEntries)
    .where(and(eq(portfolioJournalEntries.portfolioId, portfolioId), eq(portfolioJournalEntries.id, entryId))).run();
}

// Called inside the SAME SQLite transaction as the edit. Only changed lines
// are retained; one initial checkpoint is needed to delimit reliable history.
export function recordPortfolioChange(portfolioId: string, before: JournalComposition | undefined, after: JournalComposition,
  options: { kind?: PortfolioJournalEntry["kind"]; capturedAt?: string; valueUsd?: number | null } = {}) {
  const db = getDb();
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const known = db.select({ id: portfolioJournalEntries.id }).from(portfolioJournalEntries).where(eq(portfolioJournalEntries.portfolioId, portfolioId)).limit(1).get();
  if (!known) db.insert(portfolioJournalEntries).values({ portfolioId, capturedAt, kind: before ? "baseline" : options.kind ?? "created",
    patch: compositionPatch(emptyJournalComposition(), before ?? after), valueUsd: before ? null : options.valueUsd ?? null }).run();
  if (before) {
    const patch = compositionPatch(before, after);
    if (!patchIsEmpty(patch)) db.insert(portfolioJournalEntries).values({ portfolioId, capturedAt, kind: options.kind ?? "edited", patch, valueUsd: options.valueUsd ?? null }).run();
  }
}

export function knownJournalValue(items: Array<{ currentValueUsd?: number }>, cash: Array<{ currency: string; amount: number; valueUsd?: number }>): number | null {
  const values = [...items.map((p) => p.currentValueUsd), ...cash.map((p) => p.valueUsd ?? (p.currency === "USD" ? p.amount : undefined))];
  return values.every((value) => value !== undefined && Number.isFinite(value)) ? values.reduce<number>((sum, value) => sum + value!, 0) : null;
}
