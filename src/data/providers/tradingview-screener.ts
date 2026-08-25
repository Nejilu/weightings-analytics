import { SOURCE_METRIC_DEFINITIONS, type MetricKey } from "@/domain/metrics";

const TRADINGVIEW_SCAN_URL = "https://scanner.tradingview.com/global/scan";
const IDENTITY_COLUMNS = ["name", "description", "sector"] as const;
const MISSING_RETRY_BATCH_SIZE = 25;
const DEFAULT_MISSING_RETRY_LIMIT = 100;

export interface TradingViewSecurityMetrics {
  symbol: string;
  ticker: string | null;
  description: string | null;
  sector: string | null;
  values: Partial<Record<MetricKey, number>>;
}

export interface TradingViewMetricsResult {
  observations: TradingViewSecurityMetrics[];
  missingSymbols: string[];
  failedSymbols: string[];
}

interface ScanResponse {
  data?: Array<{ s?: unknown; d?: unknown }>;
  error?: unknown;
}

function batchSize(): number {
  const configured = Number(process.env.TRADINGVIEW_BATCH_SIZE);
  return Number.isInteger(configured) && configured >= 25 && configured <= 1_000
    ? configured
    : 1_000;
}

function missingRetryLimit(): number {
  const configured = Number(process.env.TRADINGVIEW_MISSING_RETRY_LIMIT);
  return Number.isInteger(configured) && configured >= 0 && configured <= 500
    ? configured
    : DEFAULT_MISSING_RETRY_LIMIT;
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseTradingViewScanResponse(payload: unknown): TradingViewSecurityMetrics[] {
  if (!payload || typeof payload !== "object") throw new Error("TradingView returned an invalid response.");
  const response = payload as ScanResponse;
  if (!Array.isArray(response.data)) {
    const detail = typeof response.error === "string" ? `: ${response.error}` : "";
    throw new Error(`TradingView Screener response does not contain data${detail}.`);
  }
  return response.data.flatMap((row) => {
    if (typeof row.s !== "string" || !Array.isArray(row.d)) return [];
    const data = row.d;
    const values: Partial<Record<MetricKey, number>> = {};
    SOURCE_METRIC_DEFINITIONS.forEach((definition, index) => {
      const value = finiteNumber(data[IDENTITY_COLUMNS.length + index]);
      if (value !== undefined) values[definition.key] = value;
    });
    return [{
      symbol: row.s,
      ticker: typeof data[0] === "string" ? data[0] : null,
      description: typeof data[1] === "string" ? data[1] : null,
      sector: typeof data[2] === "string" ? data[2] : null,
      values,
    }];
  });
}

async function scanBatch(symbols: string[], fetcher: typeof fetch): Promise<TradingViewSecurityMetrics[]> {
  const response = await fetcher(TRADINGVIEW_SCAN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "WeightingsAnalytics/0.1 metrics research",
    },
    body: JSON.stringify({
      symbols: { tickers: symbols, query: { types: [] } },
      columns: [
        ...IDENTITY_COLUMNS,
        ...SOURCE_METRIC_DEFINITIONS.map((definition) => definition.tradingViewColumn),
      ],
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`TradingView Screener returned HTTP ${response.status}.`);
  }
  return parseTradingViewScanResponse(await response.json());
}

export async function fetchTradingViewMetrics(
  symbols: string[],
  fetcher: typeof fetch = fetch,
): Promise<TradingViewMetricsResult> {
  const requestedOrder = [...new Set(symbols)];
  const uniqueSymbols = requestedOrder.slice().sort();
  if (uniqueSymbols.length === 0) {
    return { observations: [], missingSymbols: [], failedSymbols: [] };
  }
  const groups = batches(uniqueSymbols, batchSize());
  const output: TradingViewSecurityMetrics[] = [];
  const failedGroups: string[][] = [];
  const errors: Error[] = [];
  let successfulBatches = 0;
  const concurrency = Math.min(3, groups.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < groups.length) {
      const index = next;
      next += 1;
      try {
        const batchOutput = await scanBatch(groups[index], fetcher);
        if (batchOutput.length === 0) {
          failedGroups.push(groups[index]);
          errors.push(new Error("TradingView Screener batch returned no observations."));
          continue;
        }
        output.push(...batchOutput);
        successfulBatches += 1;
      } catch (error) {
        failedGroups.push(groups[index]);
        errors.push(error instanceof Error ? error : new Error("TradingView Screener batch failed."));
      }
    }
  }));
  const observedBeforeRetry = new Set(output.map((observation) => observation.symbol));
  const retrySymbols = requestedOrder
    .filter((symbol) => !observedBeforeRetry.has(symbol))
    .slice(0, missingRetryLimit());
  if (retrySymbols.length > 0) {
    const retryGroups = batches(retrySymbols, MISSING_RETRY_BATCH_SIZE);
    const retryConcurrency = Math.min(3, retryGroups.length);
    let nextRetry = 0;
    await Promise.all(Array.from({ length: retryConcurrency }, async () => {
      while (true) {
        const index = nextRetry;
        nextRetry += 1;
        if (index >= retryGroups.length) return;
        try {
          const retryOutput = await scanBatch(retryGroups[index], fetcher);
          if (retryOutput.length === 0) {
            failedGroups.push(retryGroups[index]);
            errors.push(new Error("TradingView Screener retry returned no observations."));
            continue;
          }
          output.push(...retryOutput);
          successfulBatches += 1;
        } catch (error) {
          failedGroups.push(retryGroups[index]);
          errors.push(error instanceof Error ? error : new Error("TradingView Screener retry failed."));
        }
      }
    }));
  }
  if (successfulBatches === 0 && errors.length > 0) {
    throw new Error(
      `TradingView Screener unavailable for all batches: ${errors[0].message}`,
    );
  }
  const observedSymbols = new Set(output.map((observation) => observation.symbol));
  const failedSymbolSet = new Set(failedGroups.flat());
  const failedSymbols = uniqueSymbols.filter((symbol) =>
    !observedSymbols.has(symbol) && failedSymbolSet.has(symbol),
  );
  const missingSymbols = uniqueSymbols.filter((symbol) =>
    !observedSymbols.has(symbol) && !failedSymbolSet.has(symbol),
  );
  return {
    observations: output.sort((left, right) => left.symbol.localeCompare(right.symbol)),
    missingSymbols,
    failedSymbols,
  };
}
