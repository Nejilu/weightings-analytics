import type { Holding } from "@/domain/etf";
import { SAMSUNG_GDRS } from "@/domain/samsung-securities";

export interface SupportedIndividualSecurity
  extends Omit<Holding, "weight" | "marketValue"> {
  currency: string;
  exchange: string;
  /** Shared ISIN of a separate trading line; securities.isin stays unique. */
  listingIsin?: string;
  depositaryReceipt?: {
    underlyingSecurityId: string;
    underlyingTicker: string;
    underlyingSharesPerReceipt: number;
  };
}

/**
 * Equities intentionally supported by the portfolio builder even when they
 * are not present in the current ACWI holdings snapshot.
 */
export const SUPPORTED_INDIVIDUAL_SECURITIES: readonly SupportedIndividualSecurity[] = [
  {
    // Same ordinary share as Tokyo 6857, quoted in EUR in Frankfurt.
    // https://www.tradingview.com/symbols/FWB-VAN/
    securityId: "LISTING:FWB:VAN",
    listingIsin: "JP3122400009",
    ticker: "VAN",
    name: "ADVANTEST (FRANKFURT)",
    sector: "Information Technology",
    assetClass: "Equity",
    country: "Japan",
    currency: "EUR",
    exchange: "Frankfurt Stock Exchange",
  },
  ...SAMSUNG_GDRS.map((gdr) => ({
    securityId: gdr.isin,
    isin: gdr.isin,
    ticker: gdr.ticker,
    name: gdr.name,
    sector: "Information Technology",
    assetClass: "Equity",
    country: "Korea (South)",
    currency: "USD",
    exchange: "London Stock Exchange",
    cusip: gdr.isin.slice(2, 11),
    depositaryReceipt: {
      underlyingSecurityId: gdr.underlyingSecurityId,
      underlyingTicker: gdr.underlyingTicker,
      underlyingSharesPerReceipt: gdr.underlyingSharesPerReceipt,
    },
  })),
  {
    // Citi sponsored Nasdaq ADR, distinct from the HY9H GDR.
    // https://depositaryreceipts.citi.com/adr/guides/pgm_d.aspx?cusip=78392B206&pageId=15&subpageid=105
    securityId: "US78392B2060",
    isin: "US78392B2060",
    ticker: "SKHY",
    name: "SK HYNIX INC SPONSORED ADR",
    sector: "Information Technology",
    assetClass: "Equity",
    country: "Korea (South)",
    currency: "USD",
    exchange: "NASDAQ",
    cusip: "78392B206",
    adrPremiumPairId: "sk-hynix",
  },
  {
    securityId: "US55087P1049",
    isin: "US55087P1049",
    ticker: "LYFT",
    name: "LYFT INC CLASS A",
    sector: "Industrials",
    assetClass: "Equity",
    country: "United States",
    currency: "USD",
    exchange: "NASDAQ",
    cusip: "55087P104",
  },
];
