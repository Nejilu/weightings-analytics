import assert from "node:assert/strict";
import test from "node:test";
import { dividendAmounts, eligibleDividendQuantity, validateDividendSettings } from "./dividends";
import { dividendWithholdingRate } from "@/data/dividend-withholding";
import { normalizeYahooDividends } from "@/data/providers/yahoo-dividends";

test("rights survive selling after detachment, exclude same-day acquisition and require listing compatibility", () => {
  const balances = [
    { effectiveAt: "2026-10-01T10:00:00Z", quantity: 100, providerSymbol: "TSM" },
    { effectiveAt: "2026-10-09T14:00:00Z", quantity: 0, providerSymbol: "TSM" },
  ];
  assert.equal(eligibleDividendQuantity(balances, "2026-10-09", "America/New_York", "TSM"), 100);
  assert.equal(eligibleDividendQuantity(balances, "2026-10-10", "America/New_York", "TSM"), 0);
  assert.equal(eligibleDividendQuantity(balances, "2026-10-01", "America/New_York", "TSM"), null);
  assert.equal(eligibleDividendQuantity(balances, "2026-10-09", "America/New_York", "2330.TW"), null);
});

test("rates prioritize stock overrides, preserve zero and never treat unknown or conditional countries as tax free", () => {
  const settings = validateDividendSettings({ countryRates: { "United States": 15 }, securityRates: { exempt: 0 } });
  assert.equal(dividendWithholdingRate("ordinary", "United States", settings), 15);
  assert.equal(dividendWithholdingRate("exempt", "United States", settings), 0);
  assert.equal(dividendWithholdingRate("TSM", "Taiwan", settings), 21);
  assert.equal(dividendWithholdingRate("australian", "Australia", settings), null);
  assert.equal(dividendWithholdingRate("unknown", "Not reported", settings), null);
  assert.equal(dividendWithholdingRate("constructor", "United States", settings), 15);
  assert.throws(() => validateDividendSettings({ countryRates: { US: -1 }, securityRates: {} }));
  assert.throws(() => validateDividendSettings({ countryRates: { US: "15" }, securityRates: {} }));
  assert.throws(() => validateDividendSettings({ countryRates: { US: 101 }, securityRates: {} }));
  assert.deepEqual(dividendAmounts(100, 1.2, 15, 2), { grossAmount: 120, netAmount: 100 });
  assert.throws(() => dividendAmounts(-100, 1.2, 15));
});

test("Yahoo normalization uses exchange dates, restores split units, rejects invalid amounts and does not invent future amounts", () => {
  const result = normalizeYahooDividends("AAPL", {
    meta: { currency: "USD", exchangeTimezoneName: "America/New_York" },
    events: { dividends: [{ date: new Date("2026-08-07T13:30:00Z"), amount: 0.25 }, { date: new Date("2026-08-08"), amount: NaN }],
      splits: [{ date: new Date("2026-09-01"), numerator: 4, denominator: 1 }] },
  }, { exDividendDate: new Date("2026-11-06T14:30:00Z"), dividendDate: new Date("2026-11-12T14:30:00Z") });
  assert.deepEqual(result.historical, [{ exDate: "2026-08-07", amountPerShare: 1 }]);
  assert.deepEqual(result.upcoming, { exDate: "2026-11-06", paymentDate: "2026-11-12" });
  assert.equal(result.currency, "USD");
  const unknown = normalizeYahooDividends("LONDON", { meta: { currency: "GBp", exchangeTimezoneName: "Invalid/Zone" } }, undefined);
  assert.equal(unknown.currency, null);
  assert.equal(unknown.calendarAvailable, false);
  assert.equal(unknown.exchangeTimezone, "UTC");
  const midnight = normalizeYahooDividends("TSM", { meta: { currency: "USD", exchangeTimezoneName: "America/New_York" } }, { exDividendDate: new Date("2026-12-10T00:00:00Z"), dividendDate: new Date("2027-01-07T00:00:00Z") });
  assert.deepEqual(midnight.upcoming, { exDate: "2026-12-10", paymentDate: "2027-01-07" });
  assert.throws(() => normalizeYahooDividends("TSM", { meta: { symbol: "2330.TW", currency: "TWD" } }, undefined), /different dividend listing/);
});
