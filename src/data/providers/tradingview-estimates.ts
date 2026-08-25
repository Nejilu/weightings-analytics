import WebSocket from "ws";

import type {
  EstimateSeriesPoint,
  SecurityEstimateSeries,
} from "@/domain/metrics";

const TRADINGVIEW_SOCKET_URL =
  "wss://data.tradingview.com/socket.io/websocket?from=symbols%2FNASDAQ-MSFT%2Fforecast-actuals-and-estimates%2F&type=chart";
const QUOTE_FIELDS = ["eps_estimates_fq_h", "lp", "currency_code"] as const;
const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 25_000;

interface RawEstimate {
  average?: unknown;
  date?: unknown;
  est_num?: unknown;
}

interface RawEstimatePoint {
  FiscalPeriod?: unknown;
  IsReported?: unknown;
  Estimate?: RawEstimate | null;
}

interface RawQuoteValues {
  eps_estimates_fq_h?: unknown;
  lp?: unknown;
  currency_code?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoDateFromUnixSeconds(value: number | undefined): string | null {
  if (value === undefined) return null;
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function sessionId(): string {
  return `qs_${Math.random().toString(36).slice(2, 14)}`;
}

function frame(method: string, params: unknown[]): string {
  const payload = JSON.stringify({ m: method, p: params });
  return `~m~${payload.length}~m~${payload}`;
}

export function parseTradingViewFrames(raw: string): string[] {
  const output: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    if (!raw.startsWith("~m~", cursor)) break;
    const lengthEnd = raw.indexOf("~m~", cursor + 3);
    if (lengthEnd < 0) break;
    const length = Number(raw.slice(cursor + 3, lengthEnd));
    if (!Number.isInteger(length) || length < 0) break;
    const start = lengthEnd + 3;
    output.push(raw.slice(start, start + length));
    cursor = start + length;
  }
  return output;
}

function parsePoint(value: unknown): EstimateSeriesPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as RawEstimatePoint;
  const estimate = finiteNumber(point.Estimate?.average);
  if (
    typeof point.FiscalPeriod !== "string" ||
    point.FiscalPeriod.trim().length === 0 ||
    typeof point.IsReported !== "boolean" ||
    estimate === undefined
  ) return null;
  const estimateDate = finiteNumber(point.Estimate?.date);
  const analystCount = finiteNumber(point.Estimate?.est_num);
  return {
    fiscalPeriod: point.FiscalPeriod.trim(),
    estimate,
    isHistorical: point.IsReported,
    estimateDate: isoDateFromUnixSeconds(estimateDate),
    analystCount: analystCount === undefined ? null : Math.round(analystCount),
  };
}

export function parseTradingViewEstimateSeries(
  providerSymbol: string,
  value: unknown,
): SecurityEstimateSeries | null {
  if (!value || typeof value !== "object") return null;
  const quote = value as RawQuoteValues;
  const price = finiteNumber(quote.lp);
  if (
    price === undefined ||
    price <= 0 ||
    typeof quote.currency_code !== "string" ||
    quote.currency_code.trim().length === 0 ||
    !Array.isArray(quote.eps_estimates_fq_h)
  ) return null;

  const parsed = quote.eps_estimates_fq_h.flatMap((point) => {
    const result = parsePoint(point);
    return result ? [result] : [];
  });
  const historical = parsed.filter((point) => point.isHistorical).slice(-4);
  const forward = parsed.filter((point) => !point.isHistorical).slice(0, 4);
  if (historical.length !== 4 || forward.length !== 4) return null;
  const points = [...historical, ...forward];
  if (new Set(points.map((point) => point.fiscalPeriod)).size !== points.length) {
    return null;
  }

  return {
    providerSymbol,
    currency: quote.currency_code.trim(),
    price,
    points,
  };
}

function configuredBatchSize(): number {
  const configured = Number(process.env.TRADINGVIEW_ESTIMATES_BATCH_SIZE);
  return Number.isInteger(configured) && configured >= 25 && configured <= 500
    ? configured
    : DEFAULT_BATCH_SIZE;
}

function configuredConcurrency(): number {
  const configured = Number(process.env.TRADINGVIEW_ESTIMATES_CONCURRENCY);
  return Number.isInteger(configured) && configured >= 1 && configured <= 4
    ? configured
    : DEFAULT_CONCURRENCY;
}

function batches<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

type EstimateBatchFetcher = (
  symbols: string[],
) => Promise<SecurityEstimateSeries[]>;

export interface TradingViewEstimateSeriesResult {
  series: SecurityEstimateSeries[];
  missingSymbols: string[];
  failedSymbols: string[];
  batchCount: number;
  completedBatchCount: number;
  nonEmptyBatchCount: number;
  failedBatchCount: number;
}

