import assert from "node:assert/strict";
import test from "node:test";

import {
  fallbackSecurityId,
  planSecurityIdentityMerges,
  preferredSecurityId,
  securityCanonicalNameIdentity,
} from "./security-identity";

test("prefers durable market identifiers over source fallback IDs", () => {
  assert.equal(
    preferredSecurityId({
      securityId: fallbackSecurityId("Apple Inc", "AAPL"),
      isin: "US0378331005",
    }),
    "US0378331005",
  );
  assert.equal(
    preferredSecurityId({ securityId: "NAME:TEST:TEST", sedol: "2046251" }),
    "SEDOL:2046251",
  );
});

test("converges legacy name identities onto one unique ISIN identity", () => {
  assert.deepEqual(
    planSecurityIdentityMerges([
      {
        securityId: "NAME:APPLEINC",
        ticker: "AAPL",
        name: "APPLE INC",
        country: "United States",
      },
      {
        securityId: "NAME:APPLEINC:AAPL",
        ticker: "AAPL",
        name: "APPLE INC",
        country: "United States",
      },
      {
        securityId: "US0378331005",
        ticker: "AAPL",
        name: "APPLE INC",
        country: "United States",
        isin: "US0378331005",
      },
    ]),
    [
      { sourceId: "NAME:APPLEINC", targetId: "US0378331005" },
      { sourceId: "NAME:APPLEINC:AAPL", targetId: "US0378331005" },
    ],
  );
});

test("converges provider name variants using one unambiguous ticker and country", () => {
  assert.deepEqual(
    planSecurityIdentityMerges([
      {
        securityId: "NAME:MICROSOFTCORP",
        ticker: "MSFT",
        name: "MICROSOFT CORP",
        country: "United States",
      },
      {
        securityId: "US5949181045",
        ticker: "MSFT",
        name: "MICROSOFT",
        country: "United States",
        isin: "US5949181045",
      },
      {
        securityId: "NAME:ORACLECORP",
        ticker: "ORCL",
        name: "ORACLE CORP",
        country: "United States",
      },
      {
        securityId: "US68389X1054",
        ticker: "ORCL",
        name: "ORACLE",
        country: "United States",
        isin: "US68389X1054",
      },
    ]),
    [
      { sourceId: "NAME:MICROSOFTCORP", targetId: "US5949181045" },
      { sourceId: "NAME:ORACLECORP", targetId: "US68389X1054" },
    ],
  );
});

test("keeps genuinely ambiguous strong identities and distinct share classes separate", () => {
  assert.deepEqual(
    planSecurityIdentityMerges([
      {
        securityId: "NAME:EXAMPLEINC:ABC",
        ticker: "ABC",
        name: "EXAMPLE INC",
        country: "United States",
      },
      {
        securityId: "US0000000001",
        ticker: "ABC",
        name: "EXAMPLE INC",
        country: "United States",
        isin: "US0000000001",
      },
      {
        securityId: "US0000000002",
        ticker: "ABC",
        name: "EXAMPLE INC",
        country: "United States",
        isin: "US0000000002",
      },
      {
        securityId: "NAME:CHOCOLATE:LISN",
        ticker: "LISN",
        name: "CHOCOLATE",
        country: "Switzerland",
      },
      {
        securityId: "NAME:CHOCOLATE:LISP",
        ticker: "LISP",
        name: "CHOCOLATE",
        country: "Switzerland",
      },
    ]),
    [],
  );
});

test("upgrades a SEDOL fallback when the same listing later gains an ISIN", () => {
  assert.deepEqual(
    planSecurityIdentityMerges([
      {
        securityId: "SEDOL:2046251",
        ticker: "AAPL",
        name: "APPLE INC",
        country: "United States",
        sedol: "2046251",
      },
      {
        securityId: "US0378331005",
        ticker: "AAPL",
        name: "APPLE INC",
        country: "United States",
        isin: "US0378331005",
        sedol: "2046251",
      },
    ]),
    [{ sourceId: "SEDOL:2046251", targetId: "US0378331005" }],
  );
});

test("joins matching strong identifiers despite provider label changes", () => {
  assert.deepEqual(
    planSecurityIdentityMerges([
      {
        securityId: "SEDOL:2046251",
        ticker: "AAPL-US",
        name: "Apple Computer",
        country: "US",
        sedol: "2046251",
      },
      {
        securityId: "US0378331005",
        ticker: "AAPL",
        name: "APPLE INC",
        country: "United States",
        isin: "US0378331005",
        sedol: "2046251",
      },
    ]),
    [{ sourceId: "SEDOL:2046251", targetId: "US0378331005" }],
  );
});

test("normalizes corporate suffixes while retaining share-class identity", () => {
  assert.equal(securityCanonicalNameIdentity("Apple Inc."), "APPLE");
  assert.equal(
    securityCanonicalNameIdentity("Alphabet Inc Class A"),
    "ALPHABETCLASSA",
  );
  assert.notEqual(
    securityCanonicalNameIdentity("Alphabet Inc Class A"),
    securityCanonicalNameIdentity("Alphabet Inc Class C"),
  );
});

test("resolves tickerless provider names to one unique durable identity", () => {
  assert.deepEqual(
    planSecurityIdentityMerges([
      {
        securityId: "NAME:APPLEINC",
        name: "APPLE INC",
      },
      {
        securityId: "US0378331005",
        ticker: "AAPL",
        name: "APPLE",
        country: "United States",
        isin: "US0378331005",
      },
      {
        securityId: "NAME:ALPHABETINCCLASSA",
        name: "ALPHABET INC CLASS A",
      },
      {
        securityId: "US02079K3059",
        ticker: "GOOGL",
        name: "ALPHABET CLASS A",
        country: "United States",
        isin: "US02079K3059",
      },
      {
        securityId: "US02079K1079",
        ticker: "GOOG",
        name: "ALPHABET CLASS C",
        country: "United States",
        isin: "US02079K1079",
      },
    ]),
    [
      { sourceId: "NAME:ALPHABETINCCLASSA", targetId: "US02079K3059" },
      { sourceId: "NAME:APPLEINC", targetId: "US0378331005" },
    ],
  );
});

test("keeps tickerless canonical-name matches unresolved when durable targets conflict", () => {
  assert.deepEqual(
    planSecurityIdentityMerges([
      { securityId: "NAME:EXAMPLEINC", name: "EXAMPLE INC" },
      {
        securityId: "US0000000001",
        ticker: "EXA",
        name: "EXAMPLE",
        isin: "US0000000001",
      },
      {
        securityId: "GB0000000002",
        ticker: "EXB",
        name: "EXAMPLE PLC",
        isin: "GB0000000002",
      },
    ]),
    [],
  );
});
