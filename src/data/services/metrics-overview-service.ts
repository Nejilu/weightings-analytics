import "server-only";

import { holdingsSourceIssues } from "@/domain/holdings-source-issues";
import { catalogRevision } from "@/server/site-runtime";
import type { MetricsOverviewResult } from "@/domain/metrics";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { databasePath } from "@/db/client";
import { findEtfByReference } from "@/db/repositories/catalog-repository";
import {
  canonicalizeEtfReferences as canonicalizeReferences,
  reorderEtfItems,
} from "@/domain/metrics-overview-request";
import { getHoldingsSnapshot, HoldingsUnavailableError } from "./holdings-service";
import { buildEtfMetricsOverview, uniqueEquityHoldings } from "./metrics-overview-model";
import {
  retrieveSecurityMetrics,
  providerOrUnavailable,
  MetricsOverviewUnavailableError,
  type MetricsRefreshOptions,
} from "./security-metrics-service";

export { MetricsOverviewUnavailableError, type MetricsRefreshOptions } from "./security-metrics-service";

const RESULT_CACHE_TTL_MS = 60_000;
const PARTIAL_RESULT_CACHE_TTL_MS = 5 * 60_000;
const STALE_RESULT_CACHE_TTL_MS = 60_000;
const RESULT_CACHE_MAX_ENTRIES = 8;
const MAX_INPUT_REFERENCES = 16;
const INVALID_SELECTION_MESSAGE = "Select between one and four ETFs.";
const inFlightRequests = new Map<string, Promise<MetricsOverviewResult>>();
const resultCache = new Map<string, {
  result: MetricsOverviewResult;
  expiresAt: number;
}>();

interface OverviewRefreshOptions extends MetricsRefreshOptions {
  onFundamentals?: (result: MetricsOverviewResult) => void;
}

function cacheResult(key: string, result: MetricsOverviewResult): void {
  resultCache.set(key, {
    result,
    expiresAt: Date.now() + (
      result.sourceStatus === "stale"
        ? STALE_RESULT_CACHE_TTL_MS
        : result.sourceStatus === "partial"
          ? PARTIAL_RESULT_CACHE_TTL_MS
          : RESULT_CACHE_TTL_MS
    ),
  });
  while (resultCache.size > RESULT_CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

function resultForOrder(
  result: MetricsOverviewResult,
  orderedEtfIds: readonly string[],
): MetricsOverviewResult {
  const etfs = reorderEtfItems(result.etfs, orderedEtfIds);
  return etfs.length === result.etfs.length ? { ...result, etfs } : result;
}

async function buildOverview(
  references: string[],
  options: OverviewRefreshOptions,
): Promise<MetricsOverviewResult> {
  try {
    ensureLocalDatabase();
  } catch (error) {
    throw new MetricsOverviewUnavailableError(error);
  }
  let etfs: ReturnType<typeof findEtfByReference>[];
  try {
    etfs = references.map((reference) => findEtfByReference(reference));
  } catch (error) {
    throw new MetricsOverviewUnavailableError(error);
  }
  if (etfs.some((etf) => !etf)) {
    throw new MetricsOverviewRequestError(
      "Invalid ETF selection. Use funds available in the catalog.",
    );
  }
  const snapshots = await providerOrUnavailable(
    () => Promise.all(
      references.map((reference) => getHoldingsSnapshot(reference, options)),
    ),
    (error) => error instanceof HoldingsUnavailableError,
  );
  const holdingsAreStale = snapshots.some((snapshot) => snapshot.sourceStatus === "stale");
  const { metricsBySecurity, resolvedSecurityIds, ...metadata } = await retrieveSecurityMetrics(
    uniqueEquityHoldings(snapshots), { ...options,
      onFundamentals: options.onFundamentals ? ({ metricsBySecurity, resolvedSecurityIds, ...metadata }) => {
        options.onFundamentals!({ ...metadata, holdingsSourceIssues: holdingsSourceIssues(snapshots),
          etfs: snapshots.map((snapshot) => buildEtfMetricsOverview(snapshot, resolvedSecurityIds, metricsBySecurity)) });
      } : undefined,
    }, holdingsAreStale,
  );
  return {
    ...metadata,
    holdingsSourceIssues: holdingsSourceIssues(snapshots),
    etfs: snapshots.map((snapshot) => buildEtfMetricsOverview(
      snapshot, resolvedSecurityIds, metricsBySecurity,
    )),
  };
}

export class MetricsOverviewRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsOverviewRequestError";
  }
}

export function getMetricsOverview(
  references: string[],
  options: OverviewRefreshOptions = {},
): Promise<MetricsOverviewResult> {
  if (references.length > MAX_INPUT_REFERENCES) {
    return Promise.reject(new MetricsOverviewRequestError(INVALID_SELECTION_MESSAGE));
  }
  let normalized: string[];
  try {
    ensureLocalDatabase();
    normalized = canonicalizeReferences(references, findEtfByReference);
  } catch (error) {
    return Promise.reject(new MetricsOverviewUnavailableError(error));
  }
  if (normalized.length < 1 || normalized.length > 4) {
    return Promise.reject(new MetricsOverviewRequestError(INVALID_SELECTION_MESSAGE));
  }
  const key = `${databasePath()}::${catalogRevision()}::${normalized.slice().sort().join("|")}`;
  if (!options.forceRefresh) {
    const cached = resultCache.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        resultCache.delete(key);
        resultCache.set(key, cached);
        return Promise.resolve(resultForOrder(cached.result, normalized));
      }
      resultCache.delete(key);
    }
  }
  const requestKey = `${key}::${options.forceRefresh ? "force" : "cached"}`;
  const existing = inFlightRequests.get(requestKey)
    ?? (!options.forceRefresh ? inFlightRequests.get(`${key}::force`) : undefined);
  if (existing) return existing.then((result) => resultForOrder(result, normalized));
  const request = buildOverview(normalized, options)
    .then((result) => {
      cacheResult(key, result);
      return result;
    })
    .finally(() => inFlightRequests.delete(requestKey));
  inFlightRequests.set(requestKey, request);
  return request;
}
