import type { Holding } from "@/domain/etf";
import { samsungGdrForSecurity } from "@/domain/samsung-securities";

type SymbolInput = Pick<
  Holding,
  "ticker" | "name" | "country" | "exchange"
>;

const EXCHANGE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["nasdaq", "NASDAQ"], ["new york stock exchange", "NYSE"],
  ["amex", "AMEX"], ["cboe", "CBOE"],
  ["london", "LSE"], ["euronext amsterdam", "EURONEXT"],
  ["amsterdam", "EURONEXT"], ["euronext brussels", "EURONEXT"],
  ["euronext paris", "EURONEXT"], ["paris", "EURONEXT"],
  ["euronext lisbon", "EURONEXT"], ["irish", "EURONEXT"],
  ["nyse", "NYSE"],
  ["swiss", "SIX"], ["six", "SIX"], ["hong kong", "HKEX"],
  ["taiwan", "TWSE"], ["gretai", "TPEX"], ["kosdaq", "KRX"],
  ["korea", "KRX"], ["tokyo", "TSE"], ["toronto", "TSX"],
  ["xetra", "XETR"], ["deutsche boerse", "XETR"],
  ["frankfurt", "FWB"], ["australian", "ASX"], ["asx", "ASX"],
  ["ital", "MIL"], ["milan", "MIL"], ["copenhagen", "OMXCOP"],
  ["madrid", "BME"], ["singapore", "SGX"], ["shanghai", "SSE"],
  ["shenzhen", "SZSE"], ["johannesburg", "JSE"], ["india", "NSE"],
  ["saudi", "TADAWUL"], ["tel aviv", "TASE"],
  ["brazil", "BMFBOVESPA"], ["xbsp", "BMFBOVESPA"],
  ["warsaw", "GPW"], ["vienna", "VIE"], ["wiener", "VIE"],
  ["istanbul", "BIST"], ["standard-classica-forts", "MOEX"],
  ["bursa malaysia", "MYX"], ["malaysia", "MYX"],
  ["mexic", "BMV"], ["thailand", "SET"], ["indonesia", "IDX"],
  ["philippine", "PSE"], ["qatar", "QSE"], ["abu dhabi", "ADX"],
  ["dubai", "DFM"], ["bse ltd", "BSE"], ["kuwait", "KSE"],
  ["oslo", "OSL"], ["stockholm", "OMXSTO"],
  ["helsinki", "OMXHEX"], ["prague", "PSECZ"], ["egypt", "EGX"],
  ["colombia", "BVC"], ["santiago", "BCS"], ["athens", "ATHEX"],
  ["new zealand", "NZX"], ["budapest", "BET"],
];

const COUNTRY_PREFIXES: Record<string, string[]> = {
  "united states": ["NASDAQ", "NYSE", "AMEX"],
  canada: ["TSX"], "united kingdom": ["LSE"], switzerland: ["SIX"],
  japan: ["TSE"], australia: ["ASX"], "hong kong": ["HKEX"],
  china: ["HKEX", "SSE", "SZSE"], taiwan: ["TWSE", "TPEX"],
  "south korea": ["KRX"], korea: ["KRX"],
  "korea (south)": ["KRX"],
  germany: ["XETR", "FWB"], france: ["EURONEXT"],
  netherlands: ["EURONEXT"], belgium: ["EURONEXT"],
  portugal: ["EURONEXT"], ireland: ["EURONEXT"], italy: ["MIL"],
  spain: ["BME"], denmark: ["OMXCOP"], sweden: ["OMXSTO"],
  finland: ["OMXHEX"], norway: ["OSL"], india: ["NSE", "BSE"],
  singapore: ["SGX"], brazil: ["BMFBOVESPA"], mexico: ["BMV"],
  "south africa": ["JSE"], malaysia: ["MYX"], thailand: ["SET"],
  indonesia: ["IDX"], philippines: ["PSE"], "new zealand": ["NZX"],
  austria: ["VIE"], poland: ["GPW"], turkey: ["BIST"], israel: ["TASE"],
  "saudi arabia": ["TADAWUL"], "united arab emirates": ["ADX", "DFM"],
  qatar: ["QSE"], kuwait: ["KSE"],
  chile: ["BCS"], colombia: ["BVC"], greece: ["ATHEX"],
  "czech republic": ["PSECZ"], hungary: ["BET"], egypt: ["EGX"],
};

