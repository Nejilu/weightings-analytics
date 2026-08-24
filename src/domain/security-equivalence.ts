import type { Holding } from "./etf";

type SecurityDescriptor = Pick<Holding, "securityId" | "ticker" | "name">;
type QuoteDescriptor = Pick<Holding, "ticker" | "name">;
type ListingQuoteDescriptor = QuoteDescriptor & Pick<Holding, "country">;

interface EconomicSecurityGroup {
  key: string;
  displayTicker: string;
  displayName: string;
  tickers: string[];
  nameIncludes: string[];
}

export interface SecurityQuoteAlias {
  displayTicker: string;
  providerSymbol: string;
  instrumentType: "ADR" | "GDR";
  underlyingTicker: string;
}

const ECONOMIC_GROUPS: EconomicSecurityGroup[] = [
  {
    key: "alphabet",
    displayTicker: "GOOG / GOOGL",
    displayName: "ALPHABET INC",
    tickers: ["GOOG", "GOOGL"],
    nameIncludes: ["ALPHABET INC"],
  },
  {
    key: "taiwan-semiconductor",
    displayTicker: "TSM / 2330",
    displayName: "TAIWAN SEMICONDUCTOR MANUFACTURING",
    tickers: ["TSM", "2330", "2330.TW"],
    nameIncludes: ["TAIWAN SEMICONDUCTOR MANUFACTURING"],
  },
  {
    key: "sk-hynix",
    displayTicker: "HY9H / 000660",
    displayName: "SK HYNIX INC",
    tickers: ["HY9H", "HY9H.F", "000660", "000660.KS"],
    nameIncludes: ["SK HYNIX"],
  },
  {
    key: "asml",
    displayTicker: "ASML",
    displayName: "ASML HOLDING",
    tickers: ["ASML"],
    nameIncludes: ["ASML HOLDING"],
  },
];

function normalized(value: string): string {
  return value.trim().toLocaleUpperCase("en-US");
}

function findEconomicGroup(
  security: Pick<SecurityDescriptor, "ticker" | "name">,
): EconomicSecurityGroup | undefined {
  const ticker = normalized(security.ticker);
  const name = normalized(security.name);
  return ECONOMIC_GROUPS.find(
    (group) =>
      group.tickers.includes(ticker) ||
      group.nameIncludes.some((fragment) => name.includes(fragment)),
  );
}

export function economicSecurityIdentity(
  security: SecurityDescriptor,
): SecurityDescriptor {
  const group = findEconomicGroup(security);
  if (!group) return security;

  return {
    securityId: `economic:${group.key}`,
    ticker: group.displayTicker,
    name: group.displayName,
  };
}

export function securityQuoteAlias(
  security: QuoteDescriptor,
): SecurityQuoteAlias | undefined {
  const group = findEconomicGroup(security);
  if (group?.key === "taiwan-semiconductor") {
    return {
      displayTicker: "TSM",
      providerSymbol: "TSM",
      instrumentType: "ADR",
      underlyingTicker: security.ticker,
    };
  }
  if (group?.key === "sk-hynix") {
    return {
      displayTicker: "HY9H",
      providerSymbol: "HY9H.F",
      instrumentType: "GDR",
      underlyingTicker: security.ticker,
    };
  }
  return undefined;
}

export function securityListingQuoteSymbol(
  security: ListingQuoteDescriptor,
  preferredTicker = security.ticker,
): string | undefined {
  const ticker = normalized(preferredTicker);
  if (!ticker || ticker === "—") return undefined;
  if (ticker === "HY9H") return "HY9H.F";
  if (ticker === "SMSN") return "SMSN.IL";
  if (ticker.includes(".")) return ticker;

  const country = normalized(security.country);
  if (
    /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) &&
    (country.includes("UNITED STATES") ||
      ["ASML", "GOOG", "GOOGL", "TSM", "SSNLF"].includes(ticker))
  ) {
    return ticker;
  }
  if (/^\d{6}$/.test(ticker) && country.includes("KOREA")) {
    return `${ticker}.KS`;
  }
  if (/^\d{4,6}$/.test(ticker) && country.includes("TAIWAN")) {
    return `${ticker}.TW`;
  }
  if (/^\d{4}$/.test(ticker) && country.includes("JAPAN")) {
    return `${ticker}.T`;
  }
  if (/^\d{1,5}$/.test(ticker) && country.includes("HONG KONG")) {
    return `${ticker.padStart(4, "0")}.HK`;
  }
  if (/^\d{6}$/.test(ticker) && country.includes("CHINA")) {
    return `${ticker}.${ticker.startsWith("6") ? "SS" : "SZ"}`;
  }
  return undefined;
}

export function mergeEquivalentHoldings(
  holdings: Holding[],
): Holding[] {
  const merged = new Map<string, Holding>();

  for (const holding of holdings) {
    const identity = economicSecurityIdentity(holding);
    const existing = merged.get(identity.securityId);
    if (!existing) {
      merged.set(identity.securityId, {
        ...holding,
        ...identity,
      });
      continue;
    }

    existing.weight += holding.weight;
    existing.marketValue =
      existing.marketValue !== undefined &&
      holding.marketValue !== undefined
        ? existing.marketValue + holding.marketValue
        : undefined;
  }

  return [...merged.values()].sort(
    (left, right) => right.weight - left.weight,
  );
}
