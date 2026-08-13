import type { DataStatus, EtfShareClass } from "./etf";

export type DistortionCoverageStatus =
  | "complete"
  | "partial"
  | "insufficient";

export type DistortionPositionStatus =
  | "covered"
  | "not-in-acwi"
  | "non-equity";

export interface HoldingsAnalysisPosition {
  securityId: string;
  ticker: string;
  name: string;
  sector: string;
  assetClass: string;
  country: string;
  publishedWeight: number;
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
  score: number | null;
  coverageWeight: number;
  coverageStatus: DistortionCoverageStatus;
  coveredHoldings: number;
  eligibleHoldings: number;
  missingHoldings: number;
  referenceEtfId: string;
  referenceTicker: string;
  referenceAsOf: string;
  methodology: "acwi-free-float-proxy";
}

export interface HoldingsAnalysisResult {
  etf: EtfShareClass;
  asOf: string;
  sourceStatus: DataStatus;
  cacheTtlHours: number;
  calculatedAt: string;
  holdingsCount: number;
  equityHoldingsCount: number;
  top10Concentration: number;
  topPosition: {
    ticker: string;
    name: string;
    weight: number;
  } | null;
  sectors: HoldingsSectorAllocation[];
  distortion: HoldingsDistortionAnalysis;
  positions: HoldingsAnalysisPosition[];
}
