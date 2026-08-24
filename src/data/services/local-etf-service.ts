import "server-only";

import { ensureLocalDatabase } from "@/db/bootstrap";
import {
  findEtfById,
  findEtfByTicker,
} from "@/db/repositories/catalog-repository";
import {
  deleteLocalEtfRecord,
  findDynamicCustomEtfDefinition,
  findLocalEtfDefinitionRecord,
  replaceCustomEtfRecord,
} from "@/db/repositories/local-etf-repository";
import type { EtfShareClass } from "@/domain/etf";
import type { EtfCreatorCriteria } from "@/domain/etf-creator";
import {
  dynamicCreatorDescription,
  normalizeCreatorHoldings,
} from "@/domain/etf-creator";
import type { LocalEtfDetail } from "@/domain/local-etf";

import {
  getPortfolioById,
  PortfolioRequestError,
  PortfolioUnavailableError,
  type PortfolioRefreshOptions,
  type PortfolioCashDraft,
  type PortfolioItemDraft,
  updatePortfolioEtf,
} from "./portfolio-service";
import { getHoldingsSnapshot } from "./holdings-service";
import { validatedCreatorCriteria } from "./etf-creator-service";

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

interface UpdateCustomLocalEtfDraft extends UpdateLocalEtfDraft {
  kind: "custom";
  sourceEtfId: string;
  selectedSecurityIds: string[];
  criteria: EtfCreatorCriteria;
}

interface UpdatePortfolioLocalEtfDraft extends UpdateLocalEtfDraft {
  kind: "portfolio";
  items: PortfolioItemDraft[];
  cashPositions: PortfolioCashDraft[];
}

