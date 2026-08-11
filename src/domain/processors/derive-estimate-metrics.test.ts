import assert from "node:assert/strict";
import test from "node:test";

import type { SecurityEstimateSeries } from "@/domain/metrics";
import {
  deriveConsensusWindow,
  deriveEstimateSeriesMetrics,
  replaceDerivedMetrics,
} from "./derive-estimate-metrics";

const msft: SecurityEstimateSeries = {
  providerSymbol: "NASDAQ:MSFT",
  currency: "USD",
  price: 464.72,
  points: [
    ["2026-Q1", 3.673318, true],
    ["2026-Q2", 3.902866, true],
    ["2026-Q3", 4.061552, true],
    ["2026-Q4", 4.239277, true],
    ["2027-Q1", 4.715176, false],
    ["2027-Q2", 4.838606, false],
    ["2027-Q3", 4.879865, false],
    ["2027-Q4", 5.170883, false],
  ].map(([fiscalPeriod, estimate, isHistorical]) => ({
    fiscalPeriod: fiscalPeriod as string,
    estimate: estimate as number,
    isHistorical: isHistorical as boolean,
    estimateDate: null,
    analystCount: 36,
  })),
};

test("builds every P/E window and growth from estimates only", () => {
  const result = deriveEstimateSeriesMetrics(msft);
  const historical = 3.673318 + 3.902866 + 4.061552 + 4.239277;
  const forward = 4.715176 + 4.838606 + 4.879865 + 5.170883;
  assert.ok(Math.abs((result.pe_estimate_window_0 ?? 0) - 464.72 / historical) < 1e-9);
  assert.ok(Math.abs((result.pe_estimate_window_4 ?? 0) - 464.72 / forward) < 1e-9);
  assert.ok(Math.abs((result.eps_growth_estimate_forward_4q ?? 0) - (forward / historical - 1) * 100) < 1e-9);
});

test("keeps local-currency price and EPS internally consistent", () => {
  const twse = {
    ...msft,
    providerSymbol: "TWSE:2330",
    currency: "TWD",
    price: 2425,
    points: msft.points.map((point, index) => ({ ...point, estimate: 15 + index * 2 })),
  };
  const result = deriveEstimateSeriesMetrics(twse);
  assert.equal(result.pe_estimate_window_0, 2425 / (15 + 17 + 19 + 21));
  assert.equal(result.pe_estimate_window_4, 2425 / (23 + 25 + 27 + 29));
});

test("annualizes rolling two-quarter and one-quarter consensus windows", () => {
  const simple: SecurityEstimateSeries = {
    ...msft,
    price: 120,
    points: msft.points.map((point, index) => ({ ...point, estimate: index + 1 })),
  };
  const twoQuarter = deriveConsensusWindow(simple, 2);
  const oneQuarter = deriveConsensusWindow(simple, 1);

  assert.deepEqual(twoQuarter?.annualizedEpsPath, [6, 10, 14, 18, 22, 26, 30]);
  assert.deepEqual(twoQuarter?.pePath, [120 / 6, 120 / 10, 120 / 14, 120 / 18, 120 / 22, 120 / 26, 4]);
  assert.equal(twoQuarter?.historicalAnnualizedEps, 14);
  assert.equal(twoQuarter?.forwardAnnualizedEps, 22);
  assert.ok(Math.abs((twoQuarter?.growth ?? 0) - (22 / 14 - 1) * 100) < 1e-9);
  assert.equal(twoQuarter?.annualizationFactor, 2);

  assert.deepEqual(oneQuarter?.annualizedEpsPath, [4, 8, 12, 16, 20, 24, 28, 32]);
  assert.deepEqual(oneQuarter?.pePath, [30, 15, 10, 7.5, 6, 5, 120 / 28, 3.75]);
  assert.equal(oneQuarter?.historicalAnnualizedEps, 16);
  assert.equal(oneQuarter?.forwardAnnualizedEps, 20);
  assert.equal(oneQuarter?.growth, 25);
  assert.equal(oneQuarter?.annualizationFactor, 4);
});

test("removes cached derived values that a fresh series no longer supports", () => {
  const merged = replaceDerivedMetrics(
    {
      price_to_book: 3,
      pe_estimate_window_0: 25,
      pe_estimate_window_4: 20,
    },
    { pe_estimate_window_4: 22 },
  );
  assert.equal(merged.price_to_book, 3);
  assert.equal(merged.pe_estimate_window_0, undefined);
  assert.equal(merged.pe_estimate_window_4, 22);
});
