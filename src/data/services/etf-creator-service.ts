import "server-only";

import { ensureLocalDatabase } from "@/db/bootstrap";
import {
  findEtfById,
  findEtfByTicker,
} from "@/db/repositories/catalog-repository";
import { saveCreatedEtf } from "@/db/repositories/etf-creator-repository";
import type { EtfCreatorCriteria } from "@/domain/etf-creator";
import {
  dynamicCreatorDescription,
  normalizeCreatorHoldings,
} from "@/domain/etf-creator";
import type { EtfShareClass } from "@/domain/etf";

import { getHoldingsSnapshot } from "./holdings-service";

interface CreateEtfDraft {
  ticker: string;
  name: string;
  description?: string;
  sourceEtfId: string;
  selectedSecurityIds: string[];
  criteria: EtfCreatorCriteria;
}

const MAX_SELECTED_SECURITIES = 5_000;

export class EtfCreatorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtfCreatorRequestError";
  }
}

export class EtfCreatorUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "The selected ETF source data is unavailable.",
    );
    this.name = "EtfCreatorUnavailableError";
  }
}

export function validatedCreatorCriteria(criteria: EtfCreatorCriteria): EtfCreatorCriteria {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    throw new EtfCreatorRequestError("Invalid selection criteria.");
  }
  const countryMode = criteria?.countryMode;
  const sectorMode = criteria?.sectorMode;
  const overlapMode = criteria?.overlapMode;
  if (countryMode !== "include" && countryMode !== "exclude") {
    throw new EtfCreatorRequestError("Invalid geography filter mode.");
  }
  if (sectorMode !== "include" && sectorMode !== "exclude") {
    throw new EtfCreatorRequestError("Invalid sector filter mode.");
  }
  if (
    overlapMode !== "none" &&
    overlapMode !== "include" &&
    overlapMode !== "exclude"
  ) {
    throw new EtfCreatorRequestError("Invalid overlap filter mode.");
  }
  if (!Array.isArray(criteria.countries) || !Array.isArray(criteria.sectors)) {
    throw new EtfCreatorRequestError("Invalid selection criteria.");
  }
  if (
    criteria.countries.some((value) => typeof value !== "string") ||
    criteria.sectors.some((value) => typeof value !== "string")
  ) {
    throw new EtfCreatorRequestError("Invalid selection criteria.");
  }

  const cleanValues = (values: string[]) =>
    [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 300);

  return {
    countryMode,
    countries: cleanValues(criteria.countries),
    sectorMode,
    sectors: cleanValues(criteria.sectors),
    overlapMode,
    overlapEtfId:
      overlapMode === "none" ? undefined : criteria.overlapEtfId?.trim(),
  };
}

export async function createEtfFromSource(
  draft: CreateEtfDraft,
): Promise<EtfShareClass> {
  try {
    ensureLocalDatabase();
    if (!draft || typeof draft !== "object") {
      throw new EtfCreatorRequestError("ETF creator data is required.");
    }
    if (
      typeof draft.ticker !== "string" ||
      typeof draft.name !== "string" ||
      typeof draft.sourceEtfId !== "string" ||
      (draft.description !== undefined && typeof draft.description !== "string") ||
      !Array.isArray(draft.selectedSecurityIds) ||
      draft.selectedSecurityIds.some((id) => typeof id !== "string")
    ) {
      throw new EtfCreatorRequestError("Ticker, base ETF, name and holdings must be valid.");
    }
    const ticker = draft.ticker.trim().toUpperCase();
    const name = draft.name.trim();
    const sourceEtfId = draft.sourceEtfId.trim();
    const customDescription = draft.description?.trim();

    if (!/^[A-Z][A-Z0-9.-]{1,9}$/.test(ticker)) {
      throw new EtfCreatorRequestError("Use a ticker of 2 to 10 letters, numbers, dots or hyphens.");
    }
    if (name.length < 3 || name.length > 80) {
      throw new EtfCreatorRequestError("The ETF name must contain between 3 and 80 characters.");
    }
    if (customDescription && customDescription.length > 240) {
      throw new EtfCreatorRequestError("The description cannot exceed 240 characters.");
    }
    if (!sourceEtfId) {
      throw new EtfCreatorRequestError("Select a base ETF before saving.");
    }
    if (findEtfByTicker(ticker)) {
      throw new EtfCreatorRequestError(`Ticker ${ticker} is already used.`);
    }

    const sourceEtf = findEtfById(sourceEtfId);
    if (!sourceEtf) {
      throw new EtfCreatorRequestError("The selected base ETF is no longer available.");
    }

    const selectedSecurityIds = [
      ...new Set(draft.selectedSecurityIds.map((id) => id.trim()).filter(Boolean)),
    ];
    if (selectedSecurityIds.length === 0) {
      throw new EtfCreatorRequestError("Keep at least one source ETF security before saving the ETF.");
    }
    if (selectedSecurityIds.length > MAX_SELECTED_SECURITIES) {
      throw new EtfCreatorRequestError(`An ETF can contain up to ${MAX_SELECTED_SECURITIES} securities.`);
    }

    const criteria = validatedCreatorCriteria(draft.criteria);
    const source = await getHoldingsSnapshot(sourceEtf.id);
    const sourceEquities = source.holdings.filter(
      (holding) => holding.assetClass === "Equity",
    );
    const selectedSet = new Set(selectedSecurityIds);
    const selected = sourceEquities.filter((holding) =>
      selectedSet.has(holding.securityId),
    );
    if (selected.length !== selectedSecurityIds.length) {
      throw new EtfCreatorRequestError(
        "The source ETF universe changed while the selection was open. Review the selection and try again.",
      );
    }

    const normalized = normalizeCreatorHoldings(selected);
    if (normalized.length === 0) {
      throw new EtfCreatorRequestError("The retained source securities have no usable free-float weight.");
    }
    const description = dynamicCreatorDescription(
      customDescription ?? "",
      normalized.length,
      source.etf.ticker,
    );

    return saveCreatedEtf({
      ticker,
      name,
      description,
      source,
      selectedHoldings: normalized,
      criteria,
      editableDescription: customDescription ?? "",
    });
  } catch (error) {
    if (error instanceof EtfCreatorRequestError) throw error;
    if (error instanceof EtfCreatorUnavailableError) throw error;
    throw new EtfCreatorUnavailableError(error);
  }
}

export const createEtfFromAcwi = createEtfFromSource;
