import type { EtfShareClass } from "@/domain/etf";
import type { MarketPrice } from "@/domain/portfolio";
import { loadPreferredQuote, type MarketQuote } from "@/domain/market-quote";
import { etfQuoteSource } from "../etf-quote-sources";

function currencyMatches(etf: EtfShareClass, currency: string) {
  const base = currency === "GBp" || currency.toUpperCase() === "GBX" ? "GBP" : currency.toUpperCase();
  return base === etf.tradingCurrency.toUpperCase();
}

export function etfPriceIsCompatible(etf: EtfShareClass, price: MarketPrice): boolean {
  if (!currencyMatches(etf, price.currency)) return false;
  const source = etfQuoteSource(etf);
  if (price.source === "TradingView") return source?.source === "TradingView" && price.providerSymbol === source.symbol;
  return price.source === "Yahoo Finance" && price.providerSymbol === (etf.priceSymbol ?? etf.ticker);
}

export async function fetchEtfQuote(etf: EtfShareClass, providers: {
  tradingView: (symbol: string) => Promise<MarketQuote | null>;
  yahoo: (symbol: string) => Promise<MarketQuote>;
}): Promise<MarketQuote> {
  const source = etfQuoteSource(etf);
  const yahoo = async () => {
    const symbol = etf.priceSymbol ?? etf.ticker;
    const quote = await providers.yahoo(symbol);
    if (quote.symbol.toUpperCase() !== symbol.toUpperCase()) throw new Error("Quote symbol does not match the held ETF listing.");
    if (!currencyMatches(etf, quote.currency)) throw new Error("Quote currency does not match the held ETF listing.");
    return quote;
  };
  return loadPreferredQuote(source ? [source.symbol] : [], {
    tradingView: async (symbol) => {
      const quote = await providers.tradingView(symbol);
      return quote && quote.symbol === symbol && currencyMatches(etf, quote.currency) ? quote : null;
    },
    yahoo,
  });
}