async function fetchBatch(
  symbols: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SecurityEstimateSeries[]> {
  return new Promise((resolve, reject) => {
    const quoteSession = sessionId();
    const socket = new WebSocket(TRADINGVIEW_SOCKET_URL, {
      origin: "https://www.tradingview.com",
      headers: { "User-Agent": "WeightingsAnalytics/0.1 estimates research" },
    });
    const valuesBySymbol = new Map<string, RawQuoteValues>();
    const completed = new Set<string>();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(symbols.flatMap((symbol) => {
        const series = parseTradingViewEstimateSeries(symbol, valuesBySymbol.get(symbol));
        return series ? [series] : [];
      }));
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(
        valuesBySymbol.size > 0
          ? "TradingView estimate stream timed out after partial data."
          : "TradingView estimate stream timed out without data.",
      ));
    }, timeoutMs);

    socket.on("open", () => {
      socket.send(frame("set_auth_token", ["unauthorized_user_token"]));
      socket.send(frame("quote_create_session", [quoteSession]));
      socket.send(frame("quote_set_fields", [quoteSession, ...QUOTE_FIELDS]));
      socket.send(frame("quote_add_symbols", [quoteSession, ...symbols]));
    });
    socket.on("message", (event) => {
      for (const message of parseTradingViewFrames(String(event))) {
        if (message.startsWith("~h~")) {
          socket.send(`~m~${message.length}~m~${message}`);
          continue;
        }
        try {
          const parsed = JSON.parse(message) as { m?: string; p?: unknown[] };
          if (parsed.m === "qsd" && Array.isArray(parsed.p)) {
            const update = parsed.p[1] as { n?: unknown; v?: unknown } | undefined;
            if (typeof update?.n === "string" && update.v && typeof update.v === "object") {
              valuesBySymbol.set(update.n, {
                ...valuesBySymbol.get(update.n),
                ...(update.v as RawQuoteValues),
              });
            }
          } else if (parsed.m === "quote_completed" && Array.isArray(parsed.p)) {
            const symbol = parsed.p[1];
            if (typeof symbol === "string") completed.add(symbol);
            if (completed.size >= symbols.length) finish();
          }
        } catch {
          // TradingView also emits protocol messages that are not JSON payloads.
        }
      }
    });
    socket.on("error", (error) => {
      fail(error instanceof Error ? error : new Error("TradingView estimate stream failed."));
    });
    socket.on("close", () => {
      fail(new Error(
        valuesBySymbol.size > 0
          ? "TradingView estimate stream closed after partial data."
          : "TradingView estimate stream closed before completion.",
      ));
    });
  });
}

export async function fetchTradingViewEstimateSeriesDetailed(
  symbols: string[],
  batchFetcher: EstimateBatchFetcher = fetchBatch,
): Promise<TradingViewEstimateSeriesResult> {
  const uniqueSymbols = [...new Set(symbols)].sort();
  if (uniqueSymbols.length === 0) {
    return {
      series: [],
      missingSymbols: [],
      failedSymbols: [],
      batchCount: 0,
      completedBatchCount: 0,
      nonEmptyBatchCount: 0,
      failedBatchCount: 0,
    };
  }
  const groups = batches(uniqueSymbols, configuredBatchSize());
  const output: SecurityEstimateSeries[] = [];
  const errors: Error[] = [];
  const failedGroups: string[][] = [];
  let completedBatches = 0;
  let nonEmptyBatches = 0;
  const concurrency = Math.min(configuredConcurrency(), groups.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < groups.length) {
      const index = next;
      next += 1;
      try {
        const batchOutput = await batchFetcher(groups[index]);
        completedBatches += 1;
        if (batchOutput.length === 0) {
          // A valid TradingView response can contain no EPS consensus series
          // for an exchange or security. Keep that as a coverage gap rather
          // than treating it like a provider outage; the service can still
          // use Screener metrics and report estimates-partial.
          continue;
        }
        output.push(...batchOutput);
        nonEmptyBatches += 1;
      } catch (error) {
        failedGroups.push(groups[index]);
        errors.push(error instanceof Error ? error : new Error("TradingView estimate batch failed."));
      }
    }
  }));
  if (completedBatches === 0 && errors.length > 0) {
    throw new Error(
      `TradingView estimates unavailable for all batches: ${errors[0].message}`,
    );
  }
  const series = output.sort((left, right) => left.providerSymbol.localeCompare(right.providerSymbol));
  const observedSymbols = new Set(series.map((item) => item.providerSymbol));
  const failedSymbolSet = new Set(failedGroups.flat());
  return {
    series,
    missingSymbols: uniqueSymbols.filter((symbol) =>
      !observedSymbols.has(symbol) && !failedSymbolSet.has(symbol),
    ),
    failedSymbols: uniqueSymbols.filter((symbol) =>
      !observedSymbols.has(symbol) && failedSymbolSet.has(symbol),
    ),
    batchCount: groups.length,
    completedBatchCount: completedBatches,
    nonEmptyBatchCount: nonEmptyBatches,
    failedBatchCount: failedGroups.length,
  };
}

export async function fetchTradingViewEstimateSeries(
  symbols: string[],
  batchFetcher: EstimateBatchFetcher = fetchBatch,
): Promise<SecurityEstimateSeries[]> {
  return (await fetchTradingViewEstimateSeriesDetailed(symbols, batchFetcher)).series;
}
