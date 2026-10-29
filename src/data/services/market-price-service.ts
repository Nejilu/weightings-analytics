import "server-only";

import YahooFinance from "yahoo-finance2";
import { loadProviderSymbols } from "@/db/repositories/metrics-repository";
import { tradingViewPriceSymbols } from "@/data/providers/market-quote-symbols";
import { getTradingViewQuote } from "@/data/providers/tradingview-quotes";
import { loadPreferredQuote, selectYahooQuote, type MarketQuote } from "@/domain/market-quote";

import { ensureLocalDatabase } from "@/db/bootstrap";
import { databasePath } from "@/db/client";
import {
  findEtfById,
  findSecuritiesByIds,
} from "@/db/repositories/catalog-repository";
import {
  findFxRate,
  findMarketPrice,
  persistFxRate,
  persistMarketPrice,
} from "@/db/repositories/market-price-repository";
import type {
  FxRate,
  MarketPrice,
  PortfolioAssetKind,
  PortfolioCashPosition,
  PortfolioItem,
  PortfolioSecurity,
} from "@/domain/portfolio";
import {
  MarketPriceRequestError,
  MarketPriceUnavailableError,
} from "@/domain/portfolio";
import { mapWithConcurrency } from "@/domain/async-utils";
import { valuePortfolioPositions } from "@/domain/processors/value-portfolio";
import {
  securityListingQuoteSymbol,
  securityQuoteAlias,
} from "@/domain/security-equivalence";

const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_CONCURRENCY = 4;
const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});
const inFlightPrices = new Map<string, Promise<MarketPrice>>();
const inFlightFx = new Map<string, Promise<FxRate>>();

export interface MarketRefreshOptions {
  forceRefresh?: boolean;
  requireFresh?: boolean;
}

export interface SecurityListingPriceRequest {
  key: string;
  securityId: string;
  ticker: string;
}

