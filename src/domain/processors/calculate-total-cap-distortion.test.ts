import assert from "node:assert/strict";
import test from "node:test";
import type { CapitalizationReferenceData } from "../capitalization-reference";
import type { HoldingsAnalysisPosition, DistortionReferencePosition } from "../holdings-analysis";
import { calculateTotalCapDistortion } from "./calculate-total-cap-distortion";

const reference = { referenceEtfId: "acwi", referenceTicker: "ACWI", referenceAsOf: "2026-10-09" };
const p = (id: string, weight: number): HoldingsAnalysisPosition => ({ securityId: id, ticker: id, name: id, sector: "Tech", country: "US", assetClass: "Equity", isCash: false, publishedWeight: weight, normalizedWeightExCash: weight, actualWeight: null, counterfactualWeight: null, weightDelta: null, distortionContribution: null, distortionStatus: "not-in-acwi" });
const r = (id: string, weight: number): DistortionReferencePosition => ({ ...p(id, weight), weight });
const caps = (values: Record<string, number>): CapitalizationReferenceData => ({ currency: "USD", source: "tradingview", universe: "market", fetchedAt: "2026-10-12", observations: Object.entries(values).map(([securityId, marketCapUsd]) => ({ securityId, ticker: securityId, marketCapUsd, providerSymbol: securityId, capturedAt: "2026-10-12", status: "available" })) });

test("total-cap top holdings use company caps, including stocks outside ACWI, without changing the input", () => {
  const positions = [p("A", 60), p("OUT", 40), p("TAIL", 1), { ...p("CASH", 50), isCash: true, assetClass: "Cash" }, p("SHORT", -10)];
  const original = structuredClone(positions);
  const result = calculateTotalCapDistortion(positions, [r("A", 99), r("TAIL", 1)], reference, caps({ A: 300, OUT: 100, TAIL: 900 }), "top-holdings", 2);
  assert.equal(result.distortion.score, 15);
  assert.equal(result.distortion.topCount, 2);
  assert.equal(result.positions.find((p) => p.securityId === "A")?.counterfactualWeight, 75);
  assert.equal(result.positions.find((p) => p.securityId === "OUT")?.counterfactualWeight, 25);
  assert.deepEqual(positions, original);
});

test("market coverage keeps unheld benchmark companies and outside-ACWI positions, with cap-weighted ACWI", () => {
  const result = calculateTotalCapDistortion([p("A", 80), p("OUT", 20)], [r("A", 50), r("B", 50)], reference, caps({ A: 100, B: 300 }), "market-coverage");
  assert.equal(result.distortion.score, 75);
  assert.equal(result.positions.find((p) => p.securityId === "B")?.counterfactualWeight, 75);
  assert.equal(result.positions.find((p) => p.securityId === "B")?.actualWeight, 0);
  assert.equal(result.positions.find((p) => p.securityId === "OUT")?.counterfactualWeight, 0);
});

test("missing top caps never backfill the selection or appear as zero benchmark weights", () => {
  const result = calculateTotalCapDistortion([p("MISSING", 60), p("A", 35), p("TAIL", 5)], [], reference, caps({ A: 100, TAIL: 100 }), "top-holdings", 2);
  assert.equal(result.distortion.score, null);
  assert.equal(result.distortion.topCount, 2);
  assert.ok(!result.positions.some((p) => p.securityId === "TAIL"));
  assert.equal(result.positions.find((p) => p.securityId === "MISSING")?.distortionStatus, "missing-capitalization");
  assert.ok(result.positions.every((p) => p.weightDelta === null));
});

test("a small missing exposure yields a clearly partial score on the covered universe", () => {
  const result = calculateTotalCapDistortion([p("A", 70), p("B", 26), p("MISSING", 4)], [], reference, caps({ A: 100, B: 100 }), "all-holdings");
  assert.equal(result.distortion.coverageWeight, 96);
  assert.equal(result.distortion.capitalizationCoverage?.excludedHoldings, 1);
  assert.equal(result.distortion.coverageStatus, "partial");
  assert.ok(result.distortion.score !== null);
});

test("market coverage refuses an incomplete reference even when held companies are fully covered", () => {
  const result = calculateTotalCapDistortion([p("A", 100)], [r("A", 98), r("MISSING", 2)], reference, caps({ A: 100 }), "market-coverage");
  assert.equal(result.distortion.coverageWeight, 100);
  assert.equal(result.distortion.capitalizationCoverage?.referenceWeightCoverage, 98);
  assert.equal(result.distortion.score, null);
  assert.ok(result.positions.every((p) => p.counterfactualWeight === null));
});

test("multiple share classes contribute their combined exposure and one company cap to the benchmark", () => {
  const data = caps({ ORDINARY: 100, PREFERRED: 100, OTHER: 100 });
  data.observations[0].companyId = "company:samsung";
  data.observations[1].companyId = "company:samsung";
  const result = calculateTotalCapDistortion([p("ORDINARY", 30), p("PREFERRED", 20), p("OTHER", 50)], [r("ORDINARY", 30), r("PREFERRED", 20), r("OTHER", 50)], reference, data, "market-coverage");
  assert.equal(result.distortion.referenceHoldings, 2);
  assert.equal(result.distortion.score, 0);
  assert.equal(result.positions.find((p) => p.securityId === "company:samsung")?.publishedWeight, 50);
  assert.equal(result.positions.find((p) => p.securityId === "company:samsung")?.counterfactualWeight, 50);
});
