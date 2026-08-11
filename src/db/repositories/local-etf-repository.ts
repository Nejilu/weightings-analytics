import { and, eq, inArray, sql } from "drizzle-orm";

import type { EtfShareClass } from "@/domain/etf";

import { getDb } from "../client";
import {
  benchmarks,
  etfs,
  holdings,
  holdingSnapshots,
  marketPrices,
  metricObservations,
  portfolioItems,
  portfolios,
  securities,
} from "../schema";
import { findEtfById } from "./catalog-repository";

export interface UpdateLocalEtfInput {
  id: string;
  ticker: string;
  name: string;
  description: string;
}

export function updateLocalEtfRecord(
  input: UpdateLocalEtfInput,
): EtfShareClass | undefined {
  const db = getDb();
  const existing = db
    .select({ portfolioId: etfs.portfolioId })
    .from(etfs)
    .where(eq(etfs.id, input.id))
    .get();
  if (!existing) return undefined;

  db.transaction((transaction) => {
    transaction
      .update(etfs)
      .set({
        ticker: input.ticker,
        name: input.name,
        description: input.description || null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(etfs.id, input.id))
      .run();

    if (existing.portfolioId) {
      transaction
        .update(portfolios)
        .set({
          name: input.name,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(portfolios.id, existing.portfolioId))
        .run();
    }
  });

  return findEtfById(input.id);
}

export function deleteLocalEtfRecord(id: string): boolean {
  const db = getDb();
  const existing = db
    .select({
      id: etfs.id,
      benchmarkId: etfs.benchmarkId,
      fundType: etfs.fundType,
      portfolioId: etfs.portfolioId,
    })
    .from(etfs)
    .where(eq(etfs.id, id))
    .get();

  if (
    !existing ||
    (existing.fundType !== "custom" && existing.fundType !== "portfolio")
  ) {
    return false;
  }

  db.transaction((transaction) => {
    const snapshots = transaction
      .select({ id: holdingSnapshots.id })
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.etfId, id))
      .all();
    const snapshotIds = snapshots.map((snapshot) => snapshot.id);
    const cleanupSecurityIds = new Set<string>();

    if (snapshotIds.length > 0) {
      for (const row of transaction
        .selectDistinct({ id: holdings.securityId })
        .from(holdings)
        .where(inArray(holdings.snapshotId, snapshotIds))
        .all()) {
        cleanupSecurityIds.add(row.id);
      }
      transaction
        .delete(holdings)
        .where(inArray(holdings.snapshotId, snapshotIds))
        .run();
    }
    transaction
      .delete(holdingSnapshots)
      .where(eq(holdingSnapshots.etfId, id))
      .run();
    transaction.delete(portfolioItems).where(eq(portfolioItems.etfId, id)).run();

    if (existing.portfolioId) {
      for (const row of transaction
        .selectDistinct({ id: portfolioItems.securityId })
        .from(portfolioItems)
        .where(eq(portfolioItems.portfolioId, existing.portfolioId))
        .all()) {
        if (row.id) cleanupSecurityIds.add(row.id);
      }
      transaction
        .delete(portfolioItems)
        .where(eq(portfolioItems.portfolioId, existing.portfolioId))
        .run();
    }

    transaction
      .delete(marketPrices)
      .where(
        and(
          eq(marketPrices.assetType, "etf"),
          eq(marketPrices.assetId, id),
        ),
      )
      .run();
    transaction
      .delete(metricObservations)
      .where(
        and(
          eq(metricObservations.entityType, "etf"),
          eq(metricObservations.entityId, id),
        ),
      )
      .run();
    transaction.delete(etfs).where(eq(etfs.id, id)).run();

    if (existing.portfolioId) {
      transaction
        .delete(portfolios)
        .where(eq(portfolios.id, existing.portfolioId))
        .run();
    }

    const cleanupCandidates = [...cleanupSecurityIds];
    const orphanSecurityRows =
      cleanupCandidates.length === 0
        ? []
        : transaction
            .select({ id: securities.id })
            .from(securities)
            .where(
              and(
                inArray(securities.id, cleanupCandidates),
                sql`
                  NOT EXISTS (
                    SELECT 1 FROM ${holdings}
                    WHERE ${holdings.securityId} = ${securities.id}
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM ${portfolioItems}
                    WHERE ${portfolioItems.securityId} = ${securities.id}
                  )
                `,
              ),
            )
            .all();
    const orphanSecurityIds = orphanSecurityRows.map((security) => security.id);

    if (orphanSecurityIds.length > 0) {
      transaction
        .delete(marketPrices)
        .where(
          and(
            eq(marketPrices.assetType, "security"),
            inArray(marketPrices.assetId, orphanSecurityIds),
          ),
        )
        .run();
      transaction
        .delete(metricObservations)
        .where(
          and(
            eq(metricObservations.entityType, "security"),
            inArray(metricObservations.entityId, orphanSecurityIds),
          ),
        )
        .run();
      transaction
        .delete(securities)
        .where(inArray(securities.id, orphanSecurityIds))
        .run();
    }

    const remainingBenchmarkEtf = transaction
      .select({ id: etfs.id })
      .from(etfs)
      .where(eq(etfs.benchmarkId, existing.benchmarkId))
      .limit(1)
      .get();
    if (!remainingBenchmarkEtf) {
      transaction
        .delete(benchmarks)
        .where(eq(benchmarks.id, existing.benchmarkId))
        .run();
    }
  });

  return true;
}
