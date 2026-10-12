import type { Holding } from "./etf";
import { economicSecurityIdentity } from "./security-equivalence";

export type CapitalizationStatus = "available" | "missing" | "invalid" | "stale" | "unresolved" | "conflicting";
export interface CapitalizationObservation {
  securityId: string;
  ticker: string;
  marketCapUsd: number | null;
  providerSymbol: string | null;
  capturedAt: string | null;
  status: CapitalizationStatus;
  companyId?: string;
  companyName?: string;
}
export interface CapitalizationReferenceData {
  currency: "USD";
  source: "tradingview";
  fetchedAt: string;
  universe: "holdings" | "market";
  observations: CapitalizationObservation[];
}

// This bound catches currency/scale accidents, rather than trimming legitimate
// large companies or inferring a company's free float from its ACWI weight.
export const MAX_PLAUSIBLE_MARKET_CAP_USD = 100_000_000_000_000;
export function validMarketCapitalization(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PLAUSIBLE_MARKET_CAP_USD;
}

// Select one company-level cap, never sum caps of equivalent share classes/ADRs.
// Prefer the largest actual position's listing, then the ACWI listing.
export function buildCapitalizationObservations(
  target: Holding[], reference: Holding[], source: ReadonlyMap<string, CapitalizationObservation>,
): CapitalizationObservation[] {
  const groups = new Map<string, { ticker: string; candidates: Holding[] }>();
  for (const holding of [...target].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .concat([...reference].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)))) {
    if (!holding.assetClass.toLowerCase().includes("equity") || holding.weight === 0) continue;
    const identity = economicSecurityIdentity(holding);
    const existing = groups.get(identity.securityId);
    if (existing) {
      if (!existing.candidates.some((candidate) => candidate.securityId === holding.securityId)) existing.candidates.push(holding);
    } else groups.set(identity.securityId, { ticker: identity.ticker, candidates: [holding] });
  }
  return [...groups].map(([securityId, group]) => {
    const available = group.candidates.map((candidate) => source.get(candidate.securityId))
      .filter((observation): observation is CapitalizationObservation => observation?.status === "available" && validMarketCapitalization(observation.marketCapUsd));
    const chosen = available[0] ?? source.get(group.candidates[0].securityId);
    const caps = available.map((observation) => observation.marketCapUsd!);
    const conflicting = caps.length > 1 && Math.max(...caps) / Math.min(...caps) > 1.25;
    return {
      securityId, ticker: group.ticker,
      marketCapUsd: conflicting ? null : available[0]?.marketCapUsd ?? null,
      providerSymbol: chosen?.providerSymbol ?? null, capturedAt: chosen?.capturedAt ?? null,
      status: conflicting ? "conflicting" : available.length ? "available" : chosen?.status ?? "missing",
      ...(chosen?.companyId ? { companyId: chosen.companyId } : {}),
      ...(chosen?.companyName ? { companyName: chosen.companyName } : {}),
    };
  });
}

// A shared logo is only a candidate issuer identifier. Require agreeing
// company-level caps as independent evidence before merging distinct listings.
export function capitalizationCompanyName(name: string): string {
  return name.toUpperCase().replace(/\b(?:PFD|PREF(?:ERRED)?|PARTIZIPSCH|NON[- ]CUM)\b.*$/, "")
    .replace(/\bCLASS\s+[A-Z0-9]+\b/g, "")
    .replace(/\b(?:SPONSORED|UNSPONSORED|ORDINARY|REGISTERED|COMMON|PREFERRED|PFD|NON[- ]?VOTING|VOTING|DEPOSITARY|DEPOSITORY|RECEIPTS?|SHARES?|STOCK|ADR|GDR|INCORPORATED|CORPORATION|LIMITED|COMPANY|CORP|INC|LTD|PLC|NV|CO)\b/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

export function assignCapitalizationCompanies(observations: CapitalizationObservation[], logos: ReadonlyMap<string, string>): CapitalizationObservation[] {
  const groups = new Map<string, CapitalizationObservation[]>();
  for (const row of observations) {
    const logo = row.providerSymbol ? logos.get(row.providerSymbol) : undefined;
    if (!logo || row.status !== "available" || !validMarketCapitalization(row.marketCapUsd)) continue;
    const key = `${logo}:${capitalizationCompanyName(row.companyName ?? row.ticker)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const identities = new Map<string, string>();
  for (const [logo, group] of groups) {
    if (group.length < 2) continue;
    // Several independently listed subsidiaries can use the same brand logo.
    // Split the candidates by capitalization instead of merging the brand.
    const sorted = [...group].sort((a, b) => a.marketCapUsd! - b.marketCapUsd!);
    const clusters: CapitalizationObservation[][] = [];
    for (const row of sorted) {
      const cluster = clusters.at(-1);
      if (cluster && row.marketCapUsd! / cluster[0].marketCapUsd! <= 1.01) cluster.push(row);
      else clusters.push([row]);
    }
    for (const cluster of clusters.filter((rows) => rows.length > 1)) {
      const firstId = cluster.map((row) => row.securityId).sort()[0];
      for (const row of cluster) identities.set(row.securityId, `company:${logo}:${firstId}`);
    }
  }
  return observations.map((row) => ({ ...row, companyId: identities.get(row.securityId) ?? row.securityId }));
}
