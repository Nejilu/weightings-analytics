import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";

import {
  DERIVED_METRIC_KEYS,
  METRIC_DEFINITIONS,
  SOURCE_METRIC_DEFINITIONS,
  type MetricKey,
  type SecurityEstimateSeries,
  type SecurityMetricValues,
} from "@/domain/metrics";
import { isValidEstimateSeries } from "@/domain/metrics-cache";

import { databasePath, getDb, getSqlite } from "../client";
import {
  metricDefinitions,
  metricObservations,
  providerNegativeCache,
  securityProviderSymbols,
} from "../schema";

const QUERY_BATCH_SIZE = 250;
const ESTIMATE_SERIES_DEFINITION_ID = "security:eps_estimate_series:v1";
const ESTIMATE_SERIES_KEY = "eps_estimate_series";
const TRADINGVIEW_PROVIDER = "tradingview";

export type ProviderNegativeCacheKind = "estimate_series" | "source_metric";

export interface ProviderNegativeCacheEntry {
  provider: string;
  cacheKind: ProviderNegativeCacheKind;
  providerSymbol: string;
  metricKey: string;
  expiresAt: number;
}

const globalMetricsState = globalThis as typeof globalThis & {
  __weightingsAnalyticsMetricDefinitionsReady?: Set<string>;
};
const METRIC_DEFINITIONS_CACHE_VERSION = JSON.stringify({
  definitions: METRIC_DEFINITIONS,
  estimateSeries: {
    id: ESTIMATE_SERIES_DEFINITION_ID,
    key: ESTIMATE_SERIES_KEY,
    description: "Four historical event-consensus EPS observations and four current forward quarterly consensus observations; reported EPS is excluded.",
  },
});
const EXPECTED_METRIC_DEFINITION_IDS = [
  ...METRIC_DEFINITIONS.map((definition) => `security:${definition.key}:v1`),
  ESTIMATE_SERIES_DEFINITION_ID,
];
const SOURCE_METRIC_KEYS = new Set(
  SOURCE_METRIC_DEFINITIONS.map((definition) => definition.key),
);

function batches<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += QUERY_BATCH_SIZE) {
    result.push(items.slice(index, index + QUERY_BATCH_SIZE));
  }
  return result;
}

export function loadProviderNegativeCache(
  now = Date.now(),
): ProviderNegativeCacheEntry[] {
  return getDb()
    .select({
      provider: providerNegativeCache.provider,
      cacheKind: providerNegativeCache.cacheKind,
      providerSymbol: providerNegativeCache.providerSymbol,
      metricKey: providerNegativeCache.metricKey,
      expiresAt: providerNegativeCache.expiresAt,
    })
    .from(providerNegativeCache)
    .where(and(
      eq(providerNegativeCache.provider, TRADINGVIEW_PROVIDER),
      gt(providerNegativeCache.expiresAt, now),
    ))
    .all()
    .filter((entry): entry is ProviderNegativeCacheEntry =>
      (entry.cacheKind === "estimate_series" || entry.cacheKind === "source_metric") &&
      typeof entry.providerSymbol === "string" &&
      entry.providerSymbol.length > 0 &&
      typeof entry.metricKey === "string" &&
      Number.isInteger(entry.expiresAt) &&
      entry.expiresAt > now,
    );
}

export function pruneExpiredProviderNegativeCache(now = Date.now()): void {
  getDb()
    .delete(providerNegativeCache)
    .where(lte(providerNegativeCache.expiresAt, now))
    .run();
}

