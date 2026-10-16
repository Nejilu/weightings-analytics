/** Samsung's two Regulation S GDRs; each receipt represents 25 local shares.
 * https://www.londonstockexchange.com/stock/SMSD/samsung-electronics-co-ltd-att/company-page
 * SMSD replaced the former Luxembourg ticker SMSEL in February 2025.
 */
export const SAMSUNG_GDRS = [
  {
    isin: "US7960508882",
    ticker: "SMSN",
    name: "SAMSUNG ELECTRONICS CO LTD SPONSORED GDR",
    underlyingSecurityId: "KR7005930003",
    underlyingTicker: "005930",
    underlyingSharesPerReceipt: 25,
    yahooSymbol: "SMSN.IL",
    tradingViewSymbol: "LSIN:SMSN",
    tickerAliases: ["SMSN", "SMSN.IL"],
  },
  {
    isin: "US7960502018",
    ticker: "SMSD",
    name: "SAMSUNG ELECTRONICS CO LTD NON VOTING PREFERRED GDR",
    underlyingSecurityId: "KR7005931001",
    underlyingTicker: "005935",
    underlyingSharesPerReceipt: 25,
    yahooSymbol: "SMSD.IL",
    tradingViewSymbol: "LSIN:SMSD",
    tickerAliases: ["SMSD", "SMSD.IL", "SMSEL"],
  },
] as const;

export function samsungGdrForSecurity(security: { ticker: string; securityId?: string }) {
  const ticker = security.ticker.trim().toUpperCase();
  return SAMSUNG_GDRS.find((gdr) =>
    security.securityId === gdr.isin || gdr.tickerAliases.some((alias) => alias === ticker));
}
