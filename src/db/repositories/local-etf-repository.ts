import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { EtfShareClass } from "@/domain/etf";
import type { EtfCreatorCriteria } from "@/domain/etf-creator";
import {
  dynamicCreatorDescription,
  type CreatorSelectedSecurity,
} from "@/domain/etf-creator";
import type { Holding } from "@/domain/etf";
import type { PortfolioCashPosition, PortfolioItem } from "@/domain/portfolio";

import { getDb } from "../client";
import {
  benchmarks,
  etfs,
  holdings,
  holdingSnapshots,
  marketPrices,
  metricObservations,
  portfolioCashPositions,
  portfolioItems,
  portfolios,
  securities,
} from "../schema";
import { findEtfById } from "./catalog-repository";

interface LocalEtfIdentityInput {
  id: string;
  ticker: string;
  name: string;
  description: string;
}

interface LocalEtfDefinitionRecord {
  id: string;
  fundType: string;
  portfolioId: string | null;
  metadataJson: unknown;
}

interface DynamicCustomEtfDefinition {
  sourceEtfId: string;
  sourceTicker: string;
  selectedSecurities: CreatorSelectedSecurity[];
  criteria?: EtfCreatorCriteria;
  editableDescription: string;
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function selectedSecuritiesFromMetadata(
  value: unknown,
): CreatorSelectedSecurity[] {
  if (!Array.isArray(value)) return [];
  const selected = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.securityId !== "string" ||
      !record.securityId.trim() ||
      typeof record.ticker !== "string"
    ) return [];
    return [{
      securityId: record.securityId.trim(),
      ticker: record.ticker.trim() || "—",
    }];
  });
  return selected.filter(
    (security, index) =>
      selected.findIndex(
        (candidate) => candidate.securityId === security.securityId,
      ) === index,
  );
}

export function findLocalEtfDefinitionRecord(
  id: string,
): LocalEtfDefinitionRecord | undefined {
  return getDb()
    .select({
      id: etfs.id,
      fundType: etfs.fundType,
      portfolioId: etfs.portfolioId,
      metadataJson: etfs.metadataJson,
    })
    .from(etfs)
    .where(eq(etfs.id, id))
    .get();
}

export function findDynamicCustomEtfDefinition(
  id: string,
): DynamicCustomEtfDefinition | undefined {
  const record = findLocalEtfDefinitionRecord(id);
  if (!record || record.fundType !== "custom") return undefined;
  const metadata = metadataObject(record.metadataJson);
  const sourceEtfId = typeof metadata.sourceEtfId === "string"
    ? metadata.sourceEtfId.trim()
    : "";
  if (!sourceEtfId) return undefined;

  let selectedSecurities = selectedSecuritiesFromMetadata(
    metadata.selectedSecurities,
  );
  if (selectedSecurities.length === 0) {
    const anchor = getDb()
      .select({ id: holdingSnapshots.id })
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.etfId, id))
      .orderBy(asc(holdingSnapshots.fetchedAt), asc(holdingSnapshots.asOf))
      .limit(1)
      .get();
    if (anchor) {
      selectedSecurities = getDb()
        .select({
          securityId: holdings.securityId,
          ticker: holdings.sourceTicker,
          primaryTicker: securities.primaryTicker,
        })
        .from(holdings)
        .innerJoin(securities, eq(holdings.securityId, securities.id))
        .where(eq(holdings.snapshotId, anchor.id))
        .all()
        .map((holding) => ({
          securityId: holding.securityId,
          ticker: holding.ticker ?? holding.primaryTicker ?? "—",
        }));
    }
  }
  if (selectedSecurities.length === 0) return undefined;

  return {
    sourceEtfId,
    sourceTicker:
      typeof metadata.sourceTicker === "string" && metadata.sourceTicker.trim()
        ? metadata.sourceTicker.trim()
        : findEtfById(sourceEtfId)?.ticker ?? sourceEtfId,
    selectedSecurities,
    criteria:
      metadata.criteria && typeof metadata.criteria === "object"
        ? metadata.criteria as EtfCreatorCriteria
        : undefined,
    editableDescription:
      typeof metadata.editableDescription === "string"
        ? metadata.editableDescription
        : "",
  };
}

