import assert from "node:assert/strict";
import test from "node:test";
import { applyJournalPatch, compositionPatch, emptyJournalComposition, journalEntryTitle, patchIsEmpty, reconstructPortfolio, removeJournalEntry, valueCounterfactual, type JournalComposition, type PortfolioJournal } from "./portfolio-journal";
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

test("deleting any past state preserves every surviving composition, timestamp and recorded value", () => {
  const original = structuredClone(portfolioJournalFixture.journal);
  const normalize = (state: JournalComposition) => ({ ...state,
    items: state.items.slice().sort((a, b) => a.referenceId.localeCompare(b.referenceId)),
    cashPositions: state.cashPositions.slice().sort((a, b) => a.currency.localeCompare(b.currency)),
  });
  for (const removed of original.entries.slice(0, -1)) {
    const result = removeJournalEntry(original, removed.id);
    assert.equal(result.entries.length, original.entries.length - 1);
    assert.equal(result.entries.some((entry) => entry.id === removed.id), false);
    assert.deepEqual(result.current, original.current);
    for (const kept of result.entries) {
      const prior = original.entries.find((entry) => entry.id === kept.id)!;
      assert.equal(kept.capturedAt, prior.capturedAt);
      assert.equal(kept.valueUsd, prior.valueUsd);
      assert.deepEqual(normalize(reconstructPortfolio(result, kept.id)), normalize(reconstructPortfolio(original, kept.id)));
    }
    if (removed === original.entries[0]) assert.equal(result.entries[0].kind, "baseline");
  }
  assert.deepEqual(original, portfolioJournalFixture.journal);
  let pruned = original;
  for (const entry of original.entries.slice(0, -1)) pruned = removeJournalEntry(pruned, entry.id);
  assert.equal(pruned.entries.length, 1);
  assert.deepEqual(normalize(reconstructPortfolio(pruned, pruned.entries[0].id)), normalize(original.current));
});

test("removing the temporary $1,000 cash addition retains the actual book and a truthful successor label", () => {
  const states: JournalComposition[] = [10000, 11000, 10000].map((amount) => ({ name: "Personal PF test", items: [], cashPositions: [{ currency: "USD", amount }] }));
  const journal: PortfolioJournal = { portfolioId: "test", current: states[2], entries: states.map((state, index) => ({
    id: index + 1, kind: index === 0 ? "baseline" : "edited", capturedAt: `2026-10-23T16:0${index}:00Z`, valueUsd: state.cashPositions[0].amount,
    patch: compositionPatch(states[index - 1] ?? emptyJournalComposition(), state),
  })) };
  const result = removeJournalEntry(journal, 2);
  assert.deepEqual(reconstructPortfolio(result, 1), states[0]);
  assert.deepEqual(reconstructPortfolio(result, 3), states[2]);
  assert(patchIsEmpty(result.entries[1].patch));
  assert.equal(journalEntryTitle(result.entries[1]), "Composition unchanged");
  assert.equal(result.entries[1].valueUsd, 10000);
});

test("deletion rejects the current state, missing entries and incomplete histories", () => {
  const journal = structuredClone(portfolioJournalFixture.journal);
  assert.throws(() => removeJournalEntry(journal, journal.entries.at(-1)!.id), /current composition must stay/);
  assert.throws(() => removeJournalEntry(journal, 99999), /entry is unavailable/);
  journal.entries.splice(1, 1);
  assert.throws(() => removeJournalEntry(journal, 1), /incomplete/);
});
