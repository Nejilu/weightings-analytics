import type { Holding } from "./etf";

export interface AdrPair {
  id: "tsmc" | "sk-hynix" | "sk-hynix-gdr-us";
  adrSymbol: string;
  localSymbol: string;
  overnightSymbol: string;
  fxSymbol: string;
  localCurrency: string;
  localTimezone: string;
  localCloseUtc?: string;
  underlyingPerAdr: number;
}

export type AdrPairId = AdrPair["id"];

export interface AdrListingDescriptor {
  ticker: string;
  name: string;
  securityId?: string;
  referenceId?: string;
  isin?: string;
  kind?: string;
  priceSymbol?: string;
  quoteTicker?: string;
  adrPremiumPairId?: AdrPairId | null;
}

/** Identify the instrument held, rather than every listing of the same issuer. */
export function adrPairForListing(security: AdrListingDescriptor): AdrPair | null {
  if (security.kind && security.kind !== "security") return null;
  if (security.adrPremiumPairId === null) return null;
  const listingSymbol = (security.priceSymbol ?? security.quoteTicker ?? security.ticker).trim().toUpperCase().split(":").at(-1)!;
  if (["HY9H", "HY9H.F"].includes(listingSymbol) && adrPairForSecurity({
    ticker: "HY9H", name: security.name, isin: security.isin,
    securityId: security.securityId ?? security.referenceId ?? "",
  })?.id === "sk-hynix") return ADR_PAIRS.find((pair) => pair.id === "sk-hynix-gdr-us")!;
  if (security.priceSymbol && !ADR_PAIRS.some((pair) => pair.adrSymbol.split(":")[1] === security.priceSymbol!.trim().toUpperCase().split(":").at(-1))) return null;
  if (security.adrPremiumPairId !== undefined) return ADR_PAIRS.find((pair) => pair.id === security.adrPremiumPairId) ?? null;
  const symbol = (security.priceSymbol ?? security.quoteTicker ?? security.ticker).trim().toUpperCase();
  const ticker = symbol.includes(":") ? symbol.split(":").at(-1)! : symbol;
  const candidate = ADR_PAIRS.find((pair) => pair.adrSymbol.split(":")[1] === ticker);
  if (!candidate) return null;
  const issuer = adrPairForSecurity({
    ticker, name: security.name, isin: security.isin,
    securityId: security.securityId ?? security.referenceId ?? "",
  });
  return issuer?.id === candidate.id ? candidate : null;
}

export const ADR_PAIRS: readonly AdrPair[] = [
  {
    id: "tsmc", adrSymbol: "NYSE:TSM", localSymbol: "TWSE:2330",
    overnightSymbol: "BOATS:TSM", fxSymbol: "FX_IDC:USDTWD",
    localCurrency: "TWD", localTimezone: "Asia/Taipei", localCloseUtc: "05:30:00",
    // TSMC 20-F: https://investor.tsmc.com/sites/ir/sec-filings/2025_20F%20Report.pdf
    underlyingPerAdr: 5,
  },
  {
    id: "sk-hynix", adrSymbol: "NASDAQ:SKHY", localSymbol: "KRX:000660",
    overnightSymbol: "BOATS:SKHY", fxSymbol: "FX_IDC:USDKRW",
    localCurrency: "KRW", localTimezone: "Asia/Seoul", localCloseUtc: "06:30:00",
    // US ADR, distinct from HY9H GDR. Citi program CUSIP 78392B206:
    // https://depositaryreceipts.citi.com/adr/guides/pgm_dispabook.aspx?cusip=78392B206&pageId=15&subpageID=111
    underlyingPerAdr: 0.1,
  },
  {
    id: "sk-hynix-gdr-us", adrSymbol: "NASDAQ:SKHY", localSymbol: "FWB:HY9H",
    // Frankfurt and Nasdaq overlap: use US regular-session minute bars.
    overnightSymbol: "NASDAQ:SKHY", fxSymbol: "FX_IDC:USDEUR",
    localCurrency: "EUR", localTimezone: "Europe/Berlin",
    // Citi GDR ORD:DR 1:1; US ADR ORD:DR 1:10. One SKHY = 0.1 HY9H.
    // https://depositaryreceipts.citi.com/adr/guides/pgm_dispabook.aspx?cusip=78392B107&pageId=15&subpageID=111
    underlyingPerAdr: 0.1,
  },
];

export function adrPairForSecurity(security: Pick<Holding, "ticker" | "name" | "isin" | "securityId">): AdrPair | null {
  const isin = security.isin ?? security.securityId;
  const ticker = security.ticker.trim().toUpperCase();
  const name = security.name.toUpperCase();
  if (["TW0002330008", "US8740391003"].includes(isin)
    || (["TSM", "2330", "2330.TW"].includes(ticker) && /TAIWAN SEMICONDUCTOR|TSMC/.test(name))) return ADR_PAIRS[0];
  if (["KR7000660001", "US78392B2060"].includes(isin)
    || (["SKHY", "000660", "000660.KS", "HY9H", "HY9H.F"].includes(ticker) && name.includes("SK HYNIX"))) return ADR_PAIRS[1];
  return null;
}