function ttlSeconds() {
  const configured = Number(process.env.MARKET_PRICE_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TTL_SECONDS;
}

function marketPriceConcurrency(): number {
  const configured = Number(process.env.MARKET_PRICE_CONCURRENCY);
  return Number.isInteger(configured) && configured >= 1 && configured <= 8
    ? configured
    : DEFAULT_CONCURRENCY;
}

function isFresh(fetchedAt: string, seconds = ttlSeconds()): boolean {
  const value = Date.parse(fetchedAt);
  return (
    Number.isFinite(value) &&
    Date.now() - value >= 0 && Date.now() - value < seconds * 1000
  );
}

async function withTimeout<T>(promise: Promise<T>, milliseconds = 15_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Yahoo Finance request timed out.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchYahooQuote(symbol: string): Promise<MarketQuote> {
  const quote = await withTimeout(yahooFinance.quote(symbol));
  if (!("symbol" in quote) || typeof quote.symbol !== "string") {
    throw new Error(`No usable market price was returned for ${symbol}.`);
  }
  const selected = selectYahooQuote({ ...quote, symbol: quote.symbol,
    currency: quote.currency ?? (symbol.endsWith("USD=X") ? "USD" : undefined) });
  if (!selected) {
    throw new Error(`No usable market price was returned for ${symbol}.`);
  }
  return selected;
}

async function fetchAssetQuote(
  listing: { ticker: string; name: string; country: string; exchange?: string },
  yahooSymbol: string | undefined,
  resolveYahoo: () => Promise<string>,
  securityId?: string,
): Promise<MarketQuote> {
  const mapping = securityId ? loadProviderSymbols([securityId]).get(securityId) : undefined;
  return loadPreferredQuote(tradingViewPriceSymbols(listing, yahooSymbol,
    mapping?.status === "resolved" ? mapping.providerSymbol ?? undefined : undefined), {
    tradingView: getTradingViewQuote,
    yahoo: async () => fetchYahooQuote(yahooSymbol ?? await resolveYahoo()),
  });
}

async function resolveSecuritySymbol(
  security: PortfolioSecurity,
): Promise<string> {
  const alias = securityQuoteAlias(security);
  if (alias) return alias.providerSymbol;
  const listingSymbol = securityListingQuoteSymbol(security);
  if (listingSymbol) return listingSymbol;

  if (
    security.country.toLowerCase().includes("united states") &&
    /^[A-Z][A-Z0-9.-]{0,9}$/i.test(security.ticker)
  ) {
    return security.ticker.toUpperCase();
  }

  const result = await withTimeout(
    yahooFinance.search(
      security.isin ?? `${security.ticker} ${security.name}`,
      { quotesCount: 8, newsCount: 0 },
    ),
  );
  const candidates = result.quotes.filter(
    (candidate) =>
      candidate.isYahooFinance &&
      (candidate.quoteType === "EQUITY" || candidate.quoteType === "ETF"),
  );
  const exactTicker = candidates.find(
    (candidate) =>
      candidate.isYahooFinance &&
      candidate.symbol.toUpperCase() === security.ticker.toUpperCase(),
  );
  const candidate = exactTicker ?? candidates[0];
  if (!candidate || !candidate.isYahooFinance) {
    throw new Error(
      `No Yahoo Finance symbol could be resolved for ${security.ticker}.`,
    );
  }
  return candidate.symbol;
}

function currencyDefinition(currency: string) {
  const normalized = currency.trim();
  if (normalized === "GBp" || normalized.toUpperCase() === "GBX") {
    return { baseCurrency: "GBP", unitScale: 0.01 };
  }
  return { baseCurrency: normalized.toUpperCase(), unitScale: 1 };
}

async function refreshFxRate(
  currency: string,
  options: MarketRefreshOptions,
): Promise<FxRate> {
  const cached = findFxRate(currency);
  const configured = Number(process.env.FX_RATE_TTL_SECONDS);
  const fxTtl = Number.isFinite(configured) && configured > 0 ? configured : 86_400;
  if (!options.forceRefresh && cached && isFresh(cached.fetchedAt, fxTtl)) return cached;

  const providerSymbol = `${currency}USD=X`;
  try {
    const quote = await fetchYahooQuote(providerSymbol);
    return persistFxRate({
      currency,
      providerSymbol,
      rateToUsd: quote.price,
      asOf: quote.asOf,
      fetchedAt: new Date().toISOString(),
      sourceStatus: "live",
    });
  } catch (error) {
    if (cached && !options.requireFresh) return { ...cached, sourceStatus: "stale" };
    throw error;
  }
}

export async function getFxRate(
  currency: string,
  options: MarketRefreshOptions = {},
): Promise<FxRate> {
  if (currency === "USD") {
    const now = new Date().toISOString();
    return {
      currency,
      providerSymbol: "USD",
      rateToUsd: 1,
      asOf: now,
      fetchedAt: now,
      sourceStatus: "cached",
    };
  }

  const key = `${databasePath()}::fx:${currency.toUpperCase()}::${options.forceRefresh ? "force" : "cached"}::${options.requireFresh ? "strict" : "fallback"}`;
  const existing = inFlightFx.get(key);
  if (existing) return existing;
  const request = refreshFxRate(currency, options).finally(() => {
    inFlightFx.delete(key);
  });
  inFlightFx.set(key, request);
  return request;
}

async function refreshMarketPrice(
  assetKind: PortfolioAssetKind,
  assetId: string,
  options: MarketRefreshOptions,
): Promise<MarketPrice> {
  ensureLocalDatabase();
  const cached = findMarketPrice(assetKind, assetId);
  const security =
    assetKind === "security"
      ? findSecuritiesByIds([assetId]).get(assetId)
      : undefined;
  const alias = security ? securityQuoteAlias(security) : undefined;
  const listingSymbol = security
    ? securityListingQuoteSymbol(security)
    : undefined;
  const preferredSecuritySymbol = alias?.providerSymbol ?? listingSymbol;
  const securityCandidates = security ? tradingViewPriceSymbols(security, preferredSecuritySymbol) : [];
  const fallbackCached =
    (cached?.source === "TradingView" ? securityCandidates.includes(cached.providerSymbol) || assetKind === "etf" :
      !preferredSecuritySymbol || cached?.providerSymbol.toUpperCase() === preferredSecuritySymbol.toUpperCase())
      ? cached
      : undefined;
  if (!options.forceRefresh && fallbackCached?.quoteSession && isFresh(fallbackCached.fetchedAt)) {
    return fallbackCached;
  }

  try {
    let quote: MarketQuote;
    if (assetKind === "etf") {
      const etf = findEtfById(assetId);
      if (
        !etf ||
        etf.fundType === "portfolio" ||
        etf.fundType === "custom"
      ) {
        throw new MarketPriceRequestError(
          "Only source ETFs can be priced as portfolio components.",
        );
      }
      const symbol = etf.priceSymbol ?? etf.ticker;
      quote = await fetchAssetQuote({ ...etf, country: "" }, symbol, async () => symbol);
    } else {
      if (!security) {
        throw new MarketPriceRequestError("The selected security is unavailable.");
      }
      quote = await fetchAssetQuote(security, preferredSecuritySymbol, () => resolveSecuritySymbol(security), assetId);
    }

    const { baseCurrency, unitScale } = currencyDefinition(quote.currency);
    const fx = await getFxRate(baseCurrency, options);
    const priceUsd = quote.price * unitScale * fx.rateToUsd;

    return persistMarketPrice({
      assetKind,
      assetId,
      providerSymbol: quote.symbol,
      price: quote.price,
      currency: quote.currency,
      fxToUsd: unitScale * fx.rateToUsd,
      priceUsd,
      asOf: quote.asOf,
      fetchedAt: new Date().toISOString(),
      sourceStatus: "live",
      source: quote.source,
      quoteSession: quote.session,
      delaySeconds: quote.delaySeconds,
    });
  } catch (error) {
    if (error instanceof MarketPriceRequestError) throw error;
    if (fallbackCached && !options.requireFresh) {
      return { ...fallbackCached, sourceStatus: "stale" };
    }
    throw error;
  }
}

export async function getMarketPrice(
  assetKind: PortfolioAssetKind,
  assetId: string,
  options: MarketRefreshOptions = {},
): Promise<MarketPrice> {
  const key = `${databasePath()}::${assetKind}:${assetId}::${options.forceRefresh ? "force" : "cached"}::${options.requireFresh ? "strict" : "fallback"}`;
  const existing = inFlightPrices.get(key);
  if (existing) return existing;
  const request = refreshMarketPrice(assetKind, assetId, options)
    .catch((error) => {
      if (
        error instanceof MarketPriceRequestError ||
        error instanceof MarketPriceUnavailableError
      ) {
        throw error;
      }
      throw new MarketPriceUnavailableError(error);
    })
    .finally(() => {
      inFlightPrices.delete(key);
    });
  inFlightPrices.set(key, request);
  return request;
}

export async function getMarketPrices(
  assets: Array<{ kind: PortfolioAssetKind; referenceId: string }>,
  options: MarketRefreshOptions = {},
): Promise<Map<string, MarketPrice>> {
  const unique = [
    ...new Map(
      assets.map((asset) => [`${asset.kind}:${asset.referenceId}`, asset]),
    ).values(),
  ];
  const prices = await mapWithConcurrency(
    unique,
    marketPriceConcurrency(),
    (asset) => getMarketPrice(asset.kind, asset.referenceId, options),
  );
  return new Map(
    prices.map((price) => [
      `${price.assetKind}:${price.assetId}`,
      price,
    ]),
  );
}

export async function getAvailableMarketPrices(
  assets: Array<{ kind: PortfolioAssetKind; referenceId: string }>,
  options: MarketRefreshOptions = {},
): Promise<Map<string, MarketPrice>> {
  const unique = [
    ...new Map(
      assets.map((asset) => [`${asset.kind}:${asset.referenceId}`, asset]),
    ).values(),
  ];
  const prices = await mapWithConcurrency(
    unique,
    marketPriceConcurrency(),
    async (asset) => {
      try {
        return await getMarketPrice(asset.kind, asset.referenceId, options);
      } catch {
        return null;
      }
    },
  );
  return new Map(
    prices.flatMap((price) => price
      ? [[`${price.assetKind}:${price.assetId}`, price] as const]
      : []),
  );
}

async function getSecurityListingPrice(
  request: SecurityListingPriceRequest,
  security: PortfolioSecurity,
  options: MarketRefreshOptions,
): Promise<MarketPrice> {
  const providerSymbol = securityListingQuoteSymbol(security, request.ticker);
  const listing = { ...security, ticker: request.ticker };
  const cacheAssetId = `listing:${request.securityId}:${providerSymbol ?? request.ticker}`;
  const inFlightKey = `${databasePath()}::security:${cacheAssetId}::${options.forceRefresh ? "force" : "cached"}::${options.requireFresh ? "strict" : "fallback"}`;
  const existing = inFlightPrices.get(inFlightKey);
  if (existing) {
    const price = await existing;
    return { ...price, assetId: request.key };
  }

  const loadPrice = (async () => {
    ensureLocalDatabase();
    const cached = findMarketPrice("security", cacheAssetId);
    if (!options.forceRefresh && cached?.quoteSession && isFresh(cached.fetchedAt)) {
      return cached;
    }
    try {
      const quote = await fetchAssetQuote(listing, providerSymbol, () => resolveSecuritySymbol(listing), request.securityId);
      const { baseCurrency, unitScale } = currencyDefinition(quote.currency);
      const fx = await getFxRate(baseCurrency, options);
      return persistMarketPrice({
        assetKind: "security",
        assetId: cacheAssetId,
        providerSymbol: quote.symbol,
        price: quote.price,
        currency: quote.currency,
        fxToUsd: unitScale * fx.rateToUsd,
        priceUsd: quote.price * unitScale * fx.rateToUsd,
        asOf: quote.asOf,
        fetchedAt: new Date().toISOString(),
        sourceStatus: "live",
        source: quote.source,
        quoteSession: quote.session,
        delaySeconds: quote.delaySeconds,
      });
    } catch (error) {
      if (cached && !options.requireFresh) return { ...cached, sourceStatus: "stale" as const };
      throw error;
    }
  })().finally(() => {
    inFlightPrices.delete(inFlightKey);
  });
  inFlightPrices.set(inFlightKey, loadPrice);
  const price = await loadPrice;
  return { ...price, assetId: request.key };
}

export async function getAvailableSecurityListingPrices(
  requests: SecurityListingPriceRequest[],
  options: MarketRefreshOptions = {},
): Promise<Map<string, MarketPrice>> {
  const unique = [...new Map(requests.map((request) => [request.key, request])).values()];
  const securities = findSecuritiesByIds(unique.map((request) => request.securityId));
  const prices = await mapWithConcurrency(
    unique,
    marketPriceConcurrency(),
    async (request) => {
      const security = securities.get(request.securityId);
      if (!security) return null;
      try {
        return await getSecurityListingPrice(request, security, options);
      } catch {
        return null;
      }
    },
  );
  return new Map(
    prices.flatMap((price) =>
      price ? [[price.assetId, price] as const] : [],
    ),
  );
}

export async function valuePortfolioItems(
  items: PortfolioItem[],
  cashValueUsd = 0,
  options: MarketRefreshOptions = {},
): Promise<{ items: PortfolioItem[]; totalMarketValueUsd: number }> {
  if (items.length === 0) {
    if (cashValueUsd <= 0) {
      return { items: [], totalMarketValueUsd: cashValueUsd };
    }
    return { items: [], totalMarketValueUsd: cashValueUsd };
  }
  const prices = await getMarketPrices(
    items.map((item) => ({
      kind: item.kind,
      referenceId: item.referenceId,
    })),
    options,
  );

  return valuePortfolioPositions(items, prices, cashValueUsd);
}

export async function valueCashPositions(
  positions: PortfolioCashPosition[],
  options: MarketRefreshOptions = {},
): Promise<PortfolioCashPosition[]> {
  return mapWithConcurrency(
    positions,
    marketPriceConcurrency(),
    async (position) => {
      const fx = await getFxRate(position.currency, options);
      return {
        ...position,
        fxToUsd: fx.rateToUsd,
        valueUsd: position.amount * fx.rateToUsd,
        fxAsOf: fx.asOf,
        fxStatus: fx.sourceStatus,
      };
    },
  );
}
