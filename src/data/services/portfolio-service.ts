import "server-only";

import { ensureLocalDatabase } from "@/db/bootstrap";
import {
  findEtfById,
  findEtfByTicker,
  findSecuritiesByIds,
} from "@/db/repositories/catalog-repository";
import {
  anchorPortfolioQuantities,
  loadDefaultPortfolio,
  loadPortfolioById,
  replaceDefaultPortfolio,
  saveDefaultPortfolioAsEtf,
  type StoredPortfolio,
} from "@/db/repositories/portfolio-repository";
import type { EtfShareClass } from "@/domain/etf";
import { replacePortfolioEtfRecord } from "@/db/repositories/local-etf-repository";
import {
  SUPPORTED_CASH_CURRENCIES,
  type PortfolioAnalysis,
  type PortfolioAssetKind,
  type PortfolioCashPosition,
  type PortfolioInputMode,
  type PortfolioItem,
  type PortfolioRecord,
} from "@/domain/portfolio";
import { analyzePortfolio } from "@/domain/processors/analyze-portfolio";
import { securityQuoteAlias } from "@/domain/security-equivalence";
import { mapWithConcurrency } from "@/domain/async-utils";

import {
  HoldingsUnavailableError,
  getHoldingsSnapshot,
  holdingsRefreshConcurrency,
} from "./holdings-service";
import {
  getMarketPrices,
  valueCashPositions,
  valuePortfolioItems,
} from "./market-price-service";

export interface PortfolioItemDraft {
  id: string;
  kind: PortfolioAssetKind;
  referenceId: string;
  inputMode: PortfolioInputMode;
  inputAmount: number;
}

export interface PortfolioCashDraft {
  currency: string;
  amount: number;
}

const MAX_PORTFOLIO_ITEMS = 50;
const MAX_CASH_POSITIONS = SUPPORTED_CASH_CURRENCIES.length;

export class PortfolioRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioRequestError";
  }
}

export class PortfolioUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "Portfolio data is unavailable.",
    );
    this.name = "PortfolioUnavailableError";
  }
}

function validateDrafts(drafts: PortfolioItemDraft[]) {
  if (drafts.length > MAX_PORTFOLIO_ITEMS) {
    throw new PortfolioRequestError(`A portfolio can contain up to ${MAX_PORTFOLIO_ITEMS} lines.`);
  }

  const seen = new Set<string>();
  for (const draft of drafts) {
    if (!draft || typeof draft !== "object") {
      throw new PortfolioRequestError("Every portfolio line must be an object.");
    }
    if (typeof draft.id !== "string" || typeof draft.referenceId !== "string") {
      throw new PortfolioRequestError("Every portfolio line must have a valid id and asset reference.");
    }
    if (!draft.id || !/^[a-zA-Z0-9_-]{1,80}$/.test(draft.id)) {
      throw new PortfolioRequestError("Every portfolio line must have a valid id.");
    }
    if (draft.kind !== "etf" && draft.kind !== "security") {
      throw new PortfolioRequestError("Unsupported portfolio asset type.");
    }
    if (!draft.referenceId || draft.referenceId.length > 100) {
      throw new PortfolioRequestError("Every portfolio line must reference an asset.");
    }
    if (draft.inputMode !== "value" && draft.inputMode !== "shares") {
      throw new PortfolioRequestError("Every line must use value or shares as its input mode.");
    }
    if (!Number.isFinite(draft.inputAmount) || draft.inputAmount === 0) {
      throw new PortfolioRequestError("Every position amount must be non-zero.");
    }
    const key = `${draft.kind}:${draft.referenceId}`;
    if (seen.has(key)) {
      throw new PortfolioRequestError("Duplicate portfolio lines are not allowed.");
    }
    seen.add(key);
  }
}

function validateCashDrafts(drafts: PortfolioCashDraft[]): PortfolioCashPosition[] {
  if (drafts.length > MAX_CASH_POSITIONS) {
    throw new PortfolioRequestError(
      `A portfolio can contain up to ${MAX_CASH_POSITIONS} cash currencies.`,
    );
  }
  const supported = new Set<string>(SUPPORTED_CASH_CURRENCIES);
  const seen = new Set<string>();
  return drafts.map((draft) => {
    if (!draft || typeof draft !== "object") {
      throw new PortfolioRequestError("Every cash line must be an object.");
    }
    const currency = typeof draft.currency === "string"
      ? draft.currency.trim().toUpperCase()
      : "";
    if (!supported.has(currency)) {
      throw new PortfolioRequestError(`Cash currency ${currency || "—"} is not supported.`);
    }
    if (seen.has(currency)) {
      throw new PortfolioRequestError(`Cash currency ${currency} is duplicated.`);
    }
    if (!Number.isFinite(draft.amount) || draft.amount === 0) {
      throw new PortfolioRequestError("Every cash amount must be non-zero.");
    }
    seen.add(currency);
    return {
      currency: currency as PortfolioCashPosition["currency"],
      amount: draft.amount,
    };
  });
}

