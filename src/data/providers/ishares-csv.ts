import type { Holding } from "@/domain/etf";
import {
  fallbackSecurityId,
  preferredSecurityId,
} from "@/domain/security-identity";

// Bump this prefix whenever the normalization changes in a way that must be
// re-applied to snapshots already persisted from the same provider payload.
export const ISHARES_HOLDINGS_HASH_PREFIX = "ishares-holdings-v3:";

interface ParsedHoldingsFile {
  asOf: string;
  holdings: Holding[];
}

interface BlackrockDataPoint {
  value?: unknown;
  formattedValue?: unknown;
}

interface BlackrockHoldingsResponse {
  componentsByNameMap?: {
    holdings?: {
      containersByNameMap?: {
        all?: {
          dataPointsByNameMap?: Record<string, BlackrockDataPoint>;
        };
      };
    };
  };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value.trim());
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (value || row.length) {
    row.push(value.trim());
    rows.push(row);
  }
  return rows;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== "string" || !value) return 0;
  const normalized = value.replace(/[%,$\s]/g, "").replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findColumn(headers: string[], candidates: string[]) {
  const normalized = headers.map((header) => header.toLowerCase().trim());
  return normalized.findIndex((header) =>
    candidates.some((candidate) => header === candidate.toLowerCase()),
  );
}

function valueAt(row: string[], index: number, fallback = "") {
  return index >= 0 ? row[index] || fallback : fallback;
}

