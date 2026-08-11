import "server-only";

import { ensureLocalDatabase } from "@/db/bootstrap";
import {
  findEtfById,
  findEtfByTicker,
} from "@/db/repositories/catalog-repository";
import {
  deleteLocalEtfRecord,
  updateLocalEtfRecord,
} from "@/db/repositories/local-etf-repository";
import type { EtfShareClass } from "@/domain/etf";

export class LocalEtfRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalEtfRequestError";
  }
}

export class LocalEtfNotFoundError extends Error {
  constructor() {
    super("This local ETF no longer exists.");
    this.name = "LocalEtfNotFoundError";
  }
}

interface UpdateLocalEtfDraft {
  ticker: string;
  name: string;
  description: string;
}

function requireEditableLocalEtf(id: string): EtfShareClass {
  const etf = findEtfById(id);
  if (!etf || (etf.fundType !== "custom" && etf.fundType !== "portfolio")) {
    throw new LocalEtfNotFoundError();
  }
  return etf;
}

export function updateLocalEtf(
  id: string,
  draft: UpdateLocalEtfDraft,
): EtfShareClass {
  ensureLocalDatabase();
  const existing = requireEditableLocalEtf(id);
  const ticker = draft.ticker.trim().toUpperCase();
  const name = draft.name.trim();
  const description = draft.description.trim();

  if (!/^[A-Z][A-Z0-9.-]{1,9}$/.test(ticker)) {
    throw new LocalEtfRequestError(
      "Use a ticker of 2 to 10 letters, numbers, dots or hyphens.",
    );
  }
  if (name.length < 3 || name.length > 80) {
    throw new LocalEtfRequestError(
      "The ETF name must contain between 3 and 80 characters.",
    );
  }
  if (description.length > 1_000) {
    throw new LocalEtfRequestError(
      "The description cannot exceed 1,000 characters.",
    );
  }

  const tickerOwner = findEtfByTicker(ticker);
  if (tickerOwner && tickerOwner.id !== existing.id) {
    throw new LocalEtfRequestError(`Ticker ${ticker} is already used.`);
  }

  const updated = updateLocalEtfRecord({
    id: existing.id,
    ticker,
    name,
    description,
  });
  if (!updated) throw new LocalEtfNotFoundError();
  return updated;
}

export function deleteLocalEtf(id: string): void {
  ensureLocalDatabase();
  requireEditableLocalEtf(id);
  if (!deleteLocalEtfRecord(id)) throw new LocalEtfNotFoundError();
}
