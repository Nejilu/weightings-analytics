import assert from "node:assert/strict";
import test from "node:test";
import { tradingViewSessionSeconds } from "./tradingview-chart";

test("provider session calendar handles regular days, early closes and dayoffs", () => {
  const corrections = "0930-1300:20261127,20261224;dayoff:20250109";
  assert.equal(tradingViewSessionSeconds("0930-1600", corrections, "2026-10-08"), 23_400);
  assert.equal(tradingViewSessionSeconds("0930-1600", corrections, "2026-11-27"), 12_600);
  assert.equal(tradingViewSessionSeconds("0930-1600", corrections, "2026-12-24"), 12_600);
  assert.equal(tradingViewSessionSeconds("0930-1600", corrections, "2025-01-09"), null);
  assert.equal(tradingViewSessionSeconds("unknown", "", "2026-10-08"), null);
  assert.equal(tradingViewSessionSeconds("0800-2000", "", "2026-11-18"), 43_200);
});