const DEPOSITARY_RECEIPT_PREFIXES: Record<string, string> = {
  ASML: "NASDAQ",
};

const CROSS_EXCHANGE_ALIASES: Record<string, string[]> = {
  "BSE:500048": ["NSE:BEML"],
  "BSE:532483": ["NSE:CANBK"],
  "BSE:533581": ["NSE:PGEL"],
  "BSE:534091": ["NSE:MCX"],
  "NSE:MINDSPACE": ["BSE:MINDSPACE"],
};

export type TradingViewMappingProvenance =
  | "exact_exchange"
  | "confirmed_alias"
  | "country_fallback"
  | "cross_exchange";

export interface TradingViewSymbolCandidate {
  symbol: string;
  provenance: TradingViewMappingProvenance;
}

function depositaryPrefix(input: SymbolInput): string | undefined {
  // London's International Order Book uses LSIN in the TradingView screener.
  if (samsungGdrForSecurity(input)) return "LSIN";
  const ticker = input.ticker.toLocaleUpperCase("en-US");
  const name = input.name.toLocaleLowerCase("en-US");
  const prefix = DEPOSITARY_RECEIPT_PREFIXES[ticker];
  return prefix && (name.includes("adr") || name.includes("depositary"))
    ? prefix
    : undefined;
}

function exactExchangePrefix(input: SymbolInput): string | undefined {
  const exchange = (input.exchange ?? "").toLocaleLowerCase("en-US");
  const country = (input.country ?? "").toLocaleLowerCase("en-US");
  if (exchange.includes("nasdaq omx helsinki")) return "OMXHEX";
  if (exchange.includes("nasdaq omx nordic")) {
    if (country.includes("denmark")) return "OMXCOP";
    if (country.includes("sweden")) return "OMXSTO";
    if (country.includes("finland")) return "OMXHEX";
    if (country.includes("norway")) return "OSL";
  }
  return EXCHANGE_PREFIXES.find(([needle]) => exchange.includes(needle))?.[1];
}

function prefixes(input: SymbolInput): string[] {
  const country = (input.country ?? "").toLocaleLowerCase("en-US");
  const depositary = depositaryPrefix(input);
  if (depositary) return [depositary];
  const exact = exactExchangePrefix(input);
  return exact ? [exact] : (COUNTRY_PREFIXES[country] ?? []);
}

function normalizedTicker(input: SymbolInput, prefix: string): string {
  if (prefix === "LSIN") {
    const samsungGdr = samsungGdrForSecurity(input);
    if (samsungGdr) return samsungGdr.ticker;
  }
  let ticker = input.ticker.trim().replace(/\s+/g, "_");
  const name = input.name.toLocaleLowerCase("en-US");
  if (ticker === "BRKB" && name.includes("berkshire")) ticker = "BRK.B";
  if (ticker === "GMEXICOB" && name.includes("grupo mexico")) ticker = "GMEXICO/B";
  if (prefix === "BIST") ticker = ticker.replace(/\.E$/i, "");
  if (prefix === "NSE") ticker = ticker.replace(/-/g, "_");
  if (prefix === "NSE" && ticker === "SHFL") ticker = "SHRIRAMFIN";
  if (prefix === "MYX" && ticker === "SWB") ticker = "SUNWAY";
  if (prefix === "PSECZ" && ticker === "BAAKOMB") ticker = "KOMB";
  if (prefix === "NYSE" && ticker === "HEIA" && name.includes("heico")) ticker = "HEI.A";
  if (prefix === "NYSE" && ticker === "BFB" && name.includes("brown forman")) ticker = "BF.B";
  if (prefix === "TSX" && /^\d+D$/.test(ticker) && name.includes("constellation software")) ticker = "CSU";
  return ticker;
}

