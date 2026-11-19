import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { ANTHROPIC_SECURITY, ANTHROPIC_TRADINGVIEW_SYMBOL } from "../src/domain/anthropic-security";
import { closeDatabase, databasePath, getDb, getSqlite } from "../src/db/client";
import { migrateDatabase } from "../src/db/migrate";
import { seedSupportedIndividualSecurities } from "../src/db/supported-securities";
import { reconcilePersistedSecurityIdentities } from "../src/db/security-identity-repository";
import { saveProviderSymbolsBatch } from "../src/db/repositories/metrics-repository";

// Official symbol identification is independent of quote availability at IPO.
// Do not insert the offer price as a traded quote or invent converted quantities.
try {
  const sqlite = getSqlite();
  const backupDirectory = join(dirname(databasePath()), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const backup = join(backupDirectory, `before-anthropic-${Date.now()}.sqlite`);
  await sqlite.backup(backup);
  migrateDatabase();
  const verifiedAt = new Date().toISOString();
  const merged = sqlite.transaction(() => {
    seedSupportedIndividualSecurities(getDb(), [ANTHROPIC_SECURITY]);
    const count = reconcilePersistedSecurityIdentities(sqlite, false, [ANTHROPIC_SECURITY.securityId]);
    saveProviderSymbolsBatch([{
      securityId: ANTHROPIC_SECURITY.securityId,
      providerSymbol: ANTHROPIC_TRADINGVIEW_SYMBOL,
      status: "resolved", confidence: 1, verifiedAt,
      metadata: {
        ticker: "ANT", exchange: "NASDAQ", currency: "USD",
        isin: ANTHROPIC_SECURITY.isin, cusip: ANTHROPIC_SECURITY.cusip,
        description: ANTHROPIC_SECURITY.name,
        mappingProvenance: "exact_exchange", mappingScore: 1,
        sourceUrl: "https://www.nasdaqtrader.com/TraderNews.aspx?id=DTN2026-28",
        providerUrl: "https://www.tradingview.com/symbols/NASDAQ-ANT/",
        expectedListingDate: "2026-11-19",
        verificationBasis: "official_listing_notice",
      },
    }]);
    return count;
  })();
  console.log(JSON.stringify({ database: databasePath(), backup, merged,
    securityId: ANTHROPIC_SECURITY.securityId, symbol: ANTHROPIC_TRADINGVIEW_SYMBOL,
    foreignKeyErrors: sqlite.pragma("foreign_key_check"),
  }, null, 2));
} finally {
  closeDatabase();
}
