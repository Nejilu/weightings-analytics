import type { EtfShareClass } from "@/domain/etf";
import type { MarketQuote } from "@/domain/market-quote";
import { requestHoldingsSource } from "./holdings-request";

/** Only the dated NAV amount for the requested share class is a unit price. */
export function parseBlackrockNav(html: string, symbol: string, now = Date.now()): MarketQuote {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  if (!new RegExp(`\\b${escapedSymbol}\\b`).test(title)) throw new Error("BlackRock returned a different share class.");
  const block = /<li\b[^>]*\bdata-col=["']fundHeader\.fundNav\.navAmount["'][^>]*>([\s\S]*?)<\/li>/i.exec(html)?.[1] ?? "";
  const text = block.replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|#160);/gi, " ");
  const date = /\bNAV\s+as\s+of\s+([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(text);
  const amount = /<span\b[^>]*class=["'][^"']*\bheader-nav-data\b[^"']*["'][^>]*>\s*\$\s*([\d,]+(?:\.\d+)?)\s*<\/span>/i.exec(block);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = date ? months.indexOf(date[1].toLowerCase()) : -1;
  const price = amount ? Number(amount[1].replaceAll(",", "")) : NaN;
  if (!date || month < 0 || !Number.isFinite(price) || price <= 0) throw new Error("BlackRock returned no dated NAV.");
  const asOf = `${date[3]}-${String(month + 1).padStart(2, "0")}-${date[2].padStart(2, "0")}`;
  const timestamp = Date.UTC(Number(date[3]), month, Number(date[2]));
  if (new Date(timestamp).toISOString().slice(0, 10) !== asOf || timestamp > now) throw new Error("BlackRock returned an invalid NAV date.");
  // The page publishes a valuation date, not a time of intraday trading.
  return { symbol, price, currency: "USD", asOf, source: "BlackRock", session: "nav" };
}

export async function fetchBlackrockNav(etf: EtfShareClass): Promise<MarketQuote> {
  if (new URL(etf.productUrl).hostname !== "www.blackrock.com" || etf.tradingCurrency !== "USD") {
    throw new Error("Unsupported BlackRock NAV source.");
  }
  const response = await requestHoldingsSource(etf.productUrl);
  return parseBlackrockNav(await response.text(), etf.ticker);
}
