import assert from "node:assert/strict";
import test from "node:test";

import { mergeCashPosition } from "./merge-cash-position";

test("adds cash to an existing position in the same currency", () => {
  assert.deepEqual(
    mergeCashPosition([{ currency: "USD", amount: 1_000 }], "USD", 1_000),
    [{ currency: "USD", amount: 2_000 }],
  );
});

test("preserves cash valuation metadata and refreshes its USD value", () => {
  assert.deepEqual(
    mergeCashPosition(
      [{ currency: "EUR", amount: 1_000, fxToUsd: 1.2, valueUsd: 1_200 }],
      "EUR",
      500,
    ),
    [{ currency: "EUR", amount: 1_500, fxToUsd: 1.2, valueUsd: 1_800 }],
  );
});

test("removes a cash position when the added amount offsets it exactly", () => {
  assert.deepEqual(
    mergeCashPosition([{ currency: "GBP", amount: 1_000 }], "GBP", -1_000),
    [],
  );
});
