import assert from "node:assert/strict";
import test from "node:test";
import type { PortfolioItem, PortfolioLookThroughPosition } from "./portfolio";
import { portfolioPositionQuantity } from "./portfolio-position-quantity";

const item: PortfolioItem = {
  id: "owned", kind: "security", referenceId: "oracle", ticker: "ORCL",
  name: "Oracle", quantity: 10, currentPriceUsd: 100, currentValueUsd: 1_000,
  allocationWeight: 100,
};
const position: PortfolioLookThroughPosition = {
  securityId: "oracle", ticker: "ORCL", name: "Oracle", sector: "Technology",
  assetClass: "Equity", country: "United States", weight: 100,
  quoteSecurityId: "oracle", quoteTicker: "ORCL",
  contributions: [{ itemId: "owned", ticker: "ORCL", kind: "security", weight: 100 }],
};

test("direct shares stay exact despite reconstructed exposure rounding or a changed valuation", () => {
  assert.equal(portfolioPositionQuantity(position, [item], 999.9999999998), 10);
  assert.equal(portfolioPositionQuantity(position, [{ ...item, currentPriceUsd: 100.2 }], 1_002), 10);
  assert.equal(portfolioPositionQuantity(position, [{ ...item, currentPriceUsd: undefined }], 1_000), 10);
});

test("published IDs do not affect quantities; fractional and short shares stay unchanged", () => {
  const published = { ...position, contributions: [{ ...position.contributions[0], itemId: "source:security:ORCL" }] };
  assert.equal(portfolioPositionQuantity(published, [{ ...item, id: "published-item-0", quantity: -2.75 }], -275), -2.75);
  assert.equal(portfolioPositionQuantity(position, [item, { ...item, id: "short", quantity: -10 }], 0), 0);
});

test("a single economic-group listing retains its exact owned quantity", () => {
  const samsung = { ...position, securityId: "economic:samsung-electronics", ticker: "005930 / SMSD",
    quoteSecurityId: "smsd", quoteTicker: "SMSD" };
  const owned = { ...item, referenceId: "smsd", ticker: "SMSD", name: "SAMSUNG ELECTRONICS GDR" };
  assert.equal(portfolioPositionQuantity(samsung, [owned], 999.98), 10);
});

test("direct and ETF exposure use the owned listing's valuation price", () => {
  const mixed = { ...position, contributions: [...position.contributions,
    { itemId: "fund", ticker: "ETF", kind: "etf" as const, weight: 20 }] };
  assert.equal(portfolioPositionQuantity(mixed, [item], 1_500), 15);
  assert.equal(portfolioPositionQuantity(mixed, [{ ...item, currentPriceUsd: 120 }], 1_800), 15);
});

test("different listings in an economic group convert exposure instead of adding unlike shares", () => {
  const grouped = { ...position, securityId: "economic:alphabet", ticker: "GOOG / GOOGL",
    quoteSecurityId: "class-a", quoteTicker: "GOOGL", contributions: [
      { itemId: "a", ticker: "GOOGL", kind: "security" as const, weight: 60 },
      { itemId: "c", ticker: "GOOG", kind: "security" as const, weight: 40 },
    ] };
  const items = [
    { ...item, id: "a", referenceId: "class-a", ticker: "GOOGL", name: "ALPHABET INC", quantity: 10 },
    { ...item, id: "c", referenceId: "class-c", ticker: "GOOG", name: "ALPHABET INC", quantity: 20 },
  ];
  assert.equal(portfolioPositionQuantity(grouped, items, 2_500), 25);
  assert.equal(portfolioPositionQuantity({ ...grouped, quoteSecurityId: "other-listing" }, items, 2_500), undefined);
});

test("ETF-only exposures and missing amounts still require an equivalent-share quote", () => {
  assert.equal(portfolioPositionQuantity(position, [], 1_000), undefined);
  assert.equal(portfolioPositionQuantity(position, [{ ...item, quantity: undefined, currentPriceUsd: undefined }], 1_000), undefined);
});