function blackrockValueAt(
  values: unknown[] | undefined,
  index: number,
  fallback = "",
): string {
  const value = values?.[index];
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

function parseDate(rows: string[][]): string {
  const metadata = rows.find((row) =>
    row[0]?.toLowerCase().includes("holdings as of"),
  );
  const value = metadata?.[1];
  if (!value) return new Date().toISOString().slice(0, 10);
  const dayFirst = value.match(/^(\d{1,2})[/-]([A-Za-z]{3})[/-](\d{4})$/);
  const monthFirst = value.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  const months = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const parts = dayFirst
    ? {
        day: Number(dayFirst[1]),
        month: months.indexOf(dayFirst[2].toLowerCase()) + 1,
        year: Number(dayFirst[3]),
      }
    : monthFirst
      ? {
          day: Number(monthFirst[2]),
          month: months.indexOf(monthFirst[1].toLowerCase()) + 1,
          year: Number(monthFirst[3]),
        }
      : null;
  if (parts && parts.month > 0) {
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? new Date().toISOString().slice(0, 10)
    : parsed.toISOString().slice(0, 10);
}

function parseBlackrockDate(value: unknown): string {
  const raw = String(value ?? "");
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return parseDate([["Fund Holdings as of", raw]]);
}

function deduplicateHoldings(parsedHoldings: Holding[]): Holding[] {
  const holdingsBySecurity = new Map<string, Holding>();
  for (const holding of parsedHoldings) {
    const existing = holdingsBySecurity.get(holding.securityId);
    if (!existing) {
      holdingsBySecurity.set(holding.securityId, holding);
      continue;
    }

    existing.weight += holding.weight;
    if (holding.marketValue !== undefined) {
      existing.marketValue =
        (existing.marketValue ?? 0) + holding.marketValue;
    }
  }
  return [...holdingsBySecurity.values()];
}

function parseBlackrockProductData(raw: string): ParsedHoldingsFile {
  let parsed: BlackrockHoldingsResponse;
  try {
    parsed = JSON.parse(raw) as BlackrockHoldingsResponse;
  } catch {
    throw new Error("Unable to parse the BlackRock holdings response.");
  }

  const dataPoints =
    parsed.componentsByNameMap?.holdings?.containersByNameMap?.all
      ?.dataPointsByNameMap;
  const arrayValue = (name: string): unknown[] | undefined => {
    const value = dataPoints?.[name]?.value;
    return Array.isArray(value) ? value : undefined;
  };
  const tickers = arrayValue("ticker");
  const names = arrayValue("issueName");
  const weights = arrayValue("holdingPercent") ?? arrayValue("marketWeight");
  if (!tickers || !names || !weights) {
    throw new Error("The BlackRock holdings response contains no holdings.");
  }

  const sectors = arrayValue("sectorName");
  const assetClasses = arrayValue("assetClass");
  const countries = arrayValue("countryOfRisk");
  const isins = arrayValue("isin");
  const cusips = arrayValue("cusip");
  const sedols = arrayValue("sedol");
  const currencies = arrayValue("currencyCode");
  const marketCurrencies = arrayValue("marketCurrencyCode");
  const exchanges = arrayValue("exchange");
  const marketValues = arrayValue("marketValue") ?? arrayValue("ceMarketValue");
  const rowCount = Math.max(tickers.length, names.length, weights.length);

  const parsedHoldings = Array.from(
    { length: rowCount },
    (_, index): Holding | null => {
      const name = blackrockValueAt(names, index);
      const ticker = blackrockValueAt(tickers, index, "—");
      const weight = toNumber(weights[index]);
      const marketValue = toNumber(marketValues?.[index]);
      const isin = blackrockValueAt(isins, index);
      const cusip = blackrockValueAt(cusips, index);
      const sedol = blackrockValueAt(sedols, index);
      if (!name || (weight <= 0 && marketValue <= 0)) return null;

      return {
        securityId: preferredSecurityId({
          securityId: fallbackSecurityId(name, ticker),
          isin,
          cusip,
          sedol,
        }),
        ticker,
        name,
        sector: blackrockValueAt(sectors, index, "Unclassified"),
        assetClass: blackrockValueAt(assetClasses, index, "Unclassified"),
        country: blackrockValueAt(countries, index, "Not reported"),
        isin: isin || undefined,
        weight,
        marketValue: marketValue || undefined,
        currency:
          blackrockValueAt(currencies, index) ||
          blackrockValueAt(marketCurrencies, index) ||
          undefined,
        exchange: blackrockValueAt(exchanges, index) || undefined,
        cusip: cusip || undefined,
        sedol: sedol || undefined,
      };
    },
  ).filter((holding): holding is Holding => holding !== null);

  const holdings = deduplicateHoldings(parsedHoldings);
  if (holdings.length < 5) {
    throw new Error(
      "The BlackRock holdings response does not contain enough holdings.",
    );
  }

  const asOf = dataPoints?.asOfDate?.value;
  if (asOf === undefined || asOf === null) {
    throw new Error("The BlackRock holdings response has no as-of date.");
  }
  return { asOf: parseBlackrockDate(asOf), holdings };
}

export function parseIsharesHoldingsCsv(raw: string): ParsedHoldingsFile {
  if (raw.trimStart().startsWith("{")) {
    return parseBlackrockProductData(raw);
  }

  const rows = parseCsv(raw.replace(/^\uFEFF/, ""));
  const headerIndex = rows.findIndex(
    (row) =>
      row.some((cell) => cell.toLowerCase().includes("weight")) &&
      row.some((cell) => cell.toLowerCase() === "name"),
  );

  if (headerIndex < 0) {
    throw new Error("Unable to locate the iShares file headers.");
  }

  const headers = rows[headerIndex];
  const tickerIndex = findColumn(headers, ["Ticker", "Issuer Ticker"]);
  const nameIndex = findColumn(headers, ["Name"]);
  const sectorIndex = findColumn(headers, ["Sector"]);
  const assetClassIndex = findColumn(headers, ["Asset Class"]);
  const weightIndex = findColumn(headers, ["Weight (%)", "Weight", "Market Weight"]);
  const marketValueIndex = findColumn(headers, ["Market Value"]);
  const countryIndex = findColumn(headers, ["Location", "Country"]);
  const isinIndex = findColumn(headers, ["ISIN"]);
  const cusipIndex = findColumn(headers, ["CUSIP"]);
  const sedolIndex = findColumn(headers, ["SEDOL"]);
  const currencyIndex = findColumn(headers, ["Currency", "Market Currency"]);
  const exchangeIndex = findColumn(headers, ["Exchange", "Market"]);

  const parsedHoldings = rows
    .slice(headerIndex + 1)
    .map((row): Holding | null => {
      const name = valueAt(row, nameIndex);
      const ticker = valueAt(row, tickerIndex, "—");
      const weight = toNumber(valueAt(row, weightIndex));
      const marketValue = toNumber(valueAt(row, marketValueIndex));
      const isin = valueAt(row, isinIndex);
      const cusip = valueAt(row, cusipIndex);
      const sedol = valueAt(row, sedolIndex);
      if (!name || (weight <= 0 && marketValue <= 0)) return null;

      return {
        securityId: preferredSecurityId({
          securityId: fallbackSecurityId(name, ticker),
          isin,
          cusip,
          sedol,
        }),
        ticker,
        name,
        sector: valueAt(row, sectorIndex, "Unclassified"),
        assetClass: valueAt(row, assetClassIndex, "Unclassified"),
        country: valueAt(row, countryIndex, "Not reported"),
        isin: isin || undefined,
        weight,
        marketValue: marketValue || undefined,
        currency: valueAt(row, currencyIndex) || undefined,
        exchange: valueAt(row, exchangeIndex) || undefined,
        cusip: cusip || undefined,
        sedol: sedol || undefined,
      };
    })
    .filter((holding): holding is Holding => holding !== null);

  const holdings = deduplicateHoldings(parsedHoldings);

  if (holdings.length < 5) {
    throw new Error("The iShares file does not contain enough holdings.");
  }

  return { asOf: parseDate(rows), holdings };
}
