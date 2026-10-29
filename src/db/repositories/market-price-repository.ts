import { and, eq } from "drizzle-orm";

import type {
  FxRate,
  MarketPrice,
  PortfolioAssetKind,
} from "@/domain/portfolio";

import { getDb } from "../client";
import { fxRates, marketPrices } from "../schema";

type MarketPriceRow = typeof marketPrices.$inferSelect;

function mapRow(
  row: MarketPriceRow,
  sourceStatus: MarketPrice["sourceStatus"],
): MarketPrice {
  return {
    assetKind: row.assetType as PortfolioAssetKind,
    assetId: row.assetId,
    providerSymbol: row.providerSymbol,
    price: row.price,
    currency: row.currency,
    fxToUsd: row.fxToUsd,
    priceUsd: row.priceUsd,
    asOf: row.asOf,
    fetchedAt: row.fetchedAt,
    sourceStatus,
    source: row.source === "TradingView" ? "TradingView" : "Yahoo Finance",
    quoteSession: row.quoteMetadata?.session,
    delaySeconds: row.quoteMetadata?.delaySeconds,
  };
}

export function findMarketPrice(
  assetKind: PortfolioAssetKind,
  assetId: string,
): MarketPrice | undefined {
  const row = getDb()
    .select()
    .from(marketPrices)
    .where(
      and(
        eq(marketPrices.assetType, assetKind),
        eq(marketPrices.assetId, assetId),
      ),
    )
    .limit(1)
    .get();
  return row ? mapRow(row, "cached") : undefined;
}

export function persistMarketPrice(price: MarketPrice): MarketPrice {
  const id = `${price.assetKind}:${price.assetId}`;
  getDb()
    .insert(marketPrices)
    .values({
      id,
      assetType: price.assetKind,
      assetId: price.assetId,
      providerSymbol: price.providerSymbol,
      price: price.price,
      currency: price.currency,
      fxToUsd: price.fxToUsd,
      priceUsd: price.priceUsd,
      asOf: price.asOf,
      fetchedAt: price.fetchedAt,
      source: price.source ?? "Yahoo Finance",
      quoteMetadata: { session: price.quoteSession, delaySeconds: price.delaySeconds },
    })
    .onConflictDoUpdate({
      target: marketPrices.id,
      set: {
        providerSymbol: price.providerSymbol,
        price: price.price,
        currency: price.currency,
        fxToUsd: price.fxToUsd,
        priceUsd: price.priceUsd,
        asOf: price.asOf,
        fetchedAt: price.fetchedAt,
        source: price.source ?? "Yahoo Finance",
        quoteMetadata: { session: price.quoteSession, delaySeconds: price.delaySeconds },
      },
    })
    .run();

  return price;
}

export function findFxRate(currency: string): FxRate | undefined {
  const row = getDb()
    .select()
    .from(fxRates)
    .where(eq(fxRates.currency, currency))
    .limit(1)
    .get();
  return row
    ? {
        currency: row.currency,
        providerSymbol: row.providerSymbol,
        rateToUsd: row.rateToUsd,
        asOf: row.asOf,
        fetchedAt: row.fetchedAt,
        sourceStatus: "cached",
      }
    : undefined;
}

export function persistFxRate(rate: FxRate): FxRate {
  getDb()
    .insert(fxRates)
    .values({
      currency: rate.currency,
      providerSymbol: rate.providerSymbol,
      rateToUsd: rate.rateToUsd,
      asOf: rate.asOf,
      fetchedAt: rate.fetchedAt,
      source: "Yahoo Finance",
    })
    .onConflictDoUpdate({
      target: fxRates.currency,
      set: {
        providerSymbol: rate.providerSymbol,
        rateToUsd: rate.rateToUsd,
        asOf: rate.asOf,
        fetchedAt: rate.fetchedAt,
        source: "Yahoo Finance",
      },
    })
    .run();
  return rate;
}
