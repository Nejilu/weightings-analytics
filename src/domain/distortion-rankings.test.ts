import assert from "node:assert/strict";
import test from "node:test";
import type { HoldingsAnalysisPosition } from "./holdings-analysis";
import { absoluteDistortionLabel, rankDistortionPositions, rankDistortionTablePositions, relativeDistortionLabel } from "./distortion-rankings";

function position(id: string, actual: number, benchmark: number): HoldingsAnalysisPosition {
  return {
    securityId: id, ticker: id, name: id, sector: "Technology", country: "US", assetClass: "Equity",
    isCash: false, publishedWeight: actual, normalizedWeightExCash: actual,
    actualWeight: actual, counterfactualWeight: benchmark, weightDelta: actual - benchmark,
    distortionContribution: Math.abs(actual - benchmark) / 2, distortionStatus: "covered",
  };
}

test("absolute and relative rankings separately order both sides of the counterfactual", () => {
  const positions = [position("LARGE_OVER", 20, 10), position("SMALL_OVER", 3, 1),
    position("LARGE_UNDER", 10, 20), position("SMALL_UNDER", 1, 5), position("ALIGNED", 4, 4)];
  const original = structuredClone(positions);
  const absolute = rankDistortionPositions(positions, "absolute");
  const relative = rankDistortionPositions(positions, "relative");
  assert.deepEqual(absolute.overweights.map((p) => p.ticker), ["LARGE_OVER", "SMALL_OVER"]);
  assert.deepEqual(relative.overweights.map((p) => p.ticker), ["SMALL_OVER", "LARGE_OVER"]);
  assert.deepEqual(absolute.underweights.map((p) => p.ticker), ["LARGE_UNDER", "SMALL_UNDER"]);
  assert.deepEqual(relative.underweights.map((p) => p.ticker), ["SMALL_UNDER", "LARGE_UNDER"]);
  assert.equal(relative.overweights[0].relativeWeight, 3);
  assert.equal(relative.underweights[0].relativeWeight, 0.2);
  assert.deepEqual(positions, original);
});

test("zero benchmark weights stay in absolute ranks while unheld ACWI securities have a zero relative weight", () => {
  const positions = [position("OUTSIDE", 3, 0), position("UNHELD_SMALL", 0, 1), position("UNHELD_LARGE", 0, 5),
    { ...position("UNMATCHED", 5, 2), actualWeight: null, counterfactualWeight: null, weightDelta: null }];
  const absolute = rankDistortionPositions(positions, "absolute");
  const relative = rankDistortionPositions(positions, "relative");
  assert.equal(absolute.overweights[0].ticker, "OUTSIDE");
  assert.equal(relative.overweights.length, 0);
  assert.equal(relative.noBenchmarkCount, 1);
  assert.deepEqual(relative.underweights.map((p) => p.ticker), ["UNHELD_LARGE", "UNHELD_SMALL"]);
  assert.equal(relative.underweights[0].relativeWeight, 0);
});

test("relative labels always express multiplication, including underweights and absence", () => {
  assert.equal(relativeDistortionLabel(2), "×2.00");
  assert.equal(relativeDistortionLabel(0.5), "×0.50");
  assert.equal(relativeDistortionLabel(0.2), "×0.20");
  assert.equal(relativeDistortionLabel(0), "×0");
  assert.equal(relativeDistortionLabel(1.001), "×1.0010");
  assert.equal(relativeDistortionLabel(0.999), "×0.9990");
  assert.equal(relativeDistortionLabel(0.0034), "×0.0034");
  assert.equal(absoluteDistortionLabel(1.5), "+1.50 pp");
  assert.equal(absoluteDistortionLabel(-0.2), "-0.20 pp");
  assert.equal(absoluteDistortionLabel(0.0034), "+0.0034 pp");
});

test("the table defaults to ETF weight and provides distinct delta and symmetric multiple rankings", () => {
  const positions = [position("SMALL_UNDER", 0.1, 1), position("ALIGNED", 8, 8),
    position("SMALL_OVER", 4, 1), position("OUTSIDE", 10, 0),
    position("UNHELD", 0, 2), position("HEAVY", 40, 25)];
  const original = structuredClone(positions);
  assert.deepEqual(rankDistortionTablePositions(positions).map((p) => p.ticker),
    ["HEAVY", "OUTSIDE", "ALIGNED", "SMALL_OVER", "SMALL_UNDER", "UNHELD"]);
  assert.deepEqual(rankDistortionTablePositions(positions, "absolute").map((p) => p.ticker),
    ["HEAVY", "OUTSIDE", "SMALL_OVER", "UNHELD", "SMALL_UNDER", "ALIGNED"]);
  const relative = rankDistortionTablePositions(positions, "relative");
  assert.deepEqual(relative.map((p) => p.ticker),
    ["UNHELD", "SMALL_UNDER", "SMALL_OVER", "HEAVY", "ALIGNED", "OUTSIDE"]);
  assert.equal(relative.find((p) => p.ticker === "SMALL_OVER")?.relativeWeight, 4);
  assert.equal(relative.find((p) => p.ticker === "SMALL_UNDER")?.relativeWeight, 0.1);
  assert.equal(relative.find((p) => p.ticker === "OUTSIDE")?.relativeWeight, null);
  assert.deepEqual(positions, original);
});

test("table multiples rank symmetric overweights and underweights equally and keep zero-weight ties deterministic", () => {
  const positions = [position("DOUBLE", 10, 5), position("HALF", 5, 10),
    position("UNHELD_SMALL", 0, 1), position("UNHELD_BIG", 0, 2), position("CLOSER", 10, 8)];
  const rows = rankDistortionTablePositions(positions, "relative");
  assert.deepEqual(rows.map((p) => p.ticker), ["UNHELD_BIG", "UNHELD_SMALL", "DOUBLE", "HALF", "CLOSER"]);
  assert.equal(relativeDistortionLabel(rows[2].relativeWeight!), "×2.00");
  assert.equal(relativeDistortionLabel(rows[3].relativeWeight!), "×0.50");
});