export interface PriceBar {
  /** Start of the bar, in Unix seconds. */
  timestamp: number;
  close: number;
  volume: number;
  /** Actual regular-session end for daily bars, including shortened sessions. */
  sessionCloseTimestamp?: number;
}

export interface AdrPremiumObservation {
  mode: "aligned" | "closing-prices";
  premiumPct: number;
  localPrice: number;
  localCloseAt: string;
  adrPrice: number;
  adrPriceAt: string;
  /** Upper bound on trade age at the Asian close (one-minute bar start). */
  adrMaxAgeSeconds: number | null;
  localCurrencyPerUsd: number;
  fxAt: string;
  parityUsd: number;
}

export interface AdrPremiumView {
  pair: AdrPair;
  observation: AdrPremiumObservation | null;
  sourceStatus: "live" | "cached" | "stale" | "unavailable";
  capturedAt: string;
  fallbackReason: "overnight-unavailable" | "intraday-unavailable" | "fx-unavailable" | "prices-unavailable" | null;
}

export function marketDate(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(timestamp * 1_000));
}

const iso = (seconds: number) => new Date(seconds * 1_000).toISOString();
const positive = (bar: PriceBar) => Number.isFinite(bar.close) && bar.close > 0;

/** Exclude future bars, unfinished bars and zero-volume equity placeholders. */
function lastCompletedBar(bars: PriceBar[], target: number, interval: number, maxAge: number, requireVolume = false): PriceBar | undefined {
  return bars.filter((bar) => positive(bar) && bar.timestamp + interval <= target
    && target - bar.timestamp <= maxAge && (!requireVolume || bar.volume > 0))
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

export function calculateAdrPremium(pair: AdrPair, data: {
  localDaily: PriceBar[]; usDaily: PriceBar[]; overnight: PriceBar[]; fx: PriceBar[];
}, now = Date.now()): Pick<AdrPremiumView, "observation" | "fallbackReason"> {
  const nowSeconds = now / 1_000;
  const local = data.localDaily.filter((bar) => positive(bar) && bar.volume > 0)
    .map((bar) => ({ bar, close: bar.sessionCloseTimestamp ?? (pair.localCloseUtc
      ? Date.parse(`${marketDate(bar.timestamp, pair.localTimezone)}T${pair.localCloseUtc}Z`) / 1_000
      : Infinity) }))
    .filter((entry) => entry.close <= nowSeconds).sort((a, b) => b.close - a.close)[0];
  if (!local) return { observation: null, fallbackReason: "prices-unavailable" };
  const overnight = lastCompletedBar(data.overnight, local.close, 60, 300, true);
  const alignedFx = lastCompletedBar(data.fx, local.close, 300, 900);
  const makeObservation = (adr: PriceBar, fx: PriceBar, mode: AdrPremiumObservation["mode"], adrAt: number): AdrPremiumObservation => {
    const parityUsd = local.bar.close * pair.underlyingPerAdr / fx.close;
    return {
      mode, premiumPct: (adr.close / parityUsd - 1) * 100,
      localPrice: local.bar.close, localCloseAt: iso(local.close),
      adrPrice: adr.close, adrPriceAt: iso(adrAt),
      adrMaxAgeSeconds: mode === "aligned" ? local.close - adr.timestamp : null,
      localCurrencyPerUsd: fx.close, fxAt: iso(fx.timestamp + 300), parityUsd,
    };
  };
  if (overnight && alignedFx) return { observation: makeObservation(overnight, alignedFx, "aligned", overnight.timestamp + 60), fallbackReason: null };

  // The provider resolves daily close times from its regular session calendar.
  // Use the latest completed regular close, even when Asia has a holiday;
  // the UI explicitly exposes both dates and does not call this synchronized.
  const us = data.usDaily.filter((bar) => positive(bar) && bar.volume > 0
    && bar.sessionCloseTimestamp !== undefined && bar.sessionCloseTimestamp <= nowSeconds)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const closingFx = us ? lastCompletedBar(data.fx, us.sessionCloseTimestamp!, 300, 900) : undefined;
  const fallbackReason = !overnight
    ? pair.id === "sk-hynix-gdr-us" ? "intraday-unavailable" : "overnight-unavailable"
    : "fx-unavailable";
  return {
    observation: us && closingFx ? makeObservation(us, closingFx, "closing-prices", us.sessionCloseTimestamp!) : null,
    fallbackReason,
  };
}
