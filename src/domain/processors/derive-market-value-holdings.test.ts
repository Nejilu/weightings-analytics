import assert from "node:assert/strict";
import test from "node:test";

import type { Holding } from "../etf";
import { deriveMarketValueHoldings } from "./derive-market-value-holdings";

function holding(
  ticker: string,
  marketValue?: number,
  securityId = `security:${ticker}`,
): Holding {
  return {
    securityId,
    ticker,
    name: ticker,
    sector: "Technology",
    assetClass: "Equity",
    country: "United States",
    weight: 0,
    marketValue,
    currency: "USD",
  };
}

test("derives weights from source market values and normalizes them to 100", () => {
  const result = deriveMarketValueHoldings(
    [holding("AAA", 60), holding("BBB", 30), holding("CCC", 10)],
    ["CCC", "AAA", "BBB"],
  );

  assert.equal(result.sourceMarketValue, 100);
  assert.deepEqual(result.missingTickers, []);
  assert.deepEqual(
    result.holdings.map(({ ticker, weight }) => [ticker, weight]),
    [
      ["AAA", 60],
      ["BBB", 30],
      ["CCC", 10],
    ],
  );
  assert.ok(
    Math.abs(
      result.holdings.reduce((total, item) => total + item.weight, 0) - 100,
    ) < 1e-10,
  );
});

test("fails rather than silently dropping a missing index constituent", () => {
  assert.throws(
    () =>
      deriveMarketValueHoldings(
        [holding("AAA", 60)],
        ["AAA", "MISSING"],
      ),
    /MISSING/,
  );
});

test("fails when a constituent has no usable market value", () => {
  assert.throws(
    () =>
      deriveMarketValueHoldings(
        [holding("AAA")],
        ["AAA"],
      ),
    /positive market value/,
  );
});

test("reports unavailable constituents while renormalizing the remaining universe", () => {
  const result = deriveMarketValueHoldings(
    [holding("AAA", 60), holding("BBB", 40)],
    ["AAA", "MISSING", "BBB"],
    { missingComponentPolicy: "exclude-and-renormalize" },
  );

  assert.deepEqual(result.missingTickers, ["MISSING"]);
  assert.equal(result.holdings.length, 2);
  assert.equal(
    result.holdings.reduce((total, item) => total + item.weight, 0),
    100,
  );
});

test("rejects ambiguous source tickers instead of selecting by row order", () => {
  assert.throws(
    () =>
      deriveMarketValueHoldings(
        [
          holding("ADP", 1, "FR0010340141"),
          holding("ADP", 40, "US0530151036"),
        ],
        ["ADP"],
        { missingComponentPolicy: "exclude-and-renormalize" },
      ),
    /Ambiguous derived component tickers: ADP.*componentSecurityIds/,
  );
});

test("uses a durable security identity to resolve an ambiguous source ticker", () => {
  const result = deriveMarketValueHoldings(
    [
      holding("ADP", 1, "FR0010340141"),
      holding("ADP", 40, "US0530151036"),
      holding("MSFT", 60, "US5949181045"),
    ],
    ["ADP", "MSFT"],
    {
      componentSecurityIds: { adp: "US0530151036" },
      missingComponentPolicy: "exclude-and-renormalize",
    },
  );

  assert.deepEqual(
    result.holdings.map(({ securityId, weight }) => [securityId, weight]),
    [
      ["US5949181045", 60],
      ["US0530151036", 40],
    ],
  );
});
