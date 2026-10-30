import { tradingViewSymbolCandidateDetails } from "./tradingview-symbols";

interface Listing { ticker: string; name: string; country: string; exchange?: string }

const YAHOO_EXCHANGES: Record<string, string> = {
  L: "LSE", IL: "LSIN", PA: "EURONEXT", AS: "EURONEXT", BR: "EURONEXT", LS: "EURONEXT",
  SW: "SIX", DE: "XETR", F: "FWB", KS: "KRX", KQ: "KRX", TW: "TWSE", TWO: "TPEX",
  HK: "HKEX", SS: "SSE", SZ: "SZSE", T: "TSE", TO: "TSX", AX: "ASX", SI: "SGX",
  NS: "NSE", BO: "BSE", ST: "OMXSTO", CO: "OMXCOP", HE: "OMXHEX", OL: "OSL",
  MI: "MIL", MC: "BME", NZ: "NZX",
};
const US_RECEIPTS: Record<string, string> = { TSM: "NYSE:TSM", SKHY: "NASDAQ:SKHY" };
const LISTING_ALIASES: Record<string, string> = {
  // TradingView disambiguates the USD SIX listing with a currency suffix.
  "CSEMAS.SW": "SIX:CSEMAS.USD",
};

/** Price mappings must identify the held listing, not a company's interchangeable
 * metrics listing. In particular, never price a local share using its ADR/GDR. */
export function tradingViewPriceSymbols(listing: Listing, yahooSymbol?: string, savedSymbol?: string): string[] {
  if (/mutual fund/i.test(listing.exchange ?? "")) return [];
  const suffix = yahooSymbol ? /^(.+)\.([A-Z]+)$/i.exec(yahooSymbol) : null;
  let exact: string[];
  if (yahooSymbol && LISTING_ALIASES[yahooSymbol.toUpperCase()]) {
    exact = [LISTING_ALIASES[yahooSymbol.toUpperCase()]];
  } else if (suffix && YAHOO_EXCHANGES[suffix[2].toUpperCase()]) {
    const prefix = YAHOO_EXCHANGES[suffix[2].toUpperCase()];
    const ticker = prefix === "HKEX" ? suffix[1].replace(/^0+/, "") : suffix[1];
    exact = [`${prefix}:${ticker}`];
  } else if (yahooSymbol && US_RECEIPTS[yahooSymbol.toUpperCase()]) {
    exact = [US_RECEIPTS[yahooSymbol.toUpperCase()]];
  } else {
    const exchange = /nyse arca/i.test(listing.exchange ?? "") ? "AMEX" : listing.exchange;
    const ticker = yahooSymbol?.replace(/-/g, ".") ?? listing.ticker;
    exact = tradingViewSymbolCandidateDetails({ ...listing, ticker, exchange })
      .filter((candidate) => candidate.provenance !== "cross_exchange")
      .map((candidate) => candidate.symbol);
  }
  // Reuse a metrics mapping only when it is also a candidate for this listing.
  return [...new Set(savedSymbol && exact.includes(savedSymbol) ? [savedSymbol, ...exact] : exact)];
}
