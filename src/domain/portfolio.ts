import type { HoldingsSnapshot } from "./etf";

export type PortfolioAssetKind = "etf" | "security";
export type PortfolioInputMode = "value" | "shares";
export type PriceStatus = "live" | "cached" | "stale";
export type PortfolioExposureMode = "gross-normalized" | "net-total";

export const SUPPORTED_CASH_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CHF",
  "JPY",
  "CAD",
  "AUD",
  "NZD",
  "SEK",
  "NOK",
  "DKK",
  "HKD",
  "SGD",
  "CNY",
] as const;

export type PortfolioCashCurrency = (typeof SUPPORTED_CASH_CURRENCIES)[number];

export class MarketPriceRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketPriceRequestError";
  }
}

export class MarketPriceUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "The market price is unavailable.",
    );
    this.name = "MarketPriceUnavailableError";
  }
}

export interface PortfolioItem {
  id: string;
  kind: PortfolioAssetKind;
  referenceId: string;
  ticker: string;
  name: string;
  allocationWeight: number;
  quantity?: number;
  inputMode?: PortfolioInputMode;
  inputAmount?: number;
  initialPriceUsd?: number;
  initialValueUsd?: number;
  priceSymbol?: string;
  priceCurrency?: string;
  currentPrice?: number;
  currentPriceUsd?: number;
  currentValueUsd?: number;
  priceAsOf?: string;
  priceStatus?: PriceStatus;
}

export interface PortfolioSecurity {
  securityId: string;
  ticker: string;
  name: string;
  sector: string;
  assetClass: string;
  country: string;
  isin?: string;
}

export interface MarketPrice {
  assetKind: PortfolioAssetKind;
  assetId: string;
  providerSymbol: string;
  price: number;
  currency: string;
  fxToUsd: number;
  priceUsd: number;
  asOf: string;
  fetchedAt: string;
  sourceStatus: PriceStatus;
}

export interface FxRate {
  currency: string;
  providerSymbol: string;
  rateToUsd: number;
  asOf: string;
  fetchedAt: string;
  sourceStatus: PriceStatus;
}

export interface PortfolioCashPosition {
  currency: PortfolioCashCurrency;
  amount: number;
  fxToUsd?: number;
  valueUsd?: number;
  weight?: number;
  fxAsOf?: string;
  fxStatus?: PriceStatus;
}

export interface PortfolioContribution {
  itemId: string;
  ticker: string;
  kind: PortfolioAssetKind;
  weight: number;
}

export interface PortfolioLookThroughPosition extends PortfolioSecurity {
  weight: number;
  contributions: PortfolioContribution[];
}

export interface PortfolioSectorExposure {
  sector: string;
  weight: number;
}

export interface PortfolioSource {
  referenceId: string;
  ticker: string;
  asOf: string;
  sourceStatus: HoldingsSnapshot["sourceStatus"];
  constituentCoverage?: HoldingsSnapshot["constituentCoverage"];
}

export interface PortfolioAnalysis {
  calculatedAt: string;
  allocationWeight: number;
  cashWeight: number;
  explicitCashWeight: number;
  financingWeight: number;
  netExposureWeight: number;
  grossExposureWeight: number;
  positionsCount: number;
  directPositionsCount: number;
  etfSleevesCount: number;
  top10Concentration: number;
  totalMarketValueUsd?: number;
  positions: PortfolioLookThroughPosition[];
  sectors: PortfolioSectorExposure[];
  sources: PortfolioSource[];
}

export interface PortfolioRecord {
  id: string;
  name: string;
  baseCurrency: string;
  updatedAt: string;
  items: PortfolioItem[];
  cashPositions: PortfolioCashPosition[];
  analysis: PortfolioAnalysis | null;
  analysisError?: string;
  priceError?: string;
}

export interface PortfolioAnalysisInput {
  items: PortfolioItem[];
  etfSnapshots: Map<string, HoldingsSnapshot>;
  directSecurities: Map<string, PortfolioSecurity>;
  cashWeight?: number;
  calculatedAt?: string;
}