export function migrateCustomEtfDefinitions(): number {
  const db = getDb();
  const customRows = db
    .select({
      id: etfs.id,
      metadataJson: etfs.metadataJson,
    })
    .from(etfs)
    .where(eq(etfs.fundType, "custom"))
    .all();
  const dynamicDefinitionIds = new Set<string>();
  const upgrades = customRows.flatMap((row) => {
    const definition = findDynamicCustomEtfDefinition(row.id);
    if (!definition) return [];
    dynamicDefinitionIds.add(row.id);
    const metadata = metadataObject(row.metadataJson);
    const alreadyDynamic =
      metadata.compositionModel === "dynamic-source-free-float" &&
      selectedSecuritiesFromMetadata(metadata.selectedSecurities).length > 0;
    if (alreadyDynamic) return [];
    return [{ row, definition, metadata }];
  });

  const snapshotRows = dynamicDefinitionIds.size > 0
    ? db
        .select({
          id: holdingSnapshots.id,
          etfId: holdingSnapshots.etfId,
          sourceHash: holdingSnapshots.sourceHash,
        })
        .from(holdingSnapshots)
        .all()
        .filter((snapshot) => dynamicDefinitionIds.has(snapshot.etfId))
    : [];
  const etfsWithDynamicSnapshots = new Set(
    snapshotRows
      .filter(
        (snapshot) =>
          snapshot.sourceHash && !snapshot.sourceHash.startsWith("frozen:"),
      )
      .map((snapshot) => snapshot.etfId),
  );
  const obsoleteFrozenSnapshotIds = snapshotRows
    .filter(
      (snapshot) =>
        snapshot.sourceHash?.startsWith("frozen:") &&
        etfsWithDynamicSnapshots.has(snapshot.etfId),
    )
    .map((snapshot) => snapshot.id);

  if (upgrades.length === 0 && obsoleteFrozenSnapshotIds.length === 0) return 0;

  const now = new Date().toISOString();
  db.transaction((transaction) => {
    for (const { row, definition, metadata } of upgrades) {
      const retainedMetadata = { ...metadata };
      delete retainedMetadata.frozenAt;
      transaction
        .update(etfs)
        .set({
          description: dynamicCreatorDescription(
            definition.editableDescription,
            definition.selectedSecurities.length,
            definition.sourceTicker,
          ),
          metadataJson: {
            ...retainedMetadata,
            compositionModel: "dynamic-source-free-float",
            sourceEtfId: definition.sourceEtfId,
            sourceTicker: definition.sourceTicker,
            selectedCount: definition.selectedSecurities.length,
            selectedSecurities: definition.selectedSecurities,
            recalculation: "on-read",
            definitionUpdatedAt: now,
          },
          updatedAt: now,
        })
        .where(eq(etfs.id, row.id))
        .run();
    }
    if (obsoleteFrozenSnapshotIds.length > 0) {
      transaction
        .delete(holdings)
        .where(inArray(holdings.snapshotId, obsoleteFrozenSnapshotIds))
        .run();
      transaction
        .delete(holdingSnapshots)
        .where(inArray(holdingSnapshots.id, obsoleteFrozenSnapshotIds))
        .run();
    }
  });
  return upgrades.length;
}

interface ReplaceCustomEtfInput extends LocalEtfIdentityInput {
  sourceEtfId: string;
  sourceTicker: string;
  sourceAsOf: string;
  sourceFetchedAt: string;
  sourceUrl: string;
  criteria: EtfCreatorCriteria;
  selectedSecurities: CreatorSelectedSecurity[];
  selectedHoldings: Holding[];
  editableDescription: string;
}

interface ReplacePortfolioEtfInput extends LocalEtfIdentityInput {
  portfolioId: string;
  items: PortfolioItem[];
  cashPositions: PortfolioCashPosition[];
  editableDescription: string;
}

