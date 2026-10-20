import { getCatalog } from "@/data/services/catalog-service";
import { getDb } from "@/db/client";
import { etfs, portfolioItems } from "@/db/schema";
import type { CatalogGroup, EtfShareClass } from "@/domain/etf";
import type { PortfolioHoldingsValuation } from "@/domain/portfolio-valuation";
import type { PortfolioDashboardEntry } from "@/domain/portfolio-dashboard";
import type { LocalPortfolioEtfDetail } from "@/domain/local-etf";
import type { PortfolioHistory } from "@/domain/portfolio-history";
import { investedIndices } from "@/domain/portfolio-invested-return";
import { AccessError } from "./site-access";

export function publicationCatalog() {
  const groups = getCatalog();
  const byId = new Map(
    groups.flatMap((g) => g.variants.map((e) => [e.id, e] as const)),
  );
  const definitions = getDb()
    .select({ id: etfs.id, metadata: etfs.metadataJson })
    .from(etfs)
    .all();
  const items = getDb()
    .select({
      portfolioId: portfolioItems.portfolioId,
      etfId: portfolioItems.etfId,
    })
    .from(portfolioItems)
    .all();
  const dependencies = new Map<string, string[]>();
  for (const row of definitions) {
    const etf = byId.get(row.id);
    const metadata = row.metadata as Record<string, unknown> | null;
    dependencies.set(
      row.id,
      [
        etf?.holdingsSourceEtfId,
        etf?.derivedHoldings?.sourceEtfId,
        typeof metadata?.sourceEtfId === "string"
          ? metadata.sourceEtfId
          : undefined,
        ...items
          .filter((i) => i.portfolioId === etf?.portfolioId)
          .map((i) => i.etfId),
      ].filter((id): id is string => Boolean(id)),
    );
  }
  const memo = new Map<string, boolean>();
  function visible(id: string, visiting = new Set<string>()): boolean {
    if (memo.has(id)) return memo.get(id)!;
    const etf = byId.get(id);
    if (
      !etf ||
      etf.visibility === "private" ||
      !etf.visibility ||
      visiting.has(id)
    )
      return false;
    const next = new Set(visiting).add(id);
    const result = (dependencies.get(id) ?? []).every((dep) =>
      visible(dep, next),
    );
    memo.set(id, result);
    return result;
  }
  function resolve(reference: string) {
    return (
      byId.get(reference) ??
      [...byId.values()].find(
        (e) => e.ticker === reference.toUpperCase() && !e.holdingsSourceEtfId,
      ) ??
      [...byId.values()].find((e) => e.ticker === reference.toUpperCase())
    );
  }
  return { groups, byId, visible, resolve };
}

type PublicationCatalog = ReturnType<typeof publicationCatalog>;

export function publicPortfolioDetail(detail: LocalPortfolioEtfDetail, catalog: PublicationCatalog) {
  const etf = requirePublicEtf(catalog, detail.etf.id);
  if (etf.fundType !== "portfolio" || detail.kind !== "portfolio") throw new AccessError(404, "Portfolio unavailable.");
  const showAmounts = etf.visibility === "public";
  const record = detail.portfolio;
  return {
    kind: "portfolio", etf: publicEtf(etf), editableDescription: "Published portfolio composition.",
    portfolio: {
      id: etf.id, name: etf.name, baseCurrency: "USD", updatedAt: record.updatedAt,
      amountsVisible: showAmounts,
      items: record.items.map((item, index) => ({
        id: `published-item-${index}`, kind: item.kind, referenceId: item.referenceId,
        ticker: item.ticker, name: item.name, allocationWeight: item.allocationWeight,
        ...(showAmounts ? { quantity: item.quantity, currentValueUsd: item.currentValueUsd, currentPriceUsd: item.currentPriceUsd } : {}),
      })),
      cashPositions: record.cashPositions.map((cash) => ({
        currency: cash.currency, weight: cash.weight,
        ...(showAmounts ? { amount: cash.amount, valueUsd: cash.valueUsd, fxToUsd: cash.fxToUsd } : {}),
      })),
      analysis: record.analysis ? {
        ...publicAnalysis(record.analysis, catalog) as object,
        ...(showAmounts ? { totalMarketValueUsd: record.analysis.totalMarketValueUsd } : {}),
        positions: record.analysis.positions.map((position) => ({
          ...position, contributions: position.contributions.map((contribution) => ({
            ticker: contribution.ticker, kind: contribution.kind, weight: contribution.weight,
            itemId: `source:${contribution.kind}:${contribution.ticker}`,
          })),
        })),
      } : null,
      ...(record.analysisError ? { analysisError: "Portfolio analysis is temporarily unavailable." } : {}),
      ...(record.priceError ? { priceError: "Portfolio prices are temporarily unavailable." } : {}),
    },
  };
}

export function publicPortfolioHistory(history: PortfolioHistory, reference: string, catalog: PublicationCatalog) {
  const etf = requirePublicEtf(catalog, reference);
  if (etf.fundType !== "portfolio") throw new AccessError(404, "Portfolio unavailable.");
  const base = history.snapshots[0];
  return { enabled: history.enabled, lastError: null, lastAttemptAt: null, snapshots: history.snapshots.map((point) => ({
    date: point.date, capturedAt: point.capturedAt, reason: point.reason,
    indexUsd: point.valueUsd / base.valueUsd * 100, indexEur: point.valueEur / base.valueEur * 100,
    ...investedIndices(point.invested),
    ...(etf.visibility === "public" ? { valueUsd: point.valueUsd, valueEur: point.valueEur } : {}),
  })) };
}