function aliases(prefix: string, ticker: string): string[] {
  const result: string[] = [];
  if (prefix === "HKEX" && /^0\d+$/.test(ticker)) {
    result.push(ticker.replace(/^0+/, ""));
  }
  if (prefix === "BMV") {
    const mexicanAliases: Record<string, string> = {
      CEMEXCPO: "CEMEX/CPO", FEMSAUBD: "FEMSA/UBD", FUNO11: "FUNO/11",
      GCARSOA1: "GCARSO/A1", GFINBURO: "GFINBUR/O", GFNORTEO: "GFNORTE/O",
      "AC*": "AC", "PE&OLES*": "PE_OLES", "WALMEX*": "WALMEX",
      FMTY14: "FMTY/14", KOFUBL: "KOF/UBL", FIBRAPL14: "FIBRAPL/14",
      BBAJIOO: "BBAJIO/O", TLEVISACPO: "TLEVISA/CPO", LACOMERUBC: "LACOMER/UBC",
      MEGACPO: "MEGA/CPO",
    };
    if (mexicanAliases[ticker]) result.push(mexicanAliases[ticker]);
    if (ticker.endsWith("*") && !mexicanAliases[ticker]) {
      result.push(ticker.slice(0, -1));
    }
    const classMatch = ticker.match(/^(.+)([AB])$/);
    if (classMatch) result.push(`${classMatch[1]}/${classMatch[2]}`);
  }
  if (prefix === "BCS" && ticker.includes(".")) {
    result.push(ticker.replace(".", "/"));
    result.push(ticker.replace(".", "_"));
  }
  if (prefix === "BCS" && ticker === "SQM.B") result.push("SQM_B");
  if (prefix === "NSE") {
    const indianAliases: Record<string, string> = {
      EMBASSY: "EMBASSY.RR", "NAM.INDIA": "NAM_INDIA", BIRET: "BIRET.RR",
      HEXW: "HEXT", MINDSPACE: "MINDSPACE.RR", NXST: "NXST.RR",
    };
    if (indianAliases[ticker]) result.push(indianAliases[ticker]);
  }
  if (prefix === "SGX" && ticker === "CICT") result.push("C38U");
  if (prefix === "SGX" && ticker === "CLAR") result.push("A17U");
  if (prefix === "MYX" && ticker === "YNS") result.push("YINSON");
  if (prefix === "MYX" && ticker === "FRTKF") result.push("FRONTKN");
  return result;
}

export function tradingViewSymbolCandidateDetails(input: SymbolInput): TradingViewSymbolCandidate[] {
  if (!input.ticker || input.ticker === "—" || input.ticker === "-" || input.ticker === "Cash") {
    return [];
  }
  const hasDepositaryOverride = Boolean(depositaryPrefix(input));
  const hasExactExchange = Boolean(exactExchangePrefix(input)) && !hasDepositaryOverride;
  const baseCandidates = prefixes(input).flatMap((prefix) => {
    const ticker = normalizedTicker(input, prefix);
    const base = {
      symbol: `${prefix}:${ticker}`,
      provenance: hasDepositaryOverride
        ? "confirmed_alias" as const
        : hasExactExchange
          ? "exact_exchange" as const
          : "country_fallback" as const,
    };
    const aliasesForTicker = aliases(prefix, ticker).map((value) => ({
      symbol: `${prefix}:${value}`,
      provenance: "confirmed_alias" as const,
    }));
    return [base, ...aliasesForTicker];
  });
  const crossExchangeCandidates = baseCandidates.flatMap((candidate) =>
    (CROSS_EXCHANGE_ALIASES[candidate.symbol] ?? []).map((symbol) => ({
      symbol,
      provenance: "cross_exchange" as const,
    })));
  const seen = new Set<string>();
  return [...baseCandidates, ...crossExchangeCandidates].filter((candidate) => {
    if (seen.has(candidate.symbol)) return false;
    seen.add(candidate.symbol);
    return true;
  });
}

export function tradingViewSymbolCandidates(input: SymbolInput): string[] {
  return tradingViewSymbolCandidateDetails(input).map((candidate) => candidate.symbol);
}
