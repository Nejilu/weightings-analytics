import assert from "node:assert/strict";
import test from "node:test";

import type { PortfolioItem } from "../portfolio";
import { mergePortfolioPosition } from "./merge-portfolio-position";

const existing: PortfolioItem = {
  id: "saved-nvda", kind: "security", referenceId: "nvda", ticker: "NVDA",
  name: "NVIDIA", allocationWeight: 100, quantity: 10,
  currentPriceUsd: 90, currentValueUsd: 900,
};
const addition: PortfolioItem = {
  ...existing, id: "new-nvda", quantity: 500 / 120,
  inputMode: "value", inputAmount: 500, currentPriceUsd: 120,
  currentValueUsd: 500, priceAsOf: "2026-09-22", priceStatus: "live",
};

test("adds a USD entry to existing shares and revalues the full position at the quoted price", () => {
  const [merged] = mergePortfolioPosition([existing], addition);
  assert.equal(merged.id, existing.id);
  assert.equal(merged.quantity, 10 + 500 / 120);
  assert.ok(Math.abs(merged.currentValueUsd! - 1700) < 1e-10);
  assert.equal(merged.inputMode, "shares");
  assert.equal(merged.inputAmount, merged.quantity);
  assert.equal(merged.priceAsOf, addition.priceAsOf);
  assert.equal(existing.quantity, 10);
  assert.equal(existing.currentValueUsd, 900);
});

test("signed share additions reduce, close, reverse, and cover positions", () => {
  for (const [start, delta, expected] of [
    [10, -4, 6], [10, -10, 0], [10, -15, -5], [-10, 4, -6], [-10, 15, 5],
    [0.1 + 0.2, -0.3, 0],
  ]) {
    const result = mergePortfolioPosition(
      [{ ...existing, quantity: start }], { ...addition, quantity: delta },
    );
    assert.equal(result.length, expected === 0 ? 0 : 1);
    if (expected !== 0) assert.equal(result[0].quantity, expected);
  }
});

test("merges ETFs too and keeps unrelated identities and line order intact", () => {
  const etf: PortfolioItem = { ...existing, id: "etf", kind: "etf" };
  const other = { ...existing, id: "other", referenceId: "other" };
  const result = mergePortfolioPosition([other, etf, existing], { ...addition, kind: "etf" });
  assert.equal(result.length, 3);
  assert.equal(result[0], other);
  assert.equal(result[1].id, etf.id);
  assert.equal(result[1].quantity, 10 + 500 / 120);
  assert.equal(result[2], existing);
  assert.deepEqual(mergePortfolioPosition([other], addition), [other, addition]);
});