function requireEditableLocalEtf(id: string): EtfShareClass {
  const etf = findEtfById(id);
  if (!etf || (etf.fundType !== "custom" && etf.fundType !== "portfolio")) {
    throw new LocalEtfNotFoundError();
  }
  return etf;
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function legacyEditableDescription(
  fundType: "custom" | "portfolio",
  description: string | undefined,
) {
  const value = description?.trim() ?? "";
  if (!value) return "";
  const marker = fundType === "portfolio" ? " Components:" : / \d+ \S+ constituents,/;
  if (typeof marker === "string") {
    const index = value.indexOf(marker);
    return index > 0 ? value.slice(0, index).trim() : "";
  }
  const match = marker.exec(value);
  return match?.index && match.index > 0 ? value.slice(0, match.index).trim() : "";
}

export async function getLocalEtfDetail(
  id: string,
  options: PortfolioRefreshOptions = {},
): Promise<LocalEtfDetail> {
  ensureLocalDatabase();
  const etf = requireEditableLocalEtf(id);
  const record = findLocalEtfDefinitionRecord(id);
  if (!record) throw new LocalEtfNotFoundError();
  const metadata = metadataObject(record.metadataJson);
  const editableDescription =
    typeof metadata.editableDescription === "string"
      ? metadata.editableDescription
      : legacyEditableDescription(etf.fundType as "custom" | "portfolio", etf.description);

  if (etf.fundType === "portfolio") {
    if (!etf.portfolioId) throw new LocalEtfNotFoundError();
    return {
      kind: "portfolio",
      etf,
      portfolio: await getPortfolioById(etf.portfolioId, options),
      editableDescription,
    };
  }

  const definition = findDynamicCustomEtfDefinition(id);
  const criteriaCandidate = definition?.criteria;
  if (!definition || !criteriaCandidate) {
    throw new LocalEtfRequestError(
      "This custom ETF predates editable definitions and cannot be reloaded safely.",
    );
  }
  const criteria = validatedCreatorCriteria(criteriaCandidate);
  const snapshot = await getHoldingsSnapshot(etf.id);
  return {
    kind: "custom",
    etf,
    sourceEtfId: definition.sourceEtfId,
    criteria,
    selectedSecurityIds: definition.selectedSecurities.map(
      (security) => security.securityId,
    ),
    holdings: snapshot.holdings,
    editableDescription,
  };
}

function validateIdentity(
  existing: EtfShareClass,
  draft: UpdateLocalEtfDraft,
) {
  const ticker = draft.ticker.trim().toUpperCase();
  const name = draft.name.trim();
  const editableDescription = draft.description.trim();
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
  if (editableDescription.length > 240) {
    throw new LocalEtfRequestError(
      "The description cannot exceed 240 characters.",
    );
  }
  const tickerOwner = findEtfByTicker(ticker);
  if (tickerOwner && tickerOwner.id !== existing.id) {
    throw new LocalEtfRequestError(`Ticker ${ticker} is already used.`);
  }
  return { ticker, name, editableDescription };
}

export async function updateCustomLocalEtf(
  id: string,
  draft: UpdateCustomLocalEtfDraft,
): Promise<EtfShareClass> {
  ensureLocalDatabase();
  const existing = requireEditableLocalEtf(id);
  if (existing.fundType !== "custom") throw new LocalEtfNotFoundError();
  const identity = validateIdentity(existing, draft);
  const sourceEtf = findEtfById(draft.sourceEtfId.trim());
  if (!sourceEtf || sourceEtf.id === existing.id) {
    throw new LocalEtfRequestError("Select a valid base ETF before saving.");
  }
  const criteria = validatedCreatorCriteria(draft.criteria);
  const selectedSecurityIds = [
    ...new Set(draft.selectedSecurityIds.map((value) => value.trim()).filter(Boolean)),
  ];
  if (selectedSecurityIds.length === 0) {
    throw new LocalEtfRequestError("Keep at least one source ETF security.");
  }

  const previousDefinition = findDynamicCustomEtfDefinition(id);
  const previousById = new Map(
    previousDefinition?.sourceEtfId === sourceEtf.id
      ? previousDefinition.selectedSecurities.map((security) => [
          security.securityId,
          security,
        ])
      : [],
  );
  const source = await getHoldingsSnapshot(sourceEtf.id);
  const sourceEquities = source.holdings.filter(
    (holding) => holding.assetClass === "Equity",
  );
  const sourceById = new Map(
    sourceEquities.map((holding) => [holding.securityId, holding]),
  );
  const unknownIds = selectedSecurityIds.filter(
    (securityId) => !sourceById.has(securityId) && !previousById.has(securityId),
  );
  if (unknownIds.length > 0) {
    throw new LocalEtfRequestError(
      "Some selected securities do not belong to the current base ETF definition.",
    );
  }
  const selectedSecurities = selectedSecurityIds.map((securityId) => ({
    securityId,
    ticker:
      sourceById.get(securityId)?.ticker ??
      previousById.get(securityId)?.ticker ??
      "—",
  }));
  const selectedHoldings = normalizeCreatorHoldings(
    selectedSecurityIds.flatMap((securityId) => {
      const holding = sourceById.get(securityId);
      return holding ? [holding] : [];
    }),
  );
  if (selectedHoldings.length === 0) {
    throw new LocalEtfRequestError(
      "The retained securities have no usable free-float weight.",
    );
  }
  const description = dynamicCreatorDescription(
    identity.editableDescription,
    selectedSecurities.length,
    sourceEtf.ticker,
  );
  const updated = replaceCustomEtfRecord({
    id,
    ticker: identity.ticker,
    name: identity.name,
    description,
    editableDescription: identity.editableDescription,
    sourceEtfId: sourceEtf.id,
    sourceTicker: sourceEtf.ticker,
    sourceAsOf: source.asOf,
    sourceFetchedAt: source.fetchedAt,
    sourceUrl: source.sourceUrl,
    criteria,
    selectedSecurities,
    selectedHoldings,
  });
  if (!updated) throw new LocalEtfNotFoundError();
  return updated;
}

export async function updatePortfolioLocalEtf(
  id: string,
  draft: UpdatePortfolioLocalEtfDraft,
  options: PortfolioRefreshOptions = {},
): Promise<EtfShareClass> {
  try {
    const existing = requireEditableLocalEtf(id);
    if (existing.fundType !== "portfolio") throw new LocalEtfNotFoundError();
    return await updatePortfolioEtf(id, draft, options);
  } catch (error) {
    if (error instanceof LocalEtfNotFoundError) throw error;
    if (error instanceof PortfolioRequestError) {
      throw new LocalEtfRequestError(error.message);
    }
    if (error instanceof PortfolioUnavailableError) {
      throw new LocalEtfRequestError(error.message);
    }
    throw error;
  }
}

export function deleteLocalEtf(id: string): void {
  ensureLocalDatabase();
  requireEditableLocalEtf(id);
  if (!deleteLocalEtfRecord(id)) throw new LocalEtfNotFoundError();
}
