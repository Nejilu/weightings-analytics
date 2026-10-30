import type { PortfolioAssetKind } from "./portfolio";

export type PortfolioReturnBasis = "total" | "invested";
export interface InvestedPosition {
  kind: PortfolioAssetKind;
  referenceId: string;
  ticker: string;
  quantity: number;
  priceUsd: number;
  exposureMultiplier: number;
}
export interface InvestedSnapshot {
  positions: InvestedPosition[];
  grossExposureUsd: number;
  indexUsd: number;
  indexEur: number;
  segment: string;
}
export interface InvestedIndices {
  investedIndexUsd?: number;
  investedIndexEur?: number;
  investedSegment?: string;
}
export const investedPositionKey = (position: Pick<InvestedPosition, "kind" | "referenceId">) => `${position.kind}:${position.referenceId}`;

// Cash, borrowing and changes in quantities do not enter the numerator.
// Mark the PREVIOUS book at today's prices; edits apply at the capture boundary.
export function buildInvestedSnapshot(
  date: string, positions: InvestedPosition[], eurToUsd: number,
  previous: { invested?: InvestedSnapshot | null; eurToUsd: number } | undefined,
  prices: ReadonlyMap<string, number>,
): InvestedSnapshot | null {
  if (!(eurToUsd > 0) || !Number.isFinite(eurToUsd) || positions.some((p) =>
    !Number.isFinite(p.quantity) || !(p.priceUsd > 0) || !Number.isFinite(p.priceUsd) || !(p.exposureMultiplier > 0) || !Number.isFinite(p.exposureMultiplier))) return null;
  const grossExposureUsd = positions.reduce((sum, p) => sum + Math.abs(p.quantity * p.priceUsd) * p.exposureMultiplier, 0);
  if (!Number.isFinite(grossExposureUsd)) return null;
  const prior = previous?.invested;
  if (!prior || !(prior.grossExposureUsd > 0)) return grossExposureUsd > 0 ? { positions, grossExposureUsd, indexUsd: 100, indexEur: 100, segment: date } : null;
  let pnlUsd = 0, pnlEur = 0;
  for (const p of prior.positions) {
    const price = prices.get(investedPositionKey(p));
    if (price === undefined || !(price > 0) || !Number.isFinite(price)) return null;
    pnlUsd += p.quantity * (price - p.priceUsd);
    pnlEur += p.quantity * (price / eurToUsd - p.priceUsd / previous!.eurToUsd);
  }
  const indexUsd = prior.indexUsd * (1 + pnlUsd / prior.grossExposureUsd);
  const indexEur = prior.indexEur * (1 + pnlEur / (prior.grossExposureUsd / previous!.eurToUsd));
  if (![indexUsd, indexEur].every((value) => Number.isFinite(value) && value > 0)) return null;
  return { positions, grossExposureUsd, indexUsd, indexEur, segment: prior.segment };
}

// Only dimensionless indices may be published for weights-only portfolios.
export function investedIndices(snapshot: InvestedSnapshot | null | undefined): InvestedIndices {
  return snapshot ? { investedIndexUsd: snapshot.indexUsd, investedIndexEur: snapshot.indexEur, investedSegment: snapshot.segment } : {};
}

// A failed/empty capture breaks continuity. Never join or rebase across that gap.
export function latestInvestedSegment<T extends InvestedIndices>(points: T[]): T[] {
  // Retain the last recorded segment during an outage or cash-only period.
  const valid = (p: T) => Boolean(p.investedSegment) && [p.investedIndexUsd, p.investedIndexEur].every((value) => value !== undefined && Number.isFinite(value) && value > 0);
  const segment = points.slice().reverse().find(valid)?.investedSegment;
  return segment ? points.filter((p) => p.investedSegment === segment && valid(p)) : [];
}

export const INVESTED_RETURN_NOTE = "Price return of the previous captured holdings, divided by their gross exposure and compounded at each capture. Cash and portfolio borrowing are excluded; known ETF leverage multipliers are included in exposure. Trades are treated as occurring at capture time. Cash dividends, fees and intraday trading P&L are not included. This is not benchmark alpha. Missing data starts a new series; older totals cannot reconstruct this return.";
