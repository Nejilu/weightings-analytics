import type { Holding } from "@/domain/etf";

export interface SupportedIndividualSecurity
  extends Omit<Holding, "weight" | "marketValue"> {
  currency: string;
  exchange: string;
}

/**
 * Equities intentionally supported by the portfolio builder even when they
 * are not present in the current ACWI holdings snapshot.
 */
export const SUPPORTED_INDIVIDUAL_SECURITIES: readonly SupportedIndividualSecurity[] = [
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
