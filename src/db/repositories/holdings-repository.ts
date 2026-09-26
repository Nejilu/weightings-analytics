import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import type {
  DataStatus,
  EtfShareClass,
  Holding,
  HoldingsSnapshot,
} from "@/domain/etf";

import { getDb, getSqlite } from "../client";
import {
  canonicalizeHoldingsWithPersistedIdentities,
  reconcilePersistedSecurityIdentities,
} from "../security-identity-repository";
import {
  holdings,
  holdingSnapshots,
  securities,
} from "../schema";

type SnapshotRecord = typeof holdingSnapshots.$inferSelect;

function snapshotMetadata(snapshot: SnapshotRecord): Record<string, unknown> {
  return snapshot.rawMetadataJson && typeof snapshot.rawMetadataJson === "object"
    ? snapshot.rawMetadataJson as Record<string, unknown> : {};
}

export function recordSnapshotFailure(
  snapshot: SnapshotRecord,
  failure: { code: string; message: string },
): SnapshotRecord {
  const rawMetadataJson = { ...snapshotMetadata(snapshot), refreshFailure: failure };
  getDb().update(holdingSnapshots).set({ sourceStatus: "stale", rawMetadataJson })
    .where(eq(holdingSnapshots.id, snapshot.id)).run();
  return { ...snapshot, sourceStatus: "stale", rawMetadataJson };
}

function identifiersFromJson(value: unknown): {
  exchange?: string;
  cusip?: string;
  sedol?: string;
} {
  const candidate = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return undefined;
        }
      })()
    : value;
  if (!candidate || typeof candidate !== "object") return {};
  const record = candidate as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === "string" && record[key].trim()
      ? record[key] as string
      : undefined;
  return {
    exchange: text("exchange"),
    cusip: text("cusip"),
    sedol: text("sedol"),
  };
}

function holdingIdentifiers(holding: Holding): Record<string, string> | null {
  const entries = Object.entries({
    exchange: holding.exchange,
    cusip: holding.cusip,
    sedol: holding.sedol,
  }).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

const INSERT_BATCH_SIZE = 75;

function batches<T>(rows: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    result.push(rows.slice(index, index + INSERT_BATCH_SIZE));
  }
  return result;
}

export function findLatestSnapshot(
  etfId: string,
): SnapshotRecord | undefined {
  return getDb()
    .select()
    .from(holdingSnapshots)
    .where(eq(holdingSnapshots.etfId, etfId))
    .orderBy(
      desc(holdingSnapshots.fetchedAt),
      desc(holdingSnapshots.asOf),
    )
    .limit(1)
    .get();
}

export function loadSnapshot(
  etf: EtfShareClass,
  snapshot: SnapshotRecord,
  sourceStatus: DataStatus,
  cacheTtlHours: number,
): HoldingsSnapshot {
  const rows = getDb()
    .select({
      securityId: securities.id,
      ticker: holdings.sourceTicker,
      primaryTicker: securities.primaryTicker,
      name: securities.name,
      sector: securities.sector,
      assetClass: securities.assetClass,
      country: securities.country,
      isin: securities.isin,
      weight: holdings.weight,
      marketValue: holdings.marketValue,
      currency: holdings.currency,
      securityCurrency: securities.currency,
      identifiersJson: securities.identifiersJson,
    })
    .from(holdings)
    .innerJoin(
      securities,
      eq(holdings.securityId, securities.id),
    )
    .where(eq(holdings.snapshotId, snapshot.id))
    .all();

  return {
    etf,
    asOf: snapshot.asOf,
    fetchedAt: snapshot.fetchedAt,
    sourceStatus,
    sourceIssues: (() => {
      const failure = snapshotMetadata(snapshot).refreshFailure;
      if (sourceStatus !== "stale" || !failure || typeof failure !== "object") return undefined;
      const value = failure as Record<string, unknown>;
      return typeof value.code === "string" && typeof value.message === "string"
        ? [{ ticker: etf.ticker, asOf: snapshot.asOf, code: value.code, message: value.message }]
        : undefined;
    })(),
    sourceUrl: snapshot.sourceUrl,
    cacheTtlHours,
    holdings: rows.map((row) => {
      const identifiers = identifiersFromJson(row.identifiersJson);
      return {
        securityId: row.securityId,
        ticker: row.ticker ?? row.primaryTicker ?? "—",
        name: row.name,
        sector: row.sector ?? "Unclassified",
        assetClass: row.assetClass ?? "Unclassified",
        country: row.country ?? "Not reported",
        isin: row.isin ?? undefined,
        weight: row.weight,
        marketValue: row.marketValue ?? undefined,
        currency: row.currency ?? row.securityCurrency ?? undefined,
        exchange: identifiers.exchange,
        cusip: identifiers.cusip,
        sedol: identifiers.sedol,
      };
    }).sort((left, right) => right.weight - left.weight),
  };
}