async function resolveDrafts(
  drafts: PortfolioItemDraft[],
  cashValueUsd: number,
): Promise<PortfolioItem[]> {
  const securityIds = drafts
    .filter((draft) => draft.kind === "security")
    .map((draft) => draft.referenceId);
  const directSecurities = findSecuritiesByIds(securityIds);

  const resolved = drafts.map((draft): PortfolioItem => {
    if (draft.kind === "etf") {
      const etf = findEtfById(draft.referenceId);
      if (
        !etf ||
        etf.fundType === "portfolio" ||
        etf.fundType === "custom"
      ) {
        throw new PortfolioRequestError("One of the selected ETFs is no longer available.");
      }
      return {
        ...draft,
        ticker: etf.ticker,
        name: etf.name,
        allocationWeight: 0,
      };
    }

    const security = directSecurities.get(draft.referenceId);
    if (!security) {
      throw new PortfolioRequestError("One of the selected ACWI securities is no longer available.");
    }
    const alias = securityQuoteAlias(security);
    return {
      ...draft,
      ticker: alias?.displayTicker ?? security.ticker,
      name: security.name,
      allocationWeight: 0,
    };
  });
  let prices;
  try {
    prices = await getMarketPrices(
      resolved.map((item) => ({
        kind: item.kind,
        referenceId: item.referenceId,
      })),
    );
  } catch (error) {
    throw new PortfolioUnavailableError(error);
  }
  const withQuantities = resolved.map((item) => {
    const price = prices.get(`${item.kind}:${item.referenceId}`);
    if (!price) throw new PortfolioUnavailableError(`Price for ${item.ticker} is unavailable.`);
    const inputAmount = Number(item.inputAmount);
    if (!Number.isFinite(inputAmount) || inputAmount === 0) {
      throw new PortfolioRequestError(`A valid amount is required for ${item.ticker}.`);
    }
    const quantity =
      item.inputMode === "shares"
        ? inputAmount
        : inputAmount / price.priceUsd;
    return {
      ...item,
      quantity,
      initialPriceUsd: price.priceUsd,
      initialValueUsd: quantity * price.priceUsd,
      priceSymbol: price.providerSymbol,
      priceCurrency: price.currency,
    };
  });
  try {
    return (await valuePortfolioItems(withQuantities, cashValueUsd)).items;
  } catch (error) {
    throw new PortfolioUnavailableError(error);
  }
}

async function buildAnalysis(
  items: PortfolioItem[],
  cashWeight: number,
): Promise<PortfolioAnalysis | null> {
  const etfItems = items.filter((item) => item.kind === "etf");
  const snapshots = await mapWithConcurrency(
    etfItems,
    holdingsRefreshConcurrency(),
    (item) => getHoldingsSnapshot(item.referenceId),
  );
  const securityIds = items
    .filter((item) => item.kind === "security")
    .map((item) => item.referenceId);
  const directSecurities = findSecuritiesByIds(securityIds);

  return analyzePortfolio({
    items,
    etfSnapshots: new Map(
      snapshots.map((snapshot) => [snapshot.etf.id, snapshot]),
    ),
    directSecurities,
    cashWeight,
  });
}

async function valueStoredPortfolio(stored: StoredPortfolio) {
  const cashPositions = await valueCashPositions(stored.cashPositions);
  const cashValueUsd = cashPositions.reduce(
    (sum, position) => sum + (position.valueUsd ?? 0),
    0,
  );
  const valued = await valuePortfolioItems(stored.items, cashValueUsd);
  const weightedCash = cashPositions.map((position) => ({
    ...position,
    weight: valued.totalMarketValueUsd > 0
      ? ((position.valueUsd ?? 0) / valued.totalMarketValueUsd) * 100
      : 0,
  }));
  return { ...valued, cashPositions: weightedCash, cashValueUsd };
}

