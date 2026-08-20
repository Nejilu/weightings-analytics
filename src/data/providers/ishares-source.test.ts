import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPlausibleIsharesHoldingsCount,
  assertCsvPayload,
  fetchIsharesHoldingsFile,
  holdingsSourceCandidates,
  isPlausibleIsharesHoldingsCount,
} from "./ishares-source";

test("adds the current Swiss CSV endpoint for legacy UK downloads", () => {
  const legacyUrl =
    "https://www.ishares.com/uk/individual/en/products/999999/fund/1506575576011.ajax?fileType=csv&fileName=TEST_holdings&dataType=fund";

  assert.deepEqual(holdingsSourceCandidates(legacyUrl), [
    "https://www.blackrock.com/varnish-api/uk-retail01-product-data/product-data/api/v2/get-product-data?portfolioId=999999&component=holdings&appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=uk-ishares&locale=en_GB&userType=individual",
    legacyUrl,
    "https://www.ishares.com/ch/individual/en/products/999999/fund/1495092304805.ajax?fileType=csv&fileName=TEST_holdings&dataType=fund",
  ]);
});

test("does not alter current or non-iShares source URLs", () => {
  const currentUrl =
    "https://www.ishares.com/ch/individual/en/products/253743/fund/1495092304805.ajax?fileType=csv";
  const externalUrl = "https://example.com/holdings.csv";

  assert.deepEqual(holdingsSourceCandidates(currentUrl), [currentUrl]);
  assert.deepEqual(holdingsSourceCandidates(externalUrl), [externalUrl]);
});

test("adds the BlackRock product-data fallback for a US latest-holdings URL", () => {
  const primaryUrl =
    "https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv";

  assert.deepEqual(holdingsSourceCandidates(primaryUrl), [
    "https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v2/get-product-data?portfolioId=239726&component=holdings&appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=us-ishares&locale=en_US&userType=individual",
    primaryUrl,
  ]);
});

test("derives the UK BlackRock fallback from the product page when the CSV is Swiss", () => {
  const swissCsvUrl =
    "https://www.ishares.com/ch/individual/en/products/339541/ishares-s-p-500-top-20-ucits-etf/1495092304805.ajax?fileType=csv&fileName=SP20_holdings&dataType=fund";
  const ukProductUrl =
    "https://www.ishares.com/uk/individual/en/products/339541/ishares-s-p-500-top-20-ucits-etf";

  assert.deepEqual(holdingsSourceCandidates(swissCsvUrl, ukProductUrl), [
    "https://www.blackrock.com/varnish-api/uk-retail01-product-data/product-data/api/v2/get-product-data?portfolioId=339541&component=holdings&appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=uk-ishares&locale=en_GB&userType=individual",
    swissCsvUrl,
  ]);
});

