import "server-only";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { databasePath } from "@/db/client";
import { findEtfByReference } from "@/db/repositories/catalog-repository";
import { ensureMetricDefinitions, loadLatestSecurityMetrics, loadProviderSymbols } from "@/db/repositories/metrics-repository";
import { assignCapitalizationCompanies, buildCapitalizationObservations, validMarketCapitalization, type CapitalizationObservation, type CapitalizationReferenceData } from "@/domain/capitalization-reference";
import { economicSecurityIdentity } from "@/domain/security-equivalence";
import { resolvedProviderSymbol } from "@/domain/metrics-cache";
import { getHoldingsSnapshot } from "./holdings-service";
import { prepareScreenerRefresh, refreshScreenerMetrics, ScreenerRefreshUnavailableError } from "./metrics-overview-screener";
import { fetchTradingViewCapitalizations } from "../providers/tradingview-capitalization";

export class CapitalizationReferenceRequestError extends Error {}
const inFlight = new Map<string, Promise<CapitalizationReferenceData>>();

export function getCapitalizationReference(reference: string, universe: "holdings" | "market" = "holdings"): Promise<CapitalizationReferenceData> {
  ensureLocalDatabase();
  const etf = findEtfByReference(reference);
  if (!etf) return Promise.reject(new CapitalizationReferenceRequestError("Unknown ETF or portfolio."));
  const key = `${databasePath()}:${etf.id}:${universe}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = loadReference(etf.id, universe).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

async function loadReference(reference: string, universe: "holdings" | "market"): Promise<CapitalizationReferenceData> {
  const [target, acwi] = await Promise.all([getHoldingsSnapshot(reference), getHoldingsSnapshot("acwi-us")]);
  const equity = (p: { assetClass: string; weight: number }) => p.weight !== 0 && p.assetClass.toLowerCase().includes("equity");
  const targetEquities = target.holdings.filter(equity);
  const targetIds = new Set(targetEquities.map((p) => economicSecurityIdentity(p).securityId));
  const referenceEquities = acwi.holdings.filter((p) => equity(p) && (universe === "market" || targetIds.has(economicSecurityIdentity(p).securityId)));
  const holdings = [...new Map([...referenceEquities, ...targetEquities].map((p) => [p.securityId, p])).values()];
  const ids = holdings.map((p) => p.securityId);
  ensureMetricDefinitions();
  let symbols = loadProviderSymbols(ids);
  const cached = loadLatestSecurityMetrics(ids);
  const configured = Number(process.env.TRADINGVIEW_METRICS_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(configured) && configured > 0 ? configured : 86_400;
  const plan = prepareScreenerRefresh({ holdings, providerSymbols: symbols, cachedMetrics: cached, ttlSeconds });
  try {
    const result = await refreshScreenerMetrics({
      ...plan, holdings, providerSymbols: symbols, cachedMetrics: cached, securityIds: ids, missingSourceMetricTtlMs: 900_000,
    });
    symbols = result.providerSymbols;
  } catch (error) {
    if (!(error instanceof ScreenerRefreshUnavailableError)) throw error;
    // Resolved mappings can still be used by the separate capitalization query.
  }
  const source = new Map<string, CapitalizationObservation>();
  const resolvedSymbols = [...new Set(ids.flatMap((id) => {
    const symbol = resolvedProviderSymbol(symbols.get(id));
    return symbol ? [symbol] : [];
  }))];
  const companyRows = await fetchTradingViewCapitalizations(resolvedSymbols, fetch, ttlSeconds * 1000);
  const companyBySymbol = new Map(companyRows.map((row) => [row.symbol, row]));
  const now = Date.now();
  for (const holding of holdings) {
    const symbol = resolvedProviderSymbol(symbols.get(holding.securityId));
    const company = symbol ? companyBySymbol.get(symbol) : undefined;
    const capturedAt = company?.capturedAt ?? null;
    // A separate lightweight cap query supplies company metadata needed to
    // deduplicate ordinary/preferred classes beyond the display equivalences.
    const value = company?.marketCapUsd ?? undefined;
    const age = now - Date.parse(capturedAt ?? "");
    const status = !symbol ? "unresolved" : value === undefined ? "missing" : !validMarketCapitalization(value) ? "invalid"
      : !Number.isFinite(age) || age < -300_000 || age >= ttlSeconds * 1000 ? "stale" : "available";
    source.set(holding.securityId, {
      securityId: holding.securityId, ticker: holding.ticker, providerSymbol: symbol ?? null, capturedAt,
      marketCapUsd: status === "available" ? value! : null, status,
      companyName: company?.description,
    });
  }
  return {
    currency: "USD", source: "tradingview", fetchedAt: new Date(now).toISOString(), universe,
    observations: assignCapitalizationCompanies(buildCapitalizationObservations(targetEquities, referenceEquities, source), new Map(companyRows.flatMap((row) => row.companyLogo ? [[row.symbol, row.companyLogo]] : []))),
  };
}