async function recordWithAnalysis(
  stored: StoredPortfolio,
): Promise<PortfolioRecord> {
  let valued;
  try {
    valued = await valueStoredPortfolio(stored);
    if (stored.items.some((item) => !item.quantity)) {
      anchorPortfolioQuantities(stored.id, valued.items);
    }
  } catch (error) {
    return {
      ...stored,
      cashPositions: stored.cashPositions,
      analysis: null,
      priceError:
        error instanceof Error
          ? error.message
          : "Market prices are unavailable.",
    };
  }

  try {
    const explicitCashWeight = valued.cashPositions.reduce(
      (sum, position) => sum + (position.weight ?? 0),
      0,
    );
    const analysis = valued.items.length > 0 || valued.cashPositions.length > 0
      ? await buildAnalysis(valued.items, explicitCashWeight)
      : null;
    return {
      ...stored,
      items: valued.items,
      cashPositions: valued.cashPositions,
      analysis: analysis
        ? {
            ...analysis,
            totalMarketValueUsd: valued.totalMarketValueUsd,
          }
        : null,
    };
  } catch (error) {
    const analysisError =
      error instanceof HoldingsUnavailableError
        ? `${error.message} The saved portfolio is unchanged.`
        : error instanceof Error
          ? error.message
          : "The saved portfolio could not be analysed.";
    return {
      ...stored,
      items: valued.items,
      cashPositions: valued.cashPositions,
      analysis: null,
      analysisError,
    };
  }
}

export async function getPortfolio(): Promise<PortfolioRecord> {
  try {
    ensureLocalDatabase();
    return await recordWithAnalysis(loadDefaultPortfolio());
  } catch (error) {
    throw new PortfolioUnavailableError(error);
  }
}

export async function getPortfolioById(id: string): Promise<PortfolioRecord> {
  try {
    ensureLocalDatabase();
    const stored = loadPortfolioById(id);
    if (!stored) {
      throw new PortfolioRequestError("The saved portfolio no longer exists.");
    }
    return await recordWithAnalysis(stored);
  } catch (error) {
    if (error instanceof PortfolioRequestError) throw error;
    throw new PortfolioUnavailableError(error);
  }
}

export async function savePortfolio(
  drafts: PortfolioItemDraft[],
  cashDrafts: PortfolioCashDraft[] = [],
): Promise<PortfolioRecord> {
  try {
    ensureLocalDatabase();
    validateDrafts(drafts);
    const cashPositions = validateCashDrafts(cashDrafts);
    const valuedCash = await valueCashPositions(cashPositions);
    const cashValueUsd = valuedCash.reduce(
      (sum, position) => sum + (position.valueUsd ?? 0),
      0,
    );
    let items: PortfolioItem[];
    try {
      items = await resolveDrafts(drafts, cashValueUsd);
    } catch (error) {
      if (error instanceof PortfolioUnavailableError && /positive market value/i.test(error.message)) {
        throw new PortfolioRequestError(
          "Net portfolio value must remain positive after cash and short positions.",
        );
      }
      throw error;
    }
    if (items.length === 0 && cashValueUsd <= 0) {
      throw new PortfolioRequestError("Net portfolio value must be positive.");
    }
    replaceDefaultPortfolio(items, cashPositions);
    return await recordWithAnalysis(loadDefaultPortfolio());
  } catch (error) {
    if (error instanceof PortfolioRequestError) throw error;
    throw new PortfolioUnavailableError(error);
  }
}

interface SavePortfolioEtfDraft {
  ticker: string;
  name: string;
  description?: string;
}

export interface UpdatePortfolioEtfDraft extends SavePortfolioEtfDraft {
  items: PortfolioItemDraft[];
  cashPositions: PortfolioCashDraft[];
}

function validatePortfolioEtfIdentity(
  draft: SavePortfolioEtfDraft,
  existingId?: string,
) {
  const ticker = draft.ticker.trim().toUpperCase();
  const name = draft.name.trim();
  const customDescription = draft.description?.trim() ?? "";
  if (!/^[A-Z][A-Z0-9.-]{1,9}$/.test(ticker)) {
    throw new PortfolioRequestError(
      "Use a ticker of 2 to 10 letters, numbers, dots or hyphens.",
    );
  }
  if (name.length < 3 || name.length > 80) {
    throw new PortfolioRequestError(
      "The ETF name must contain between 3 and 80 characters.",
    );
  }
  if (customDescription.length > 240) {
    throw new PortfolioRequestError("The description cannot exceed 240 characters.");
  }
  const tickerOwner = findEtfByTicker(ticker);
  if (tickerOwner && tickerOwner.id !== existingId) {
    throw new PortfolioRequestError(`Ticker ${ticker} is already used.`);
  }
  return { ticker, name, customDescription };
}