export function replaceCustomEtfRecord(
  input: ReplaceCustomEtfInput,
): EtfShareClass | undefined {
  const db = getDb();
  const existing = findLocalEtfDefinitionRecord(input.id);
  if (!existing || existing.fundType !== "custom") return undefined;
  const snapshotId = randomUUID();
  const now = new Date().toISOString();
  const sourceHash = `dynamic:${input.sourceEtfId}:${input.sourceAsOf}:${snapshotId}`;

  db.transaction((transaction) => {
    const previousSnapshots = transaction
      .select({ id: holdingSnapshots.id })
      .from(holdingSnapshots)
      .where(eq(holdingSnapshots.etfId, input.id))
      .all();
    const previousSnapshotIds = previousSnapshots.map((snapshot) => snapshot.id);

    if (previousSnapshotIds.length > 0) {
      transaction
        .delete(holdings)
        .where(inArray(holdings.snapshotId, previousSnapshotIds))
        .run();
    }
    transaction
      .delete(holdingSnapshots)
      .where(eq(holdingSnapshots.etfId, input.id))
      .run();

    const batchSize = 75;
    for (let index = 0; index < input.selectedHoldings.length; index += batchSize) {
      transaction
        .insert(securities)
        .values(
          input.selectedHoldings.slice(index, index + batchSize).map((holding) => ({
            id: holding.securityId,
            isin: holding.isin,
            primaryTicker: holding.ticker === "—" ? null : holding.ticker,
            name: holding.name,
            assetClass: holding.assetClass,
            sector: holding.sector,
            country: holding.country,
            currency: holding.currency,
          })),
        )
        .onConflictDoUpdate({
          target: securities.id,
          set: {
            isin: sql`excluded.isin`,
            primaryTicker: sql`excluded.primary_ticker`,
            name: sql`excluded.name`,
            assetClass: sql`excluded.asset_class`,
            sector: sql`excluded.sector`,
            country: sql`excluded.country`,
            currency: sql`excluded.currency`,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          },
        })
        .run();
    }
    transaction
      .insert(holdingSnapshots)
      .values({
        id: snapshotId,
        etfId: input.id,
        asOf: input.sourceAsOf,
        fetchedAt: now,
        sourceUrl: input.sourceUrl,
        sourceHash,
        sourceStatus: "cached",
        totalWeight: input.selectedHoldings.reduce(
          (sum, holding) => sum + holding.weight,
          0,
        ),
        rowCount: input.selectedHoldings.length,
        rawMetadataJson: {
          dynamic: true,
          sourceEtfId: input.sourceEtfId,
          sourceAsOf: input.sourceAsOf,
        },
      })
      .run();

    for (let index = 0; index < input.selectedHoldings.length; index += batchSize) {
      transaction
        .insert(holdings)
        .values(
          input.selectedHoldings.slice(index, index + batchSize).map((holding) => ({
            snapshotId,
            securityId: holding.securityId,
            weight: holding.weight,
            marketValue: null,
            currency: holding.currency,
            sourceTicker: holding.ticker === "—" ? null : holding.ticker,
            sourceRowJson: {
              sourceEtfId: input.sourceEtfId,
              sourceAsOf: input.sourceAsOf,
              dynamic: true,
            },
          })),
        )
        .run();
    }

    transaction
      .update(etfs)
      .set({
        ticker: input.ticker,
        name: input.name,
        description: input.description,
        metadataJson: {
          compositionModel: "dynamic-source-free-float",
          sourceEtfId: input.sourceEtfId,
          sourceTicker: input.sourceTicker,
          sourceAsOf: input.sourceAsOf,
          sourceFetchedAt: input.sourceFetchedAt,
          selectedCount: input.selectedSecurities.length,
          selectedSecurities: input.selectedSecurities,
          criteria: input.criteria,
          editableDescription: input.editableDescription,
          recalculation: "on-read",
          definitionUpdatedAt: now,
        },
        updatedAt: now,
      })
      .where(eq(etfs.id, input.id))
      .run();
  });

  return findEtfById(input.id);
}

export function replacePortfolioEtfRecord(
  input: ReplacePortfolioEtfInput,
): EtfShareClass | undefined {
  const db = getDb();
  const existing = findLocalEtfDefinitionRecord(input.id);
  if (
    !existing ||
    existing.fundType !== "portfolio" ||
    existing.portfolioId !== input.portfolioId
  ) return undefined;
  const now = new Date().toISOString();

  db.transaction((transaction) => {
    transaction
      .delete(portfolioItems)
      .where(eq(portfolioItems.portfolioId, input.portfolioId))
      .run();
    transaction
      .delete(portfolioCashPositions)
      .where(eq(portfolioCashPositions.portfolioId, input.portfolioId))
      .run();

    if (input.items.length > 0) {
      transaction
        .insert(portfolioItems)
        .values(
          input.items.map((item) => ({
            id: randomUUID(),
            portfolioId: input.portfolioId,
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
    }
    if (input.cashPositions.length > 0) {
      transaction
        .insert(portfolioCashPositions)
        .values(
          input.cashPositions.map((position) => ({
            portfolioId: input.portfolioId,
            currency: position.currency,
            amount: position.amount,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
    }

    transaction
      .update(portfolios)
      .set({ name: input.name, updatedAt: now })
      .where(eq(portfolios.id, input.portfolioId))
      .run();
    transaction
      .update(etfs)
      .set({
        ticker: input.ticker,
        name: input.name,
        description: input.description,
        metadataJson: {
          compositionModel: "relational-look-through",
          componentCount: input.items.length,
          cashCurrencies: input.cashPositions.map((position) => position.currency),
          recalculation: "on-read",
          editableDescription: input.editableDescription,
        },
        updatedAt: now,
      })
      .where(eq(etfs.id, input.id))
      .run();
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
      transaction
        .delete(portfolioCashPositions)
        .where(eq(portfolioCashPositions.portfolioId, existing.portfolioId))
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
