import type { EtfVisibility } from "./visibility";
import { latestInvestedSegment, type InvestedIndices, type PortfolioReturnBasis } from "./portfolio-invested-return";

export type PortfolioPeriod = { preset: "1M" | "3M" | "1Y" | "All" } | { date: string };

export function portfolioPeriodStart(period: PortfolioPeriod, earliest: string, latest: string): string {
  if ("date" in period) return period.date;
  if (period.preset === "All" || !latest) return earliest;
  const date = new Date(`${latest}T12:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - ({ "1M": 1, "3M": 3, "1Y": 12 }[period.preset]));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

export interface PortfolioDashboardPoint extends InvestedIndices {
  date: string;
  indexUsd: number;
  indexEur: number;
  valueUsd?: number;
  valueEur?: number;
}

export interface PortfolioDashboardEntry {
  id: string;
  ticker: string;
  name: string;
  visibility: EtfVisibility;
  positionsCount: number;
  cashCount: number;
  snapshots: PortfolioDashboardPoint[];
}

export function dashboardSeries(entries: PortfolioDashboardEntry[], mode: "relative" | "absolute", currency: "USD" | "EUR", start: string, basis: PortfolioReturnBasis = "total") {
  return entries.flatMap((entry) => {
    const points = (basis === "invested" ? latestInvestedSegment(entry.snapshots) : entry.snapshots).filter((point) => !start || point.date >= start);
    const base = points[0];
    if (!base) return [];
    const indexKey = basis === "invested" ? (currency === "USD" ? "investedIndexUsd" : "investedIndexEur") : (currency === "USD" ? "indexUsd" : "indexEur");
    const valueKey = currency === "USD" ? "valueUsd" : "valueEur";
    if (basis === "invested" && mode === "absolute") return [];
    if (mode === "absolute" && base[valueKey] === undefined) return [];
    return [{ ...entry, baselineDate: base.date, points: points.flatMap((point) => {
      const value = mode === "relative" ? (point[indexKey]! / base[indexKey]! - 1) * 100 : point[valueKey];
      return value !== undefined && Number.isFinite(value) ? [{ date: point.date, value }] : [];
    }) }];
  });
}
