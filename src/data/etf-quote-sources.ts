import type { EtfShareClass } from "@/domain/etf";
import { tradingViewPriceSymbols } from "./providers/market-quote-symbols";

export type EtfQuoteSource = { source: "TradingView"; symbol: string };

// Unit-price listings are independent of the ETF used for look-through holdings.
// Keep the held share class, exchange and currency, including SIX's USD suffix.
export const ETF_QUOTE_SOURCES: Readonly<Record<string, EtfQuoteSource>> = {
  "ivv-us": { source: "TradingView", symbol: "AMEX:IVV" },
  "cspx-ucits": { source: "TradingView", symbol: "LSE:CSPX" },
  "sp20-ucits": { source: "TradingView", symbol: "LSE:SP20" },
  "urth-us": { source: "TradingView", symbol: "AMEX:URTH" },
  "swda-ucits": { source: "TradingView", symbol: "LSE:SWDA" },
  "acwi-us": { source: "TradingView", symbol: "NASDAQ:ACWI" },
  "ssac-ucits": { source: "TradingView", symbol: "LSE:SSAC" },
  "chip-ucits": { source: "TradingView", symbol: "EURONEXT:CHIP" },
  "iemg-us": { source: "TradingView", symbol: "AMEX:IEMG" },
  "eimi-ucits": { source: "TradingView", symbol: "LSE:EIMI" },
  "csemas-ucits": { source: "TradingView", symbol: "SIX:CSEMAS.USD" },
  "panx-ucits": { source: "TradingView", symbol: "EURONEXT:PANX" },
  "iqq-us": { source: "TradingView", symbol: "NASDAQ:IQQ" },
  "cndx-ucits": { source: "TradingView", symbol: "LSE:CNDX" },
  "qld-us": { source: "TradingView", symbol: "AMEX:QLD" },
  "tqqq-us": { source: "TradingView", symbol: "NASDAQ:TQQQ" },
  "qtop-us": { source: "TradingView", symbol: "NASDAQ:QTOP" },
  "qtop-ucits": { source: "TradingView", symbol: "EURONEXT:QTOP" },
};

export function etfQuoteSource(etf: EtfShareClass): EtfQuoteSource | undefined {
  return ETF_QUOTE_SOURCES[etf.id] ?? tradingViewPriceSymbols({ ...etf, country: "" }, etf.priceSymbol ?? etf.ticker)
    .map((symbol): EtfQuoteSource => ({ source: "TradingView", symbol }))[0];
}