test("prefers the identified dated BlackRock response over the identifier-poor CSV", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const primaryUrl =
    "https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv";
  const etf = {
    id: "ivv-us",
    ticker: "IVV",
    productUrl: "https://www.ishares.com/us/products/239726/IVV",
    holdingsUrl: primaryUrl,
  } as Parameters<typeof fetchIsharesHoldingsFile>[0];
  const metadata = JSON.stringify({
    componentsByNameMap: {
      holdings: {
        containersByNameMap: {
          all: {
            dataPointsByNameMap: {
              dateList: { value: [20260731, 20260804] },
            },
          },
        },
      },
    },
  });
  const dated = JSON.stringify({
    componentsByNameMap: {
      holdings: {
        containersByNameMap: {
          all: {
            dataPointsByNameMap: {
              ticker: { value: ["A", "B", "C", "D", "E"] },
              holdingPercent: { value: [20, 20, 20, 20, 20] },
            },
          },
        },
      },
    },
  });

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.cache, "no-store");
    assert.equal("next" in (init ?? {}), false);
    if (!url.includes("asOfDate=")) {
      return new Response(metadata, {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(dated, {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await fetchIsharesHoldingsFile(etf);
    assert.equal(result.sourceUrl.endsWith("asOfDate=20260804"), true);
    assert.equal(calls.length, 2);
    assert.equal(calls.includes(primaryUrl), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("falls back to the official CSV when BlackRock product data is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const primaryUrl =
    "https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv";
  const etf = {
    id: "ivv-us",
    ticker: "IVV",
    productUrl: "https://www.ishares.com/us/products/239726/IVV",
    holdingsUrl: primaryUrl,
  } as Parameters<typeof fetchIsharesHoldingsFile>[0];
  const csv = [
    'Fund Holdings as of,"Jul 31, 2026"',
    "Ticker,Name,Weight (%)",
    "A,Alpha,20",
    "B,Beta,20",
    "C,Gamma,20",
    "D,Delta,20",
    "E,Epsilon,20",
  ].join("\n");

  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    return url.includes("/varnish-api/")
      ? new Response("unavailable", { status: 503 })
      : new Response(csv, { headers: { "content-type": "text/plain" } });
  }) as typeof fetch;

  try {
    const result = await fetchIsharesHoldingsFile(etf);
    assert.equal(result.sourceUrl, primaryUrl);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tries the next official source when BlackRock data is implausibly short", async () => {
  const originalFetch = globalThis.fetch;
  const primaryUrl =
    "https://www.ishares.com/us/products/239600/ishares-msci-acwi-etf/latest-holdings.csv";
  const etf = {
    id: "acwi-us",
    ticker: "ACWI",
    productUrl: "https://www.ishares.com/us/products/239600/ACWI",
    holdingsUrl: primaryUrl,
  } as Parameters<typeof fetchIsharesHoldingsFile>[0];
  const metadata = JSON.stringify({
    componentsByNameMap: {
      holdings: {
        containersByNameMap: {
          all: { dataPointsByNameMap: { dateList: { value: [20260731] } } },
        },
      },
    },
  });
  const truncated = JSON.stringify({
    componentsByNameMap: {
      holdings: {
        containersByNameMap: {
          all: {
            dataPointsByNameMap: {
              ticker: { value: Array.from({ length: 1_652 }, (_, index) => `T${index}`) },
              holdingPercent: { value: Array.from({ length: 1_652 }, () => 0.05) },
            },
          },
        },
      },
    },
  });
  const csv = [
    'Fund Holdings as of,"Jul 31, 2026"',
    "Ticker,Name,Weight (%)",
    ...Array.from({ length: 2_000 }, (_, index) =>
      `T${index},Company ${index},0.05`),
  ].join("\n");

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === primaryUrl) {
      return new Response(csv, { headers: { "content-type": "text/plain" } });
    }
    if (url.includes("asOfDate=")) {
      return new Response(truncated, { headers: { "content-type": "application/json" } });
    }
    return new Response(metadata, { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await fetchIsharesHoldingsFile(etf);
    assert.equal(result.sourceUrl, primaryUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects HTML responses before they reach the CSV parser", () => {
  assert.throws(
    () => assertCsvPayload("text/html; charset=utf-8", "<!doctype html>"),
    /HTML page instead of a holdings CSV/,
  );
  assert.throws(
    () => assertCsvPayload("", "  <html><body>Not CSV</body></html>"),
    /HTML page instead of a holdings CSV/,
  );
  assert.doesNotThrow(() =>
    assertCsvPayload(
      "text/csv;charset=UTF-8",
      'Fund Holdings as of,"29/Jul/2026"\nTicker,Name,Weight (%)',
    ),
  );
  assert.doesNotThrow(() =>
    assertCsvPayload(
      "application/json",
      '{"componentsByNameMap":{"holdings":{}}}',
    ),
  );
});

test("rejects truncated large iShares universes without imposing their scale on small ETFs", () => {
  assert.equal(isPlausibleIsharesHoldingsCount("acwi-us", 1_652), false);
  assert.equal(isPlausibleIsharesHoldingsCount("acwi-us", 2_236), true);
  assert.equal(isPlausibleIsharesHoldingsCount("csemas-ucits", 499), false);
  assert.equal(isPlausibleIsharesHoldingsCount("csemas-ucits", 559), true);
  assert.equal(isPlausibleIsharesHoldingsCount("bgsix-us", 10), false);
  assert.equal(isPlausibleIsharesHoldingsCount("bgsix-us", 69), true);
  assert.equal(isPlausibleIsharesHoldingsCount("small-etf", 50), true);
  assert.throws(
    () =>
      assertPlausibleIsharesHoldingsCount(
        { id: "acwi-us", ticker: "ACWI" },
        1_652,
      ),
    /appears incomplete/,
  );
});

test("accepts the name-first BlackRock mutual-fund CSV format", async () => {
  const originalFetch = globalThis.fetch;
  const holdingsUrl =
    "https://www.blackrock.com/us/individual/products/227450/fund/holdings.ajax?fileType=csv";
  const etf = {
    id: "bgsix-us",
    ticker: "BGSIX",
    productUrl:
      "https://www.blackrock.com/us/individual/products/227450/technology-opportunities-fund",
    holdingsUrl,
  } as Parameters<typeof fetchIsharesHoldingsFile>[0];
  const csv = [
    'Fund Holdings as of,"Jun 30, 2026"',
    "Name,Market Value,Weight (%),Shares",
    ...Array.from({ length: 50 }, (_, index) =>
      `Company ${index},${1_000 - index},${(2 - index / 100).toFixed(2)},100`,
    ),
  ].join("\n");

  globalThis.fetch = (async () =>
    new Response(csv, { headers: { "content-type": "text/csv" } })) as typeof fetch;

  try {
    const result = await fetchIsharesHoldingsFile(etf);
    assert.equal(result.sourceUrl, holdingsUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
