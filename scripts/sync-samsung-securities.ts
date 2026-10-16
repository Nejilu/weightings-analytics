import "dotenv/config";

import { SUPPORTED_INDIVIDUAL_SECURITIES } from "../src/data/supported-individual-securities";
import { closeDatabase, databasePath, getDb } from "../src/db/client";
import { migrateDatabase } from "../src/db/migrate";
import { seedSupportedIndividualSecurities } from "../src/db/supported-securities";
import { saveProviderSymbolsBatch } from "../src/db/repositories/metrics-repository";
import { SAMSUNG_GDRS } from "../src/domain/samsung-securities";

// Verify the actual instrument (including ISIN), before changing the catalogue
// or recording a resolved provider mapping. Repeat runs keep the same IDs.
const response = await fetch("https://scanner.tradingview.com/global/scan", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({
    symbols: { tickers: SAMSUNG_GDRS.map((gdr) => gdr.tradingViewSymbol), query: { types: [] } },
    columns: ["name", "description", "isin", "currency", "type"],
  }),
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`TradingView returned HTTP ${response.status}. No mappings written.`);
const payload = await response.json() as { data?: Array<{ s: string; d: unknown[] }> };
const mappings = SAMSUNG_GDRS.map((gdr) => {
  const row = payload.data?.find((candidate) => candidate.s === gdr.tradingViewSymbol);
  if (!row || row.d[0] !== gdr.ticker || row.d[2] !== gdr.isin
    || row.d[3] !== "USD" || row.d[4] !== "dr"
    || typeof row.d[1] !== "string" || !/samsung electronics/i.test(row.d[1])) {
    throw new Error(`TradingView identity mismatch for ${gdr.tradingViewSymbol}. No mappings written.`);
  }
  return { gdr, description: row.d[1] };
});

try {
  migrateDatabase();
  getDb().transaction((transaction) => seedSupportedIndividualSecurities(transaction,
    SUPPORTED_INDIVIDUAL_SECURITIES.filter((security) => SAMSUNG_GDRS.some((gdr) => gdr.isin === security.securityId))));
  const verifiedAt = new Date().toISOString();
  saveProviderSymbolsBatch(mappings.map(({ gdr, description }) => ({
    securityId: gdr.isin,
    providerSymbol: gdr.tradingViewSymbol,
    status: "resolved",
    confidence: 1,
    verifiedAt,
    metadata: {
      ticker: gdr.ticker,
      exchange: "London Stock Exchange",
      description,
      isin: gdr.isin,
      currency: "USD",
      instrumentType: "GDR",
      underlyingSecurityId: gdr.underlyingSecurityId,
      underlyingSharesPerReceipt: gdr.underlyingSharesPerReceipt,
      mappingProvenance: "confirmed_alias",
      mappingScore: 1,
      alternativesTested: 1,
      candidatePosition: 0,
      candidateProvenance: [{ symbol: gdr.tradingViewSymbol, provenance: "confirmed_alias" }],
      sourceUrl: `https://www.tradingview.com/symbols/${gdr.tradingViewSymbol.replace(":", "-")}/`,
    },
  })));
  console.log(JSON.stringify({
    database: databasePath(), verifiedAt,
    mappings: mappings.map(({ gdr }) => ({
      isin: gdr.isin, symbol: gdr.tradingViewSymbol,
      underlyingTicker: gdr.underlyingTicker, underlyingSharesPerReceipt: gdr.underlyingSharesPerReceipt,
    })),
  }, null, 2));
} finally {
  closeDatabase();
}