function portfolioEtfDescription(
  customDescription: string,
  items: PortfolioItem[],
  cashPositions: PortfolioCashPosition[],
) {
  const components = items
    .map(
      (item) =>
        `${item.quantity && item.quantity < 0 ? "Short" : "Long"} ${Math.abs(item.quantity ?? 0).toFixed(6)} shares of ${item.ticker} ${
          item.kind === "etf" ? "ETF sleeve" : "direct stock"
        } (currently ${item.allocationWeight.toFixed(2)}%)`,
    )
    .join(", ");
  const cashComponents = cashPositions
    .map((position) => `${position.amount} ${position.currency} cash`)
    .join(", ");
  return [
    customDescription,
    `Components: ${[components, cashComponents].filter(Boolean).join(", ")}.`,
    "Component weights are recalculated from current market prices, and security-level holdings use the latest persisted ETF compositions whenever this portfolio ETF is used.",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function updatePortfolioEtf(
  etfId: string,
  draft: UpdatePortfolioEtfDraft,
): Promise<EtfShareClass> {
  try {
    ensureLocalDatabase();
    const existing = findEtfById(etfId);
    if (!existing || existing.fundType !== "portfolio" || !existing.portfolioId) {
      throw new PortfolioRequestError("This portfolio ETF no longer exists.");
    }
    const identity = validatePortfolioEtfIdentity(draft, etfId);
    validateDrafts(draft.items);
    const cashPositions = validateCashDrafts(draft.cashPositions);
    const valuedCash = await valueCashPositions(cashPositions);
    const cashValueUsd = valuedCash.reduce(
      (sum, position) => sum + (position.valueUsd ?? 0),
      0,
    );
    const items = await resolveDrafts(draft.items, cashValueUsd);
    if (items.length === 0 && cashValueUsd <= 0) {
      throw new PortfolioRequestError("Net portfolio value must be positive.");
    }
    for (const item of items) {
      if (!item.quantity || !Number.isFinite(item.quantity)) {
        throw new PortfolioRequestError(
          `A valid share quantity is required for ${item.ticker}.`,
        );
      }
    }
    const description = portfolioEtfDescription(
      identity.customDescription,
      items,
      cashPositions,
    );
    const updated = replacePortfolioEtfRecord({
      id: etfId,
      portfolioId: existing.portfolioId,
      ticker: identity.ticker,
      name: identity.name,
      description,
      editableDescription: identity.customDescription,
      items,
      cashPositions,
    });
    if (!updated) {
      throw new PortfolioRequestError("This portfolio ETF no longer exists.");
    }
    return updated;
  } catch (error) {
    if (error instanceof PortfolioRequestError) throw error;
    if (error instanceof PortfolioUnavailableError) throw error;
    throw new PortfolioUnavailableError(error);
  }
}

export async function savePortfolioAsEtf(
  draft: SavePortfolioEtfDraft,
): Promise<EtfShareClass> {
  try {
    ensureLocalDatabase();
    const { ticker, name, customDescription } =
      validatePortfolioEtfIdentity(draft);

    const stored = loadDefaultPortfolio();
    const valuedPortfolio = await valueStoredPortfolio(stored);
    const portfolio = { ...stored, ...valuedPortfolio };
    if (stored.items.some((item) => !item.quantity)) {
      anchorPortfolioQuantities(stored.id, portfolio.items);
    }
    if (portfolio.items.length === 0) {
      throw new PortfolioRequestError("Add portfolio positions before saving it as an ETF.");
    }

    for (const item of portfolio.items) {
      if (!item.quantity || !Number.isFinite(item.quantity)) {
        throw new PortfolioRequestError(`A valid share quantity is required for ${item.ticker}.`);
      }
      if (item.kind !== "etf") continue;
      const component = findEtfById(item.referenceId);
      if (
        !component ||
        component.fundType === "portfolio" ||
        component.fundType === "custom"
      ) {
        throw new PortfolioRequestError(
          "Saved portfolio ETFs cannot contain another synthetic portfolio ETF.",
        );
      }
    }

    const description = portfolioEtfDescription(
      customDescription,
      portfolio.items,
      portfolio.cashPositions,
    );

    return saveDefaultPortfolioAsEtf({
      ticker,
      name,
      description,
      editableDescription: customDescription,
    });
  } catch (error) {
    if (error instanceof PortfolioRequestError) throw error;
    throw new PortfolioUnavailableError(error);
  }
}