export function saveProviderNegativeCacheBatch(
  inputs: readonly ProviderNegativeCacheEntry[],
): void {
  if (inputs.length === 0) return;
  const updatedAt = new Date().toISOString();
  const db = getDb();
  db.transaction((transaction) => {
    for (const batch of batches([...inputs])) {
      transaction.insert(providerNegativeCache)
        .values(batch.map((input) => ({
          provider: input.provider,
          cacheKind: input.cacheKind,
          providerSymbol: input.providerSymbol,
          metricKey: input.metricKey,
          expiresAt: input.expiresAt,
          updatedAt,
        })))
        .onConflictDoUpdate({
          target: [
            providerNegativeCache.provider,
            providerNegativeCache.cacheKind,
            providerNegativeCache.providerSymbol,
            providerNegativeCache.metricKey,
          ],
          set: {
            expiresAt: sql`excluded.expires_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .run();
    }
  });
}

export function deleteProviderNegativeCacheBatch(
  inputs: readonly Pick<ProviderNegativeCacheEntry, "provider" | "cacheKind" | "providerSymbol" | "metricKey">[],
): void {
  if (inputs.length === 0) return;
  const db = getDb();
  db.transaction((transaction) => {
    for (const input of inputs) {
      transaction.delete(providerNegativeCache)
        .where(and(
          eq(providerNegativeCache.provider, input.provider),
          eq(providerNegativeCache.cacheKind, input.cacheKind),
          eq(providerNegativeCache.providerSymbol, input.providerSymbol),
          eq(providerNegativeCache.metricKey, input.metricKey),
        ))
        .run();
    }
  });
}

export interface ProviderSymbolRecord {
  securityId: string;
  providerSymbol: string | null;
  status: string;
  lastVerifiedAt: string;
  metadata: Record<string, unknown> | null;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface CachedSecurityMetrics extends SecurityMetricValues {
  capturedAt: string;
  observedKeys: Set<MetricKey>;
  sourceCapturedAtByKey: Map<MetricKey, string>;
  sourceProviderSymbolByKey: Map<MetricKey, string | null>;
}

export interface CachedEstimateSeries {
  series: SecurityEstimateSeries;
  capturedAt: string;
}

interface SecurityMetricObservationRow {
  securityId: string;
  definitionId: string;
  value: number | null;
  providerSymbol: string | null;
  capturedAt: string;
}

interface EstimateSeriesObservationRow {
  securityId: string;
  value: string | null;
  capturedAt: string;
}

export interface EstimateSeriesInput {
  securityId: string;
  series: SecurityEstimateSeries;
}

export interface ProviderSymbolInput {
  securityId: string;
  providerSymbol: string | null;
  status: "resolved" | "unresolved";
  confidence: number | null;
  metadata?: Record<string, unknown>;
  verifiedAt: string;
}

export interface SecurityMetricsInput {
  securityId: string;
  providerSymbol: string;
  values: Partial<Record<MetricKey, number>>;
}

export interface DerivedSecurityMetricsInput extends SecurityMetricsInput {
  capturedAt: string;
}

export function ensureMetricDefinitions(): void {
  const path = databasePath();
  const db = getDb();
  const readyKey = `${path}:${METRIC_DEFINITIONS_CACHE_VERSION}`;
  if (globalMetricsState.__weightingsAnalyticsMetricDefinitionsReady?.has(readyKey)) {
    const present = db
      .select({ id: metricDefinitions.id })
      .from(metricDefinitions)
      .where(inArray(metricDefinitions.id, EXPECTED_METRIC_DEFINITION_IDS))
      .all();
    if (present.length === EXPECTED_METRIC_DEFINITION_IDS.length) return;
    globalMetricsState.__weightingsAnalyticsMetricDefinitionsReady.delete(readyKey);
  }

  db.transaction((transaction) => {
    for (const definition of METRIC_DEFINITIONS) {
      transaction.insert(metricDefinitions)
        .values({
          id: `security:${definition.key}:v1`,
          key: definition.key,
          name: definition.name,
          description: definition.description,
          entityType: "security",
          valueType: "number",
          unit: definition.unit,
          frequency: "daily",
          version: 1,
          formulaJson: {
            provider: "tradingview",
            column: definition.tradingViewColumn,
            formula: definition.formula ?? null,
            aggregation: definition.aggregate
              ? `${definition.aggregation ?? "weighted_mean"}-renormalized-to-covered-weight`
              : "component-only",
            validRange: definition.validRange ?? null,
          },
        })
        .onConflictDoUpdate({
          target: metricDefinitions.id,
          set: {
            name: definition.name,
            description: definition.description,
            unit: definition.unit,
            formulaJson: sql`excluded.formula_json`,
          },
        })
        .run();
    }
    transaction.insert(metricDefinitions)
      .values({
        id: ESTIMATE_SERIES_DEFINITION_ID,
        key: ESTIMATE_SERIES_KEY,
        name: "Quarterly EPS consensus estimate series",
        description: "Four historical event-consensus EPS observations and four current forward quarterly consensus observations; reported EPS is excluded.",
        entityType: "security",
        valueType: "json",
        unit: "currency_per_share",
        frequency: "daily",
        version: 1,
        formulaJson: {
          provider: "tradingview",
          quoteField: "eps_estimates_fq_h",
          priceField: "lp",
          actualFieldUsed: false,
        },
      })
      .onConflictDoUpdate({
        target: metricDefinitions.id,
        set: {
          description: "Four historical event-consensus EPS observations and four current forward quarterly consensus observations; reported EPS is excluded.",
          formulaJson: sql`excluded.formula_json`,
        },
      })
      .run();
  });
  (globalMetricsState.__weightingsAnalyticsMetricDefinitionsReady ??= new Set()).add(readyKey);
}

export function loadLatestEstimateSeries(securityIds: string[]): Map<string, CachedEstimateSeries> {
  if (securityIds.length === 0) return new Map();
  const sqlite = getSqlite();
  const rows = batches(securityIds).flatMap((batch) => {
    const placeholders = batch.map(() => "?").join(",");
    const statement = sqlite.prepare(`
      SELECT
        entity_id AS securityId,
        value_json AS value,
        captured_at AS capturedAt
      FROM metric_observations
      WHERE metric_definition_id = ?
        AND entity_type = 'security'
        AND entity_id IN (${placeholders})
    `);
    return statement.all(ESTIMATE_SERIES_DEFINITION_ID, ...batch) as EstimateSeriesObservationRow[];
  });
  const output = new Map<string, CachedEstimateSeries>();
  for (const row of rows) {
    let value: unknown;
    try {
      value = row.value ? JSON.parse(row.value) : null;
    } catch {
      continue;
    }
    if (!isValidEstimateSeries(value)) continue;
    const previous = output.get(row.securityId);
    // The latest index supplies the rows without a global sort. Keep the
    // newest valid series explicitly; an invalid recent payload must not hide
    // an older usable series.
    if (!previous || row.capturedAt > previous.capturedAt) {
      output.set(row.securityId, { series: value, capturedAt: row.capturedAt });
    }
  }
  return output;
}

export function saveEstimateSeriesBatch(
  inputs: EstimateSeriesInput[],
  capturedAt: string,
): void {
  if (inputs.length === 0) return;
  const asOf = capturedAt.slice(0, 10);
  const db = getDb();
  db.transaction((transaction) => {
    for (const batch of batches(inputs)) {
      transaction.insert(metricObservations)
        .values(batch.map((input) => ({
          id: randomUUID(),
          metricDefinitionId: ESTIMATE_SERIES_DEFINITION_ID,
          entityType: "security" as const,
          entityId: input.securityId,
          asOf,
          valueText: input.series.providerSymbol,
          valueJson: input.series,
          source: "tradingview-quote-estimates",
          capturedAt,
        })))
        .onConflictDoUpdate({
          target: [
            metricObservations.metricDefinitionId,
            metricObservations.entityType,
            metricObservations.entityId,
            metricObservations.asOf,
          ],
          set: {
            valueText: sql`excluded.value_text`,
            valueJson: sql`excluded.value_json`,
            source: sql`excluded.source`,
            capturedAt: sql`excluded.captured_at`,
          },
        })
        .run();
    }
  });
}

export function saveEstimateSeries(
  securityId: string,
  series: SecurityEstimateSeries,
  capturedAt: string,
): void {
  saveEstimateSeriesBatch([{ securityId, series }], capturedAt);
}

export function loadProviderSymbols(securityIds: string[]): Map<string, ProviderSymbolRecord> {
  const records = securityIds.length === 0
    ? []
    : batches(securityIds).flatMap((batch) => getDb()
        .select({
          securityId: securityProviderSymbols.securityId,
          providerSymbol: securityProviderSymbols.providerSymbol,
          status: securityProviderSymbols.status,
          lastVerifiedAt: securityProviderSymbols.lastVerifiedAt,
          metadata: securityProviderSymbols.metadataJson,
        })
        .from(securityProviderSymbols)
        .where(and(
          eq(securityProviderSymbols.provider, "tradingview"),
          inArray(securityProviderSymbols.securityId, batch),
        ))
        .all());
  return new Map(records.map((record) => [record.securityId, {
    ...record,
    metadata: metadataRecord(record.metadata),
  }]));
}

export function saveProviderSymbolsBatch(inputs: ProviderSymbolInput[]): void {
  if (inputs.length === 0) return;
  const db = getDb();
  db.transaction((transaction) => {
    for (const batch of batches(inputs)) {
      transaction.insert(securityProviderSymbols)
        .values(batch.map((input) => ({
          provider: "tradingview" as const,
          securityId: input.securityId,
          providerSymbol: input.providerSymbol,
          status: input.status,
          confidence: input.confidence,
          lastVerifiedAt: input.verifiedAt,
          metadataJson: input.metadata ?? null,
        })))
        .onConflictDoUpdate({
          target: [securityProviderSymbols.provider, securityProviderSymbols.securityId],
          set: {
            providerSymbol: sql`excluded.provider_symbol`,
            status: sql`excluded.status`,
            confidence: sql`excluded.confidence`,
            lastVerifiedAt: sql`excluded.last_verified_at`,
            metadataJson: sql`excluded.metadata_json`,
          },
        })
        .run();
    }
  });
}

export function saveProviderSymbol(input: ProviderSymbolInput): void {
  saveProviderSymbolsBatch([input]);
}

function loadSecurityMetricRows(
  securityIds: string[],
  metricDefinitionIds: string[],
): SecurityMetricObservationRow[] {
  const sqlite = getSqlite();
  const definitionPlaceholders = metricDefinitionIds.map(() => "?").join(",");
  return batches(securityIds).flatMap((batch) => {
    const securityPlaceholders = batch.map(() => "?").join(",");
    const statement = sqlite.prepare(`
      SELECT
        entity_id AS securityId,
        metric_definition_id AS definitionId,
        value_number AS value,
        value_text AS providerSymbol,
        captured_at AS capturedAt
      FROM metric_observations
      WHERE entity_type = 'security'
        AND entity_id IN (${securityPlaceholders})
        AND metric_definition_id IN (${definitionPlaceholders})
      ORDER BY captured_at DESC
    `);
    return statement.all(...batch, ...metricDefinitionIds) as SecurityMetricObservationRow[];
  });
}

export function loadLatestSecurityMetrics(
  securityIds: string[],
): Map<string, CachedSecurityMetrics> {
  if (securityIds.length === 0) return new Map();
  const metricDefinitionIds = METRIC_DEFINITIONS.map((definition) => `security:${definition.key}:v1`);
  const metricKeyByDefinitionId = new Map(
    METRIC_DEFINITIONS.map((definition) => [`security:${definition.key}:v1`, definition.key]),
  );
  // This read is the hottest SQLite path in Metrics Overview. Keep the exact
  // filters/order of the Drizzle query, but avoid rebuilding the ORM statement
  // and mapping its result object for every security batch.
  const rows = loadSecurityMetricRows(securityIds, metricDefinitionIds);

  const result = new Map<string, CachedSecurityMetrics>();
  for (const row of rows) {
    const key = metricKeyByDefinitionId.get(row.definitionId);
    if (!key) continue;
    const isDerivedMetric = DERIVED_METRIC_KEYS.includes(key as typeof DERIVED_METRIC_KEYS[number]);
    if (!isDerivedMetric &&
      (typeof row.value !== "number" || !Number.isFinite(row.value))) {
      // A Screener response may omit a source metric. Do not let a newer NULL
      // row hide an older usable observation; its older timestamp will still
      // make the source eligible for refresh.
      continue;
    }
    const existing = result.get(row.securityId) ?? {
      securityId: row.securityId,
      providerSymbol: row.providerSymbol ?? "",
      values: {},
      // This timestamp drives the Screener TTL, so derived EPS/P-E rows must
      // not make an older source observation look fresh.
      capturedAt: "",
      observedKeys: new Set<MetricKey>(),
      sourceCapturedAtByKey: new Map<MetricKey, string>(),
      sourceProviderSymbolByKey: new Map<MetricKey, string | null>(),
    };
    if (existing.observedKeys.has(key)) continue;
    existing.observedKeys.add(key);
    if (typeof row.value === "number" && Number.isFinite(row.value)) {
      existing.values[key] = row.value;
    }
    if (SOURCE_METRIC_KEYS.has(key) && row.capturedAt > existing.capturedAt) {
      existing.capturedAt = row.capturedAt;
    }
    if (SOURCE_METRIC_KEYS.has(key)) {
      existing.sourceCapturedAtByKey.set(key, row.capturedAt);
      existing.sourceProviderSymbolByKey.set(key, row.providerSymbol);
    }
    if (!existing.providerSymbol && row.providerSymbol) existing.providerSymbol = row.providerSymbol;
    result.set(row.securityId, existing);
  }
  return result;
}

export function saveSecurityMetricsBatch(
  inputs: SecurityMetricsInput[],
  capturedAt: string,
): void {
  if (inputs.length === 0) return;
  const asOf = capturedAt.slice(0, 10);
  const db = getDb();
  const rows = inputs.flatMap((input) => SOURCE_METRIC_DEFINITIONS.flatMap((definition) => {
    const value = input.values[definition.key];
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    return [{
      id: randomUUID(),
      metricDefinitionId: `security:${definition.key}:v1`,
      entityType: "security" as const,
      entityId: input.securityId,
      asOf,
      valueNumber: value,
      valueText: input.providerSymbol,
      source: "tradingview-screener",
      capturedAt,
    }];
  }));
  db.transaction((transaction) => {
    for (const batch of batches(rows)) {
      transaction.insert(metricObservations)
        .values(batch)
        .onConflictDoUpdate({
          target: [
            metricObservations.metricDefinitionId,
            metricObservations.entityType,
            metricObservations.entityId,
            metricObservations.asOf,
          ],
          set: {
            valueNumber: sql`excluded.value_number`,
            valueText: sql`excluded.value_text`,
            source: sql`excluded.source`,
            capturedAt: sql`excluded.captured_at`,
          },
        })
        .run();
    }
  });
}

export function saveSecurityMetrics(
  securityId: string,
  providerSymbol: string,
  values: Partial<Record<MetricKey, number>>,
  capturedAt: string,
): void {
  saveSecurityMetricsBatch([{ securityId, providerSymbol, values }], capturedAt);
}

export function saveDerivedSecurityMetricsBatch(
  inputs: DerivedSecurityMetricsInput[],
): void {
  if (inputs.length === 0) return;
  const db = getDb();
  const rows = inputs.flatMap((input) => DERIVED_METRIC_KEYS.map((key) => ({
    id: randomUUID(),
    metricDefinitionId: `security:${key}:v1`,
    entityType: "security" as const,
    entityId: input.securityId,
    asOf: input.capturedAt.slice(0, 10),
    valueNumber: input.values[key] ?? null,
    valueText: input.providerSymbol,
    source: "tradingview-estimates-derived-v1",
    capturedAt: input.capturedAt,
  })));
  db.transaction((transaction) => {
    for (const batch of batches(rows)) {
      transaction.insert(metricObservations)
        .values(batch)
        .onConflictDoUpdate({
          target: [
            metricObservations.metricDefinitionId,
            metricObservations.entityType,
            metricObservations.entityId,
            metricObservations.asOf,
          ],
          set: {
            valueNumber: sql`excluded.value_number`,
            valueText: sql`excluded.value_text`,
            source: sql`excluded.source`,
            capturedAt: sql`excluded.captured_at`,
          },
        })
        .run();
    }
  });
}

export function saveDerivedSecurityMetrics(
  securityId: string,
  providerSymbol: string,
  values: Partial<Record<MetricKey, number>>,
  capturedAt: string,
): void {
  saveDerivedSecurityMetricsBatch([{ securityId, providerSymbol, values, capturedAt }]);
}
