import type { PortfolioItem } from "./portfolio";
import { dateInTimezone } from "./upcoming-earnings";

export interface DividendObservation {
  providerSymbol: string;
  currency: string | null;
  exchangeTimezone: string;
  capturedAt: string;
  historical: Array<{ exDate: string; amountPerShare: number }>;
  upcoming: { exDate: string | null; paymentDate: string | null } | null;
  paymentDates?: Record<string, string>;
  calendarAvailable: boolean;
}

export interface DividendSettings {
  countryRates: Record<string, number>;
  securityRates: Record<string, number>;
}

export interface DividendEvent {
  securityId: string;
  ticker: string;
  name: string;
  country: string;
  providerSymbol: string;
  exDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  amountPerShare: number | null;
  currency: string | null;
  eligibleQuantity: number | null;
  currentQuantity: number | null;
  withholdingRate: number | null;
  grossAmount: number | null;
  estimatedNet: number | null;
  sourceStatus: "live" | "cached" | "stale" | "unavailable";
  calendarAvailable: boolean;
  capturedAt: string | null;
}

export interface DividendPayment {
  id: string;
  securityId: string;
  ticker: string;
  exDate: string;
  paymentDate: string;
  quantity: number;
  amountPerShare: number;
  currency: string;
  withholdingRate: number;
  fees: number;
  grossAmount: number;
  netAmount: number;
  cashCredited: boolean;
  automatic?: boolean;
}

export interface PortfolioDividends {
  events: DividendEvent[];
  payments: DividendPayment[];
  trackingStartedAt: string;
  cashUpdated?: boolean;
  cashBalances?: Array<{ currency: string; amount: number }>;
}

export class DividendRequestError extends Error {}

export function directDividendPositions(items: readonly PortfolioItem[]) {
  return items.filter((item) => item.kind === "security");
}

export function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function validateDividendSettings(value: unknown): DividendSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DividendRequestError("Invalid settings.");
  const input = value as Record<string, unknown>;
  const parse = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DividendRequestError("Rates must be an object.");
    const entries = Object.entries(value);
    if (entries.length > 5000 || entries.some(([key, rate]) => !key.trim() || key.length > 200 || !validRate(rate))) {
      throw new DividendRequestError("Withholding rates must be between 0 and 100%.");
    }
    return Object.fromEntries(entries);
  };
  return { countryRates: parse(input.countryRates), securityRates: parse(input.securityRates) };
}

// Dividend rights normally belong to the position before the ex-date starts in
// the listing's timezone. A same-day first observation cannot establish rights.
export function eligibleDividendQuantity(
  balances: Array<{ effectiveAt: string; quantity: number | null; providerSymbol: string | null }>,
  exDate: string, timezone: string, providerSymbol: string,
): number | null {
  const previous = balances.filter((row) => dateInTimezone(Date.parse(row.effectiveAt), timezone) < exDate).at(-1);
  if (!previous || previous.providerSymbol !== providerSymbol) return null;
  return previous.quantity;
}

export function dividendAmounts(quantity: number, amountPerShare: number, withholdingRate: number, fees = 0) {
  if (![quantity, amountPerShare, fees].every(Number.isFinite) || quantity <= 0 || amountPerShare <= 0 || fees < 0 || !validRate(withholdingRate)) {
    throw new DividendRequestError("Positive share quantity and dividend amount, a valid rate and non-negative fees are required.");
  }
  const grossAmount = quantity * amountPerShare;
  const netAmount = grossAmount * (1 - withholdingRate / 100) - fees;
  if (!Number.isFinite(grossAmount) || !Number.isFinite(netAmount) || netAmount < 0) throw new DividendRequestError("Invalid net dividend amount.");
  return { grossAmount, netAmount };
}
