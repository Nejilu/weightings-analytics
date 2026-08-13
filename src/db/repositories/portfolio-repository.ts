import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import type { EtfShareClass } from "@/domain/etf";
import type { PortfolioCashPosition, PortfolioItem } from "@/domain/portfolio";
import { securityQuoteAlias } from "@/domain/security-equivalence";

import { getDb } from "../client";
import {
  benchmarks,
  etfs,
  portfolioCashPositions,
  portfolioItems,
  portfolios,
  securities,
} from "../schema";

export const DEFAULT_PORTFOLIO_ID = "default-portfolio";

export interface StoredPortfolio {
  id: string;
  name: string;
  baseCurrency: string;
  updatedAt: string;
  items: PortfolioItem[];
  cashPositions: PortfolioCashPosition[];
}

function loadPortfolio(id: string): StoredPortfolio | undefined {
  const db = getDb();
  const portfolio = db
    .select()
    .from(portfolios)
    .where(eq(portfolios.id, id))
    .get();

  if (!portfolio) return undefined;

  const rows = db
    .select({
      id: portfolioItems.id,
      assetType: portfolioItems.assetType,
      allocationWeight: portfolioItems.allocationWeight,
      quantity: portfolioItems.quantity,
      inputMode: portfolioItems.inputMode,
      inputAmount: portfolioItems.inputAmount,
      initialPriceUsd: portfolioItems.initialPriceUsd,
      initialValueUsd: portfolioItems.initialValueUsd,
      itemPriceSymbol: portfolioItems.priceSymbol,
      itemPriceCurrency: portfolioItems.priceCurrency,
      etfId: portfolioItems.etfId,
      etfTicker: etfs.ticker,
      etfName: etfs.name,
      securityId: portfolioItems.securityId,
      securityTicker: securities.primaryTicker,
      securityName: securities.name,
    })
    .from(portfolioItems)
    .leftJoin(etfs, eq(portfolioItems.etfId, etfs.id))
    .leftJoin(securities, eq(portfolioItems.securityId, securities.id))
    .where(eq(portfolioItems.portfolioId, id))
    .orderBy(asc(portfolioItems.createdAt))
    .all();
  const cashRows = db
    .select({
      currency: portfolioCashPositions.currency,
      amount: portfolioCashPositions.amount,
    })
    .from(portfolioCashPositions)
    .where(eq(portfolioCashPositions.portfolioId, id))
    .orderBy(asc(portfolioCashPositions.currency))
    .all();

  return {
    id: portfolio.id,
    name: portfolio.name,
    baseCurrency: portfolio.baseCurrency,
    updatedAt: portfolio.updatedAt,
    items: rows.map((row) => {
      const kind = row.assetType === "security" ? "security" : "etf";
      const securityAlias =
        kind === "security"
          ? securityQuoteAlias({
              ticker: row.securityTicker ?? "",
              name: row.securityName ?? "",
            })
          : undefined;
      return {
        id: row.id,
        kind,
        referenceId:
          kind === "security" ? row.securityId ?? "" : row.etfId ?? "",
        ticker:
          kind === "security"
            ? securityAlias?.displayTicker ?? row.securityTicker ?? "—"
            : row.etfTicker ?? "—",
        name:
          kind === "security"
            ? row.securityName ?? "Unknown security"
            : row.etfName ?? "Unknown ETF",
        allocationWeight: row.allocationWeight,
        quantity: row.quantity ?? undefined,
        inputMode:
          row.inputMode === "shares" || row.inputMode === "value"
            ? row.inputMode
            : undefined,
        inputAmount: row.inputAmount ?? undefined,
        initialPriceUsd: row.initialPriceUsd ?? undefined,
        initialValueUsd: row.initialValueUsd ?? undefined,
        priceSymbol: row.itemPriceSymbol ?? undefined,
        priceCurrency: row.itemPriceCurrency ?? undefined,
      };
    }),
    cashPositions: cashRows.map((row) => ({
      currency: row.currency as PortfolioCashPosition["currency"],
      amount: row.amount,
    })),
  };
}

export function loadDefaultPortfolio(): StoredPortfolio {
  const db = getDb();
  db.insert(portfolios)
    .values({
      id: DEFAULT_PORTFOLIO_ID,
      name: "My portfolio",
      baseCurrency: "USD",
    })
    .onConflictDoNothing()
    .run();

  const portfolio = loadPortfolio(DEFAULT_PORTFOLIO_ID);
  if (!portfolio) {
    throw new Error("Unable to initialise the portfolio.");
  }
  return portfolio;
}

export function loadPortfolioById(id: string): StoredPortfolio | undefined {
  return loadPortfolio(id);
}

export function anchorPortfolioQuantities(
  portfolioId: string,
  items: PortfolioItem[],
) {
  const db = getDb();
  db.transaction((transaction) => {
    for (const item of items) {
      if (!item.quantity || !Number.isFinite(item.quantity)) continue;
      transaction
        .update(portfolioItems)
        .set({
          allocationWeight: item.allocationWeight,
          quantity: item.quantity,
          inputMode: item.inputMode ?? "shares",
          inputAmount: item.inputAmount ?? item.quantity,
          initialPriceUsd: item.initialPriceUsd ?? item.currentPriceUsd,
          initialValueUsd: item.initialValueUsd ?? item.currentValueUsd,
          priceSymbol: item.priceSymbol,
          priceCurrency: item.priceCurrency,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(portfolioItems.id, item.id),
            eq(portfolioItems.portfolioId, portfolioId),
          ),
        )
        .run();
    }
  });
}

