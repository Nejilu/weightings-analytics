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
      {
        ticker: "BABA",
        name: "ALIBABA GROUP HOLDING ADR",
        country: "China",
        exchange: "NYSE",
      },
    ),
    "BABA",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "6857",
        name: "ADVANTEST",
        country: "Japan",
        exchange: "Tokyo Stock Exchange",
      },
    ),
    "6857.T",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "6857.T",
        name: "ADVANTEST",
        country: "Japan",
        exchange: "Tokyo Stock Exchange",
      },
    ),
    "6857.T",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "036930",
        name: "JUSUNG ENGINEERING",
        country: "Korea (South)",
        exchange: "Korea Exchange (Kosdaq)",
      },
    ),
    "036930.KQ",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "6488",
        name: "GLOBALWAFERS",
        country: "Taiwan",
        exchange: "Gretai Securities Market",
      },
    ),
    "6488.TWO",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "700",
        name: "TENCENT HOLDINGS",
        country: "China",
        exchange: "Hong Kong Exchanges And Clearing Ltd",
      },
    ),
    "0700.HK",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "600519",
        name: "KWEICHOW MOUTAI",
        country: "China",
        exchange: "Shanghai Stock Exchange",
      },
    ),
    "600519.SS",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "000001",
        name: "PING AN BANK",
        country: "China",
        exchange: "Shenzhen Stock Exchange",
      },
    ),
    "000001.SZ",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "2222",
        name: "SAUDI ARABIAN OIL",
        country: "Saudi Arabia",
        exchange: "Saudi Stock Exchange",
      },
    ),
    "2222.SR",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "BAJAJ.AUTO",
        name: "BAJAJ AUTO",
        country: "India",
        exchange: "National Stock Exchange Of India",
      },
    ),
    "BAJAJ-AUTO.NS",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "532483",
        name: "CANARA BANK LTD",
        country: "India",
        exchange: "Bse Ltd",
      },
    ),
    "CANBK.BO",
  );
  assert.equal(
    securityListingQuoteSymbol(
      {
        ticker: "CICT",
        name: "CAPITALAND INTEGRATED COMMERCIAL TRUST",
        country: "Singapore",
        exchange: "Singapore Exchange",
      },
    ),
    "C38U.SI",
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
