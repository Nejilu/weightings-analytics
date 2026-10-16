import { sql } from "drizzle-orm";
import { SUPPORTED_INDIVIDUAL_SECURITIES, type SupportedIndividualSecurity } from "../data/supported-individual-securities";
import { getDb } from "./client";
import { securities } from "./schema";

/** Also accepts a transaction, so operational imports can avoid catalog cleanup. */
export function seedSupportedIndividualSecurities(
  writer: Pick<ReturnType<typeof getDb>, "insert">,
  supported: readonly SupportedIndividualSecurity[] = SUPPORTED_INDIVIDUAL_SECURITIES,
): void {
  for (const security of supported) {
    const values = {
      id: security.securityId,
      isin: security.isin ?? null,
      primaryTicker: security.ticker,
      name: security.name,
      assetClass: security.assetClass,
      sector: security.sector,
      country: security.country,
      currency: security.currency,
      identifiersJson: {
        exchange: security.exchange,
        ...(security.depositaryReceipt ? { depositaryReceipt: security.depositaryReceipt } : {}),
        ...(security.cusip ? { cusip: security.cusip } : {}),
        ...(security.sedol ? { sedol: security.sedol } : {}),
        ...(security.adrPremiumPairId ? { adrPremiumPairId: security.adrPremiumPairId } : {}),
      },
    };
    writer.insert(securities).values(values).onConflictDoUpdate({
      target: securities.id,
      set: { ...values, updatedAt: sql`CURRENT_TIMESTAMP` },
    }).run();
  }
}
