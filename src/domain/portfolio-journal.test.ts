import assert from "node:assert/strict";
import test from "node:test";
import { applyJournalPatch, compositionPatch, emptyJournalComposition, reconstructPortfolio, valueCounterfactual } from "./portfolio-journal";
import { portfolioJournalFixture } from "./portfolio-journal.test-fixture";

test("every recorded fixture state can be recovered by reversing only subsequent edits", () => {
  const { journal, market } = portfolioJournalFixture;
  let expected = emptyJournalComposition();
  const original = JSON.stringify(journal);
  for (const entry of journal.entries) {
    expected = applyJournalPatch(expected, entry.patch);
    const past = reconstructPortfolio(journal, entry.id);
    assert.deepEqual(past.items.slice().sort((a, b) => a.ticker.localeCompare(b.ticker)), expected.items.slice().sort((a, b) => a.ticker.localeCompare(b.ticker)));
    assert.deepEqual(past.cashPositions, expected.cashPositions);
    assert.equal(past.name, expected.name);
  }
  assert.equal(valueCounterfactual(journal.current, market).valueUsd, 124000);
  assert.equal(valueCounterfactual(reconstructPortfolio(journal, 1), market).valueUsd, 112200);
  assert.equal(journal.entries[1].patch.items.some((p) => p.after?.ticker === "NVDA"), true);
  assert.equal(journal.entries[3].patch.items.some((p) => p.after?.ticker === "MSFT"), false); // unchanged line not duplicated
  assert.equal(JSON.stringify(journal), original);
});

test("unlogged changes and unknown entries are rejected instead of inventing a history", () => {
  const journal = structuredClone(portfolioJournalFixture.journal);
  journal.current.cashPositions[0].amount += 1;
  assert.throws(() => reconstructPortfolio(journal, 1), /outside this journal/);
  assert.throws(() => reconstructPortfolio(portfolioJournalFixture.journal, 999), /entry is unavailable/);
  const missingEntry = structuredClone(portfolioJournalFixture.journal);
  missingEntry.entries.splice(1, 1);
  assert.throws(() => reconstructPortfolio(missingEntry, 1), /incomplete/);
});

test("diffs ignore generated line IDs and market weights, but reverse additions, removals, shorts and cash", () => {
  const before = reconstructPortfolio(portfolioJournalFixture.journal, 3);
  const after = reconstructPortfolio(portfolioJournalFixture.journal, 4);
  const patch = compositionPatch(before, after);
  assert.deepEqual(compositionPatch(after, applyJournalPatch(before, patch)).items, []);
  assert.deepEqual(compositionPatch(before, applyJournalPatch(after, patch, true)).cash, []);
  assert(patch.items.some((p) => p.after?.quantity === -40));
  assert(patch.items.some((p) => p.before?.ticker === "AAPL" && p.after === null));
});

test("unknown quantities, delisted securities and missing FX never produce a partial total", () => {
  const composition = structuredClone(portfolioJournalFixture.journal.current);
  const market = structuredClone(portfolioJournalFixture.market);
  delete market.fx.EUR;
  composition.cashPositions.push({ currency: "EUR", amount: -1000 });
  let valuation = valueCounterfactual(composition, market);
  assert.equal(valuation.valueUsd, null);
  assert.deepEqual(valuation.missing, ["EUR cash"]);
  market.fx.EUR = { rateToUsd: 1.2, asOf: "2026-10-21", stale: true };
  valuation = valueCounterfactual(composition, market);
  assert.equal(valuation.valueUsd, 122800);
  assert.equal(valuation.stale, true);
  composition.items[0].quantity = null;
  assert.equal(valueCounterfactual(composition, market).valueUsd, null);
  delete market.prices["security:demo-NVDA"];
  assert.deepEqual(valueCounterfactual(composition, market).missing, ["MSFT", "NVDA"]);
});
