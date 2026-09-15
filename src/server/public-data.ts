import { getCatalog } from "@/data/services/catalog-service";
import { getDb } from "@/db/client";
import { etfs, portfolioItems } from "@/db/schema";
import type { CatalogGroup, EtfShareClass } from "@/domain/etf";
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

// Public analysis DTOs contain relative weights only. Exact portfolio positions
// use their own allowlisted endpoint, never a redacted owner/edit DTO.
const privateFields = new Set([
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
  return Object.fromEntries(
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
}