interface PersistSnapshotInput {
  etf: EtfShareClass;
  asOf: string;
  fetchedAt: string;
  sourceUrl: string;
  sourceHash: string;
  holdings: Holding[];
}

export function persistSnapshot(
  input: PersistSnapshotInput,
): SnapshotRecord {
  const db = getDb();
  const totalWeight = input.holdings.reduce(
    (sum, holding) => sum + holding.weight,
    0,
  );

  return db.transaction((transaction) => {
    const existing = transaction
      .select()
      .from(holdingSnapshots)
      .where(
        and(
          eq(holdingSnapshots.etfId, input.etf.id),
          eq(holdingSnapshots.asOf, input.asOf),
          eq(holdingSnapshots.sourceHash, input.sourceHash),
        ),
      )
      .limit(1)
      .get();

    if (existing) {
      const metadata = { ...snapshotMetadata(existing) };
      delete metadata.refreshFailure;
      const rawMetadataJson = Object.keys(metadata).length ? metadata : null;
      transaction
        .update(holdingSnapshots)
        .set({
          fetchedAt: input.fetchedAt,
          sourceUrl: input.sourceUrl,
          sourceStatus: "live",
          rawMetadataJson,
          totalWeight,
          rowCount: input.holdings.length,
        })
        .where(eq(holdingSnapshots.id, existing.id))
        .run();

      return {
        ...existing,
        rawMetadataJson,
        fetchedAt: input.fetchedAt,
        sourceUrl: input.sourceUrl,
        sourceStatus: "live",
        totalWeight,
        rowCount: input.holdings.length,
      };
    }

    for (const batch of batches(input.holdings)) {
      transaction
        .insert(securities)
        .values(
          batch.map((holding) => ({
            id: holding.securityId,
            isin: holding.isin,
            primaryTicker:
              holding.ticker === "—" ? null : holding.ticker,
            name: holding.name,
            assetClass: holding.assetClass,
            sector: holding.sector,
            country: holding.country,
            currency: holding.currency,
            identifiersJson: holdingIdentifiers(holding),
          })),
        )
        .onConflictDoUpdate({
          target: securities.id,
          set: {
            isin: sql`COALESCE(excluded.isin, ${securities.isin})`,
            primaryTicker: sql`excluded.primary_ticker`,
            name: sql`excluded.name`,
            assetClass: sql`excluded.asset_class`,
            sector: sql`excluded.sector`,
            country: sql`excluded.country`,
            currency: sql`excluded.currency`,
            identifiersJson: sql`CASE
              WHEN excluded.identifiers_json IS NULL THEN ${securities.identifiersJson}
              WHEN ${securities.identifiersJson} IS NULL THEN excluded.identifiers_json
              ELSE json_patch(${securities.identifiersJson}, excluded.identifiers_json)
            END`,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          },
        })
        .run();
    }

    reconcilePersistedSecurityIdentities(getSqlite(), false);
    const canonicalHoldings = canonicalizeHoldingsWithPersistedIdentities(
      input.holdings,
      getSqlite(),
    );

    const id = randomUUID();
    const record: SnapshotRecord = {
      id,
      etfId: input.etf.id,
      asOf: input.asOf,
      fetchedAt: input.fetchedAt,
      sourceUrl: input.sourceUrl,
      sourceHash: input.sourceHash,
      sourceStatus: "live",
      totalWeight,
      rowCount: canonicalHoldings.length,
      rawMetadataJson: null,
    };

    transaction.insert(holdingSnapshots).values(record).run();

    for (const batch of batches(canonicalHoldings)) {
      transaction
        .insert(holdings)
        .values(
          batch.map((holding) => ({
            snapshotId: id,
            securityId: holding.securityId,
            weight: holding.weight,
            marketValue: holding.marketValue,
            currency: holding.currency,
            sourceTicker:
              holding.ticker === "—" ? null : holding.ticker,
          })),
        )
        .run();
    }

    return record;
  });
}
