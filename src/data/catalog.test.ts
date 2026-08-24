import assert from "node:assert/strict";
import test from "node:test";

import { etfSelectorLabel } from "@/components/dashboard/etf-search";
import { ETF_CATALOG, getEtfById } from "@/data/catalog";

const accumulatingVariants = [
  ["cspx-ucits", "ivv-us", "CSPX.L"],
  ["swda-ucits", "urth-us", "SWDA.L"],
  ["ssac-ucits", "acwi-us", "SSAC.L"],
  ["eimi-ucits", "iemg-us", "EIMI.L"],
  ["cndx-ucits", "iqq-us", "CNDX.L"],
  ["qtop-ucits", "qtop-us", "QTOP.AS"],
] as const;

test("portfolio accumulating variants reuse canonical holdings and keep distinct quotes", () => {
  for (const [variantId, sourceId, priceSymbol] of accumulatingVariants) {
    const variant = getEtfById(variantId);
    const source = getEtfById(sourceId);
    assert.ok(variant, variantId);
    assert.ok(source, sourceId);
    assert.equal(variant.distributionPolicy, "Accumulating");
    assert.equal(variant.holdingsSourceEtfId, sourceId);
    assert.equal(variant.priceSymbol, priceSymbol);
    assert.notEqual(variant.priceSymbol, source.priceSymbol ?? source.ticker);
    assert.equal(variant.holdingsUrl, source.holdingsUrl);
  }
});

test("iShares selector labels lead with the underlying index and end with ticker", () => {
  const sp500 = ETF_CATALOG.find((group) => group.id === "sp-500");
  assert.ok(sp500);
  const ivv = getEtfById("ivv-us");
  const cspx = getEtfById("cspx-ucits");
  const qld = getEtfById("qld-us");
  assert.ok(ivv);
  assert.ok(cspx);
  assert.ok(qld);

  assert.equal(etfSelectorLabel(sp500.name, ivv), "S&P 500 - Dist (IVV)");
  assert.equal(etfSelectorLabel(sp500.name, cspx), "S&P 500 - Acc (CSPX)");
  assert.equal(etfSelectorLabel("Nasdaq-100", qld), "ProShares Ultra QQQ (QLD)");
});

test("fixed-component synthetic ETFs exclude unavailable source constituents and renormalize", () => {
  for (const id of ["chip-ucits", "panx-ucits"]) {
    const etf = getEtfById(id);
    assert.ok(etf, id);
    assert.equal(etf.derivedHoldings?.model, "component-market-value");
    if (etf.derivedHoldings?.model === "component-market-value") {
      assert.equal(
        etf.derivedHoldings.missingComponentPolicy,
        "exclude-and-renormalize",
      );
    }
  }

  const panx = getEtfById("panx-ucits");
  assert.ok(panx);
  assert.equal(panx.derivedHoldings?.model, "component-market-value");
  if (panx.derivedHoldings?.model === "component-market-value") {
    assert.equal(
      panx.derivedHoldings.componentSecurityIds?.ADP,
      "US0530151036",
    );
  }
});

test("supports CSEMAS as a native iShares UCITS fund with its own holdings and quote", () => {
  const csemas = getEtfById("csemas-ucits");
  assert.ok(csemas);
  assert.equal(csemas.ticker, "CSEMAS");
  assert.equal(csemas.isin, "IE00B5L8K969");
  assert.equal(csemas.wrapper, "UCITS");
  assert.equal(csemas.exchange, "SIX Swiss Exchange");
  assert.equal(csemas.tradingCurrency, "USD");
  assert.equal(csemas.distributionPolicy, "Accumulating");
  assert.equal(csemas.ter, 0.2);
  assert.equal(csemas.priceSymbol, "CSEMAS.SW");
  assert.equal(csemas.holdingsSourceEtfId, undefined);
  assert.match(csemas.holdingsUrl, /products\/253723\//);
});

test("supports BGSIX as a BlackRock mutual fund with native holdings and quote", () => {
  const bgsix = getEtfById("bgsix-us");
  assert.ok(bgsix);
  assert.equal(bgsix.ticker, "BGSIX");
  assert.equal(bgsix.isin, "US0919296121");
  assert.equal(bgsix.wrapper, "US_1940_ACT");
  assert.equal(bgsix.issuer, "BlackRock");
  assert.equal(bgsix.exchange, "Mutual fund (NAV)");
  assert.equal(bgsix.tradingCurrency, "USD");
  assert.equal(bgsix.ter, 0.89);
  assert.equal(bgsix.priceSymbol, "BGSIX");
  assert.equal(bgsix.holdingsSourceEtfId, undefined);
  assert.match(bgsix.holdingsUrl, /products\/227450\//);
});
