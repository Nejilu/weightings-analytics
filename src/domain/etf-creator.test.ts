import assert from "node:assert/strict";
import test from "node:test";

import type { Holding } from "./etf";
import {
  applyCreatorManualCuration,
  filterCreatorHoldings,
  normalizeCreatorHoldings,
} from "./etf-creator";

const holdings: Holding[] = [
  {
    securityId: "A",
    ticker: "AAA",
    name: "Alpha",
    sector: "Technology",
    assetClass: "Equity",
    country: "United States",
    weight: 60,
  },
  {
    securityId: "B",
    ticker: "BBB",
    name: "Beta",
    sector: "Financials",
    assetClass: "Equity",
    country: "France",
    weight: 30,
  },
  {
    securityId: "C",
    ticker: "CCC",
    name: "Gamma",
    sector: "Technology",
    assetClass: "Equity",
    country: "France",
    weight: 10,
  },
];

test("filters the ACWI universe by geography, sector and overlap", () => {
  const result = filterCreatorHoldings(
    holdings,
    {
      countryMode: "include",
      countries: ["France"],
      sectorMode: "exclude",
      sectors: ["Financials"],
      overlapMode: "include",
      overlapEtfId: "peer",
    },
    new Set(["A", "C"]),
  );

  assert.deepEqual(result.map((holding) => holding.securityId), ["C"]);
});

test("renormalizes retained free-float weights to exactly 100", () => {
  const result = normalizeCreatorHoldings([holdings[1], holdings[2]]);

  assert.equal(result.reduce((sum, holding) => sum + holding.weight, 0), 100);
  assert.equal(result[0].securityId, "B");
  assert.equal(result[0].weight, 75);
  assert.equal(result[1].weight, 25);
});

test("manual curation can add filtered-out holdings and remove rule matches", () => {
  const automatic = [holdings[0], holdings[2]];
  const result = applyCreatorManualCuration(
    holdings,
    automatic,
    new Set(["B"]),
    new Set(["A"]),
  );

  assert.deepEqual(result.map((holding) => holding.securityId), ["B", "C"]);
});
