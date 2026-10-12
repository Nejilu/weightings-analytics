import type { HoldingsSourceIssue } from "./holdings-source-issues";
import type { DataStatus, EtfShareClass, Holding } from "./etf";

export type DistortionMode = "top-holdings" | "all-holdings" | "market-coverage";
export type DistortionWeightingBasis = "free-float" | "total-cap";
export const DEFAULT_DISTORTION_TOP_COUNT = 30;
export type DistortionReferencePosition = Pick<Holding,
  "securityId" | "ticker" | "name" | "sector" | "assetClass" | "country" | "weight"
>;

export type DistortionCoverageStatus =
  | "complete"
  | "partial"
  | "insufficient";

export type DistortionPositionStatus =
  | "covered"
  | "not-in-acwi"
  | "not-held"
  | "missing-capitalization"
  | "non-equity";

export interface HoldingsAnalysisPosition {
  adrPremiumPairId?: import("./adr-premium").AdrPairId;
  securityId: string;
  quoteSecurityId?: string;
  quoteTicker?: string;
  ticker: string;
  name: string;
  sector: string;
  assetClass: string;
  country: string;
  isCash: boolean;
  publishedWeight: number;
  normalizedWeightExCash: number | null;
  actualWeight: number | null;
  counterfactualWeight: number | null;
  weightDelta: number | null;
  distortionContribution: number | null;
  distortionStatus: DistortionPositionStatus;
}

export interface HoldingsSectorAllocation {
  sector: string;
  weight: number;
}

export interface HoldingsDistortionAnalysis {
  mode: DistortionMode;
  topCount: number | null;
  selectedWeight: number;
  referenceHoldings: number;
  score: number | null;
  coverageWeight: number;
  coverageStatus: DistortionCoverageStatus;
  coveredHoldings: number;
  eligibleHoldings: number;
  missingHoldings: number;
  referenceEtfId: string;
  referenceTicker: string;
  referenceAsOf: string;
  methodology: "acwi-free-float-proxy" | "tradingview-total-cap";
  capitalizationCoverage?: {
    referenceWeightCoverage: number;
    missingReferenceHoldings: number;
    excludedHoldings: number;
    scoreAvailable: boolean;
  };
}

export interface HoldingsAnalysisResult {
  portfolioValuation?: import("./portfolio-valuation").PortfolioHoldingsValuation;
  etf: EtfShareClass;
  asOf: string;
  sourceStatus: DataStatus;
  sourceIssues?: HoldingsSourceIssue[];
  cacheTtlHours: number;
  calculatedAt: string;
  holdingsCount: number;
  equityHoldingsCount: number;
  cashHoldingsCount: number;
  cashWeight: number;
  top10Concentration: number;
  topPosition: {
    ticker: string;
    name: string;
    weight: number;
  } | null;
  sectors: HoldingsSectorAllocation[];
  distortion: HoldingsDistortionAnalysis;
  allHoldingsDistortion: HoldingsDistortionAnalysis;
  marketCoverage: HoldingsDistortionAnalysis;
  distortionReferencePositions: DistortionReferencePosition[];
  positions: HoldingsAnalysisPosition[];
}