export function replaceDefaultPortfolio(
  items: PortfolioItem[],
  cashPositions: PortfolioCashPosition[],
) {
  const db = getDb();

  db.transaction((transaction) => {
    transaction
      .insert(portfolios)
      .values({
        id: DEFAULT_PORTFOLIO_ID,
        name: "My portfolio",
        baseCurrency: "USD",
      })
      .onConflictDoUpdate({
        target: portfolios.id,
        set: { updatedAt: sql`CURRENT_TIMESTAMP` },
      })
      .run();

    transaction
      .delete(portfolioItems)
      .where(eq(portfolioItems.portfolioId, DEFAULT_PORTFOLIO_ID))
      .run();
    transaction
      .delete(portfolioCashPositions)
      .where(eq(portfolioCashPositions.portfolioId, DEFAULT_PORTFOLIO_ID))
      .run();

    if (items.length > 0) {
      transaction
        .insert(portfolioItems)
        .values(
          items.map((item) => ({
            id: item.id,
            portfolioId: DEFAULT_PORTFOLIO_ID,
            assetType: item.kind,
            etfId: item.kind === "etf" ? item.referenceId : null,
            securityId:
              item.kind === "security" ? item.referenceId : null,
            allocationWeight: item.allocationWeight,
            quantity: item.quantity,
            inputMode: item.inputMode,
            inputAmount: item.inputAmount,
            initialPriceUsd: item.initialPriceUsd,
            initialValueUsd: item.initialValueUsd,
            priceSymbol: item.priceSymbol,
            priceCurrency: item.priceCurrency,
          })),
        )
        .run();
    }
    if (cashPositions.length > 0) {
      transaction
        .insert(portfolioCashPositions)
        .values(
          cashPositions.map((position) => ({
            portfolioId: DEFAULT_PORTFOLIO_ID,
            currency: position.currency,
            amount: position.amount,
          })),
        )
        .run();
    }
  });
}

interface SavePortfolioAsEtfInput {
  ticker: string;
  name: string;
  description: string;
  editableDescription?: string;
}

export function saveDefaultPortfolioAsEtf(
  input: SavePortfolioAsEtfInput,
): EtfShareClass {
  const db = getDb();
  const source = loadDefaultPortfolio();
  const portfolioId = `saved-portfolio-${randomUUID()}`;
  const etfId = `portfolio-etf-${randomUUID()}`;
  const localIsin = `LOCAL-${randomUUID()}`;
  const now = new Date().toISOString();

  db.transaction((transaction) => {
    transaction
      .insert(benchmarks)
      .values({
        id: "saved-portfolios",
        name: "Saved portfolios",
        provider: "IndexLens",
        region: "Local workspace",
        description:
          "User-defined portfolios recalculated from their ETF sleeves and direct stocks.",
      })
      .onConflictDoNothing()
      .run();

    transaction
      .insert(portfolios)
      .values({
        id: portfolioId,
        name: input.name,
        baseCurrency: source.baseCurrency,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    transaction
      .insert(portfolioItems)
      .values(
        source.items.map((item) => ({
          id: randomUUID(),
          portfolioId,
          assetType: item.kind,
          etfId: item.kind === "etf" ? item.referenceId : null,
          securityId: item.kind === "security" ? item.referenceId : null,
          allocationWeight: item.allocationWeight,
          quantity: item.quantity,
          inputMode: item.inputMode,
          inputAmount: item.inputAmount,
          initialPriceUsd: item.initialPriceUsd,
          initialValueUsd: item.initialValueUsd,
          priceSymbol: item.priceSymbol,
          priceCurrency: item.priceCurrency,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run();

    if (source.cashPositions.length > 0) {
      transaction
        .insert(portfolioCashPositions)
        .values(
          source.cashPositions.map((position) => ({
            portfolioId,
            currency: position.currency,
            amount: position.amount,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
    }

    transaction
      .insert(etfs)
      .values({
        id: etfId,
        ticker: input.ticker,
        isin: localIsin,
        name: input.name,
        issuer: "IndexLens",
        benchmarkId: "saved-portfolios",
        wrapper: "SYNTHETIC",
        domicile: "Local workspace",
        exchange: "IndexLens",
        tradingCurrency: source.baseCurrency,
        distributionPolicy: "Look-through",
        ter: 0,
        productUrl: `/portfolio/${portfolioId}`,
        holdingsUrl: `local://portfolio/${portfolioId}`,
        priceSymbol: null,
        fundType: "portfolio",
        portfolioId,
        description: input.description,
        active: true,
        metadataJson: {
          compositionModel: "relational-look-through",
          componentCount: source.items.length,
          cashCurrencies: source.cashPositions.map((position) => position.currency),
          recalculation: "on-read",
          editableDescription: input.editableDescription ?? "",
        },
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  return {
    id: etfId,
    ticker: input.ticker,
    name: input.name,
    benchmarkId: "saved-portfolios",
    isin: localIsin,
    wrapper: "SYNTHETIC",
    domicile: "Local workspace",
    exchange: "IndexLens",
    tradingCurrency: source.baseCurrency,
    distributionPolicy: "Look-through",
    ter: 0,
    productUrl: `/portfolio/${portfolioId}`,
    holdingsUrl: `local://portfolio/${portfolioId}`,
    fundType: "portfolio",
    portfolioId,
    description: input.description,
  };
}
