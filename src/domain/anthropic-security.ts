import type { Holding } from "./etf";

/**
 * Official listing: https://www.nasdaqtrader.com/TraderNews.aspx?id=DTN2026-28
 * Provider identity: https://www.tradingview.com/symbols/NASDAQ-ANT/
 * The BlackRock Series F label is an exposure alias requested for BGSIX.
 * This does not convert preferred-share quantities into listed-share quantities.
 */
export const ANTHROPIC_SECURITY = {
  securityId: "US03703U1079",
  isin: "US03703U1079",
  cusip: "03703U107",
  ticker: "ANT",
  name: "ANTHROPIC PBC CLASS A",
  sector: "Information Technology",
  assetClass: "Equity",
  country: "United States",
  currency: "USD",
  exchange: "NASDAQ",
} as const;

export const ANTHROPIC_TRADINGVIEW_SYMBOL = "NASDAQ:ANT";
export const ANTHROPIC_LEGACY_ID = "NAME:ANTHROPICSERIESFPREFEQPRVT";

interface Identity {
  securityId: string;
  name: string;
  ticker?: string;
  isin?: string;
  cusip?: string;
  sedol?: string;
}

const normalize = (value = "") => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
const PUBLIC_NAMES = new Set(["ANTHROPIC", "ANTHROPICPBC", "ANTHROPICPBCCLASSA"]);

export function isAnthropicIdentity(security: Identity): boolean {
  // Never identify a company by the bare ANT ticker, or erase another class's
  // durable identifiers. In particular, Class N and other preferred series
  // are not implicitly mapped to the listed Class A security.
  if (security.isin && normalize(security.isin) !== ANTHROPIC_SECURITY.isin) return false;
  if (security.cusip && normalize(security.cusip) !== ANTHROPIC_SECURITY.cusip) return false;
  if (security.sedol) return false;
  if (security.securityId === ANTHROPIC_SECURITY.securityId) return true;
  if (!security.securityId.startsWith("NAME:")) return false;
  const ticker = normalize(security.ticker);
  if (ticker && ticker !== "ANT") return false;
  const name = normalize(security.name);
  return PUBLIC_NAMES.has(name) || (
    security.securityId === ANTHROPIC_LEGACY_ID && name === "ANTHROPICSERIESFPREFEQPRVT"
  );
}

export function canonicalizeAnthropicHolding(holding: Holding): Holding {
  return isAnthropicIdentity(holding) ? { ...holding, ...ANTHROPIC_SECURITY } : holding;
}
