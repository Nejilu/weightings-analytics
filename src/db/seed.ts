import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { ETF_CATALOG } from "../data/catalog";
import { SUPPORTED_INDIVIDUAL_SECURITIES } from "../data/supported-individual-securities";
import { getDb } from "./client";
import { migrateCustomEtfDefinitions } from "./repositories/local-etf-repository";
import { reconcilePersistedSecurityIdentities } from "./security-identity-repository";
import {
  benchmarks,
  etfs,
  holdingSnapshots,
  holdings,
  marketPrices,
  portfolioItems,
  portfolios,
  securities,
} from "./schema";

const RETIRED_ETF_IDS = [
  "iwm-us",
  "iusn-ucits",
] as const;
const RETIRED_BENCHMARK_ID = "russell-2000";

export function seedCatalog(): void {
  const db = getDb();

  db.transaction((transaction) => {
    const retiredSnapshots = transaction
      .select({ id: holdingSnapshots.id })
      .from(holdingSnapshots)
      .where(inArray(holdingSnapshots.etfId, RETIRED_ETF_IDS))
      .all();
    if (retiredSnapshots.length > 0) {
      transaction
        .delete(holdings)
        .where(
          inArray(
            holdings.snapshotId,
            retiredSnapshots.map((snapshot) => snapshot.id),
          ),
        )
        .run();
    }

    const affectedPortfolios = transaction
      .select({ portfolioId: portfolioItems.portfolioId })
      .from(portfolioItems)
      .where(inArray(portfolioItems.etfId, RETIRED_ETF_IDS))
      .all();
    transaction
      .delete(portfolioItems)
      .where(inArray(portfolioItems.etfId, RETIRED_ETF_IDS))
      .run();
    transaction
      .delete(marketPrices)
      .where(
        and(
          eq(marketPrices.assetType, "etf"),
          inArray(marketPrices.assetId, RETIRED_ETF_IDS),
        ),
      )
      .run();
    transaction
      .delete(holdingSnapshots)
      .where(inArray(holdingSnapshots.etfId, RETIRED_ETF_IDS))
      .run();
    transaction.delete(etfs).where(inArray(etfs.id, RETIRED_ETF_IDS)).run();
    transaction
      .delete(benchmarks)
      .where(eq(benchmarks.id, RETIRED_BENCHMARK_ID))
      .run();

    for (const portfolioId of new Set(
      affectedPortfolios.map((row) => row.portfolioId),
    )) {
      if (portfolioId === "default-portfolio") continue;
      const hasRemainingComponent = transaction
        .select({ id: portfolioItems.id })
        .from(portfolioItems)
        .where(eq(portfolioItems.portfolioId, portfolioId))
        .limit(1)
        .get();
      if (hasRemainingComponent) continue;

      const emptySyntheticEtfs = transaction
        .select({ id: etfs.id })
        .from(etfs)
        .where(eq(etfs.portfolioId, portfolioId))
        .all();
      if (emptySyntheticEtfs.length > 0) {
        transaction
          .delete(marketPrices)
          .where(
            inArray(
              marketPrices.assetId,
              emptySyntheticEtfs.map((etf) => etf.id),
            ),
          )
          .run();
        transaction
          .delete(etfs)
          .where(
            inArray(
              etfs.id,
              emptySyntheticEtfs.map((etf) => etf.id),
            ),
          )
          .run();
      }
      transaction
        .delete(portfolios)
        .where(eq(portfolios.id, portfolioId))
        .run();
    }

    transaction
      .delete(securities)
      .where(
        and(
          notInArray(
            securities.id,
            SUPPORTED_INDIVIDUAL_SECURITIES.map((security) => security.securityId),
          ),
          sql`NOT EXISTS (
            SELECT 1 FROM ${holdings}
            WHERE ${holdings.securityId} = ${securities.id}
          ) AND NOT EXISTS (
            SELECT 1 FROM ${portfolioItems}
            WHERE ${portfolioItems.securityId} = ${securities.id}
          )`,
        ),
      )
      .run();

    for (const security of SUPPORTED_INDIVIDUAL_SECURITIES) {
      const values = {
        id: security.securityId,
        isin: security.isin ?? null,
        primaryTicker: security.ticker,
        name: security.name,
        assetClass: security.assetClass,
        sector: security.sector,
        country: security.country,
        currency: security.currency,
        identifiersJson: {
          exchange: security.exchange,
          ...(security.cusip ? { cusip: security.cusip } : {}),
          ...(security.sedol ? { sedol: security.sedol } : {}),
        },
      };
      transaction
        .insert(securities)
        .values(values)
        .onConflictDoUpdate({
          target: securities.id,
          set: {
            ...values,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          },
        })
        .run();
    }

    for (const benchmark of ETF_CATALOG) {
      transaction
        .insert(benchmarks)
        .values({
          id: benchmark.id,
          name: benchmark.name,
          provider: benchmark.provider,
          region: benchmark.region,
          description: benchmark.description,
        })
        .onConflictDoUpdate({
          target: benchmarks.id,
          set: {
            name: benchmark.name,
            provider: benchmark.provider,
            region: benchmark.region,
            description: benchmark.description,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          },
        })
        .run();

      for (const etf of benchmark.variants) {
        transaction
          .insert(etfs)
          .values({
            id: etf.id,
            ticker: etf.ticker,
            isin: etf.isin,
            name: etf.name,
            issuer: etf.issuer ?? "iShares",
            benchmarkId: etf.benchmarkId,
            wrapper: etf.wrapper,
            domicile: etf.domicile,
            exchange: etf.exchange,
            tradingCurrency: etf.tradingCurrency,
            distributionPolicy: etf.distributionPolicy,
            ter: etf.ter,
            productUrl: etf.productUrl,
            holdingsUrl: etf.holdingsUrl,
            priceSymbol:
              etf.priceSymbol ??
              (etf.wrapper === "UCITS" ? `${etf.ticker}.L` : etf.ticker),
            fundType: "physical",
            portfolioId: null,
            description: etf.description ?? null,
            active: true,
            metadataJson:
              etf.derivedHoldings ??
              (etf.holdingsSourceEtfId
                ? { holdingsSourceEtfId: etf.holdingsSourceEtfId }
                : null),
          })
          .onConflictDoUpdate({
            target: etfs.id,
            set: {
              ticker: etf.ticker,
              isin: etf.isin,
              name: etf.name,
              issuer: etf.issuer ?? "iShares",
              benchmarkId: etf.benchmarkId,
              wrapper: etf.wrapper,
              domicile: etf.domicile,
              exchange: etf.exchange,
              tradingCurrency: etf.tradingCurrency,
              distributionPolicy: etf.distributionPolicy,
              ter: etf.ter,
              productUrl: etf.productUrl,
              holdingsUrl: etf.holdingsUrl,
              priceSymbol:
                etf.priceSymbol ??
                (etf.wrapper === "UCITS" ? `${etf.ticker}.L` : etf.ticker),
              fundType: "physical",
              portfolioId: null,
              description: etf.description ?? null,
              active: true,
              metadataJson:
                etf.derivedHoldings ??
                (etf.holdingsSourceEtfId
                  ? { holdingsSourceEtfId: etf.holdingsSourceEtfId }
                  : null),
              updatedAt: sql`CURRENT_TIMESTAMP`,
            },
          })
          .run();
      }
    }
  });

  // Existing databases can contain weak NAME:* identities from older source
  // snapshots alongside newer ISIN-backed identities. Reconcile them on setup
  // so saved portfolios immediately share one canonical security row.
  reconcilePersistedSecurityIdentities();
  migrateCustomEtfDefinitions();
}