export function publicPortfolioDashboard(entries: PortfolioDashboardEntry[], catalog: PublicationCatalog): PortfolioDashboardEntry[] {
  return entries.flatMap((entry) => {
    const etf = catalog.byId.get(entry.id);
    if (!etf || etf.fundType !== "portfolio" || !catalog.visible(etf.id)) return [];
    return [{
      id: etf.id, ticker: etf.ticker, name: etf.name, visibility: etf.visibility!,
      positionsCount: entry.positionsCount, cashCount: entry.cashCount,
      snapshots: entry.snapshots.map((point) => ({
        date: point.date, indexUsd: point.indexUsd, indexEur: point.indexEur,
        investedIndexUsd: point.investedIndexUsd, investedIndexEur: point.investedIndexEur, investedSegment: point.investedSegment,
        ...(etf.visibility === "public" ? { valueUsd: point.valueUsd, valueEur: point.valueEur } : {}),
      })),
    }];
  });
}

export function requirePublicEtf(
  catalog: PublicationCatalog,
  reference: string,
): EtfShareClass {
  const etf = catalog.resolve(reference);
  if (!etf || !catalog.visible(etf.id))
    throw new AccessError(404, "ETF unavailable.");
  return etf;
}

export function publicEtf(etf: EtfShareClass): EtfShareClass {
  const local = etf.fundType === "portfolio" || etf.fundType === "custom";
  return {
    id: etf.id,
    ticker: etf.ticker,
    name: etf.name,
    benchmarkId: etf.benchmarkId,
    isin: etf.isin,
    wrapper: etf.wrapper,
    domicile: etf.domicile,
    exchange: etf.exchange,
    tradingCurrency: etf.tradingCurrency,
    distributionPolicy: etf.distributionPolicy,
    ter: etf.ter,
    issuer: etf.issuer,
    fundType: etf.fundType,
    visibility: etf.visibility,
    productUrl: local ? "" : etf.productUrl,
    holdingsUrl: local ? "" : etf.holdingsUrl,
    priceSymbol: local ? undefined : etf.priceSymbol,
    description: local
      ? etf.fundType === "portfolio"
        ? "Published portfolio composition."
        : "Published custom ETF composition."
      : etf.description,
    holdingsSourceEtfId: etf.holdingsSourceEtfId,
    exposureMultiplier: etf.exposureMultiplier,
    publiclyAvailable: true,
  };
}

export function siteCatalog(
  owner: boolean,
  catalog = publicationCatalog(),
): CatalogGroup[] {
  return catalog.groups
    .map((group) => ({
      ...group,
      variants: group.variants
        .filter((etf) => owner || catalog.visible(etf.id))
        .map((etf) =>
          owner
            ? { ...etf, publiclyAvailable: catalog.visible(etf.id) }
            : publicEtf(etf),
        ),
    }))
    .filter((group) => group.variants.length > 0);
}

// Exact portfolio valuation has a dedicated allowlist and requires full public
// visibility. Other analysis fields continue to expose relative weights only.
const privateFields = new Set([
  "portfolioValuation",
  "portfolioId",
  "marketValue",
  "valueUsd",
  "totalMarketValueUsd",
  "quantity",
  "amount",
  "inputAmount",
  "initialValueUsd",
  "initialPriceUsd",
  "currentValueUsd",
  "editableDescription",
  "criteria",
  "selectedSecurityIds",
  "derivedHoldings",
]);

export function publicAnalysis(
  value: unknown,
  catalog: PublicationCatalog,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => publicAnalysis(item, catalog));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id === "string" &&
    typeof record.benchmarkId === "string" &&
    typeof record.ticker === "string"
  ) {
    return publicEtf(requirePublicEtf(catalog, record.id));
  }
  const projected = Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !privateFields.has(key))
      .map(([key, item]) => [
        key,
        key === "sourceUrl" &&
        typeof item === "string" &&
        item.startsWith("local:")
          ? ""
          : publicAnalysis(item, catalog),
      ]),
  );
  if (record.portfolioValuation && record.etf && typeof record.etf === "object") {
    const etfId = (record.etf as Record<string, unknown>).id;
    const etf = typeof etfId === "string" ? requirePublicEtf(catalog, etfId) : undefined;
    if (etf?.fundType === "portfolio" && etf.visibility === "public") {
      const valuation = record.portfolioValuation as PortfolioHoldingsValuation;
      projected.portfolioValuation = {
        totalMarketValueUsd: valuation.totalMarketValueUsd,
        items: valuation.items.map((item) => ({
          ticker: item.ticker,
          name: item.name,
          kind: item.kind,
          adrPremiumPairId: item.adrPremiumPairId ?? null,
          quantity: item.quantity,
          currentValueUsd: item.currentValueUsd,
          allocationWeight: item.allocationWeight,
        })),
        cash: valuation.cash.map((cash) => ({
          currency: cash.currency,
          amount: cash.amount,
          valueUsd: cash.valueUsd,
          weight: cash.weight,
        })),
      } satisfies PortfolioHoldingsValuation;
    }
  }
  return projected;
}
