import assert from "node:assert/strict";
import test from "node:test";

import type { Holding } from "./etf";
import {
  mergeEquivalentHoldings,
  securityListingQuoteSymbol,
  securityQuoteAlias,
} from "./security-equivalence";

function holding(
  securityId: string,
  ticker: string,
  name: string,
  weight: number,
): Holding {
  return {
    securityId,
    ticker,
    name,
    sector: "Information Technology",
    assetClass: "Equity",
    country: "Test",
    weight,
  };
}

test("maps Asian primary listings to explicit Yahoo depositary symbols", () => {
  assert.deepEqual(
    securityQuoteAlias({
      ticker: "2330",
      name: "TAIWAN SEMICONDUCTOR MANUFACTURING",
    }),
    {
      displayTicker: "TSM",
      providerSymbol: "TSM",
      instrumentType: "ADR",
      underlyingTicker: "2330",
    },
  );
  assert.deepEqual(
    securityQuoteAlias({
      ticker: "000660",
      name: "SK HYNIX INC",
    }),
    {
      displayTicker: "HY9H",
      providerSymbol: "HY9H.F",
      instrumentType: "GDR",
      underlyingTicker: "000660",
    },
  );
});

test("builds explicit Yahoo symbols for dominant local Asian listings", () => {
  assert.equal(
    securityListingQuoteSymbol(
      { ticker: "005930", name: "SAMSUNG ELECTRONICS LTD", country: "Korea (South)" },
      "005930",
    ),
    "005930.KS",
  );
  assert.equal(
    securityListingQuoteSymbol(
      { ticker: "2330", name: "TAIWAN SEMICONDUCTOR", country: "Taiwan" },
      "2330",
    ),
    "2330.TW",
  );
  assert.equal(
    securityListingQuoteSymbol(
      { ticker: "GOOGL", name: "ALPHABET INC", country: "United States" },
      "GOOGL",
    ),
    "GOOGL",
  );
});

test("merges depositary receipts and share classes into economic positions", () => {
  const merged = mergeEquivalentHoldings([
    holding("alphabet-a", "GOOGL", "ALPHABET INC CLASS A", 12),
    holding("alphabet-c", "GOOG", "ALPHABET INC CLASS C", 10),
    holding("tsmc-primary", "2330", "TAIWAN SEMICONDUCTOR MANUFACTURING", 8),
    holding("tsmc-adr", "TSM", "TAIWAN SEMICONDUCTOR ADR", 2),
    holding("asml-primary", "ASML", "ASML HOLDING", 4),
    holding("asml-adr", "ASML", "ASML HOLDING ADR REPRESENTING", 1),
  ]);

  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map(({ ticker, weight }) => [ticker, weight]),
    [
      ["GOOG / GOOGL", 22],
      ["TSM / 2330", 10],
      ["ASML", 5],
    ],
  );
});
