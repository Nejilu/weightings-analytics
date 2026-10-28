import type { JournalPosition, PortfolioJournalEntry } from "./portfolio-journal";

export interface PublishedJournalPosition extends Omit<JournalPosition, "quantity"> {
  short: boolean;
  quantity?: number | null;
}
export interface PublishedJournalComposition {
  name: string;
  items: PublishedJournalPosition[];
  cashPositions: Array<{ currency: string; borrowing: boolean; amount?: number }>;
}
export interface PublishedJournalEntry extends Pick<PortfolioJournalEntry, "id" | "capturedAt" | "kind"> {
  title: string;
  positionChanges: number;
  cashChanges: number;
  composition: PublishedJournalComposition;
  changes: Array<{ ticker: string; action: "added" | "removed" | "resized"; beforeQuantity?: number | null; afterQuantity?: number | null }>;
  cash: Array<{ currency: string; beforeAmount?: number | null; afterAmount?: number | null }>;
  valueUsd?: number | null;
}
export interface PublishedPortfolioJournal {
  portfolioId: string;
  amountsVisible: boolean;
  current: { name: string };
  entries: PublishedJournalEntry[];
}
export interface PublishedJournalValuation {
  items: Array<PublishedJournalPosition & { weight: number | null; valueUsd?: number | null }>;
  cash: Array<{ currency: string; borrowing: boolean; weight: number | null; amount?: number; valueUsd?: number | null }>;
  valueUsd?: number | null;
  missing: string[];
  stale: boolean;
  quotesAsOf: string;
}
export interface PublishedPortfolioCounterfactual {
  entryId: number;
  amountsVisible: boolean;
  valuation: PublishedJournalValuation;
  currentValuation: PublishedJournalValuation;
  returns: { counterfactualPct: number | null; actualPct: number | null; differencePct: number | null };
}
