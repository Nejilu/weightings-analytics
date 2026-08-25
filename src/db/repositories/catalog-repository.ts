import { and, asc, eq, inArray } from "drizzle-orm";

import type {
  CatalogGroup,
  DerivedHoldingsDefinition,
  EtfShareClass,
} from "@/domain/etf";
import type { PortfolioSecurity } from "@/domain/portfolio";

import { getDb } from "../client";
import { benchmarks, etfs, securities } from "../schema";

function mapDerivedHoldings(
  value: unknown,
): DerivedHoldingsDefinition | undefined {
  const candidate =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  if (
    typeof record.sourceEtfId !== "string" ||
    typeof record.sourceIndexName !== "string" ||
    typeof record.compositionSourceUrl !== "string"
  ) return undefined;

  if (
    record.model === "scaled-source" &&
    typeof record.exposureMultiplier === "number" &&
    Number.isFinite(record.exposureMultiplier) &&
    record.exposureMultiplier > 0
  ) {
    return record as unknown as DerivedHoldingsDefinition;
  }

  if (
    (record.model === "component-market-value" || record.model === undefined) &&
    (typeof record.sourceIndexIsin === "string" ||
      typeof record.sourceIndexCode === "string") &&
    typeof record.constituentsEffectiveDate === "string" &&
    typeof record.constituentsReviewedAt === "string" &&
    Array.isArray(record.componentTickers) &&
    record.componentTickers.every((ticker) => typeof ticker === "string") &&
    (record.componentSecurityIds === undefined ||
      (record.componentSecurityIds !== null &&
        typeof record.componentSecurityIds === "object" &&
        !Array.isArray(record.componentSecurityIds) &&
        Object.entries(record.componentSecurityIds).every(
          ([ticker, securityId]) =>
            ticker.trim().length > 0 &&
            typeof securityId === "string" &&
            securityId.trim().length > 0,
        ))) &&
    record.missingComponentPolicy === "exclude-and-renormalize" &&
    record.weighting === "source-market-value-normalized"
  ) {
    return {
      ...record,
      model: "component-market-value",
    } as unknown as DerivedHoldingsDefinition;
  }

  return undefined;
}

function mapHoldingsSourceEtfId(value: unknown): string | undefined {
  const candidate =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  if (!candidate || typeof candidate !== "object") return undefined;
  const sourceId = (candidate as Record<string, unknown>).holdingsSourceEtfId;
  return typeof sourceId === "string" && sourceId.trim()
    ? sourceId
    : undefined;
}

function mapEtfRow(row: typeof etfs.$inferSelect): EtfShareClass {
  const derivedHoldings = mapDerivedHoldings(row.metadataJson);
  const holdingsSourceEtfId = mapHoldingsSourceEtfId(row.metadataJson);
  return {
    id: row.id,
    ticker: row.ticker,
    name: row.name,
    benchmarkId: row.benchmarkId,
    isin: row.isin,
    wrapper: row.wrapper as EtfShareClass["wrapper"],
    domicile: row.domicile,
    exchange: row.exchange,
    tradingCurrency: row.tradingCurrency,
    distributionPolicy:
      row.distributionPolicy as EtfShareClass["distributionPolicy"],
    ter: row.ter ?? 0,
    productUrl: row.productUrl,
    holdingsUrl: row.holdingsUrl,
    priceSymbol: row.priceSymbol ?? undefined,
    issuer: row.issuer,
    fundType:
      row.fundType === "portfolio" || row.fundType === "custom"
        ? row.fundType
        : "physical",
    portfolioId: row.portfolioId ?? undefined,
    description: row.description ?? undefined,
    holdingsSourceEtfId,
    derivedHoldings,
    exposureMultiplier:
      derivedHoldings?.model === "scaled-source"
        ? derivedHoldings.exposureMultiplier
        : undefined,
  };
}

export function listCatalogGroups(): CatalogGroup[] {
  const db = getDb();
  const benchmarkRows = db
    .select()
    .from(benchmarks)
    .orderBy(asc(benchmarks.createdAt))
    .all();
  const etfRows = db
    .select()
    .from(etfs)
    .where(eq(etfs.active, true))
    .orderBy(asc(etfs.createdAt))
    .all();

  return benchmarkRows
    .map((benchmark) => ({
      id: benchmark.id,
      name: benchmark.name,
      provider: benchmark.provider,
      region: benchmark.region ?? "",
      description: benchmark.description ?? "",
      variants: etfRows
        .filter((etf) => etf.benchmarkId === benchmark.id)
        .map(mapEtfRow),
    }))
    .filter((benchmark) => benchmark.variants.length > 0);
}

export function findEtfByTicker(
  ticker: string,
): EtfShareClass | undefined {
  const candidates = getDb()
    .select()
    .from(etfs)
    .where(
      and(
        eq(etfs.ticker, ticker.toUpperCase()),
        eq(etfs.active, true),
      ),
    )
    .all()
    .map(mapEtfRow);

  return (
    candidates.find((candidate) => !candidate.holdingsSourceEtfId) ??
    candidates[0]
  );
}

export function findEtfById(id: string): EtfShareClass | undefined {
  const row = getDb()
    .select()
    .from(etfs)
    .where(and(eq(etfs.id, id), eq(etfs.active, true)))
    .limit(1)
    .get();

  return row ? mapEtfRow(row) : undefined;
}

export function findEtfByReference(
  reference: string,
): EtfShareClass | undefined {
  return findEtfById(reference) ?? findEtfByTicker(reference);
}

export function findSecuritiesByIds(
  ids: string[],
): Map<string, PortfolioSecurity> {
  if (ids.length === 0) return new Map();

  const rows = getDb()
    .select()
    .from(securities)
    .where(inArray(securities.id, ids))
    .all();

  return new Map(
    rows.map((row) => {
      const identifiers = row.identifiersJson &&
        typeof row.identifiersJson === "object"
        ? row.identifiersJson as Record<string, unknown>
        : {};
      return [
        row.id,
        {
          securityId: row.id,
          ticker: row.primaryTicker ?? "—",
          name: row.name,
          sector: row.sector ?? "Unclassified",
          assetClass: row.assetClass ?? "Unclassified",
          country: row.country ?? "Not reported",
          isin: row.isin ?? undefined,
          exchange: typeof identifiers.exchange === "string"
            ? identifiers.exchange
            : undefined,
        },
      ];
    }),
  );
}
