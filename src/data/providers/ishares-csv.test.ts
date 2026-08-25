import assert from "node:assert/strict";
import test from "node:test";

import { parseIsharesHoldingsCsv } from "./ishares-csv";

test("retains a holding rounded to 0% when market value is positive", () => {
  const parsed = parseIsharesHoldingsCsv(
    [
      'Fund Holdings as of,"29/Jul/2026"',
      "Ticker,Name,Sector,Asset Class,Weight (%),Market Value,Location,ISIN",
      'CORE,Core holding,Technology,Equity,99.99,"999,999",United States,US0000000001',
      'SMALL,Small holding,Technology,Equity,0.00,1,United States,US0000000002',
      'THIRD,Third holding,Technology,Equity,0.01,100,United States,US0000000003',
      'FOURTH,Fourth holding,Technology,Equity,0.01,100,United States,US0000000004',
      'FIFTH,Fifth holding,Technology,Equity,0.01,100,United States,US0000000005',
    ].join("\n"),
  );

  const small = parsed.holdings.find((holding) => holding.ticker === "SMALL");
  assert.equal(small?.weight, 0);
  assert.equal(small?.marketValue, 1);
  assert.equal(parsed.asOf, "2026-07-29");
});

test("parses US-style holdings dates without a timezone shift", () => {
  const parsed = parseIsharesHoldingsCsv(
    [
      'Fund Holdings as of,"Jul 30, 2026"',
      "Ticker,Name,Sector,Asset Class,Weight (%),Market Value,Location,ISIN",
      "ONE,One,Technology,Equity,50,500,United States,US0000000001",
      "TWO,Two,Technology,Equity,20,200,United States,US0000000002",
      "THREE,Three,Technology,Equity,15,150,United States,US0000000003",
      "FOUR,Four,Technology,Equity,10,100,United States,US0000000004",
      "FIVE,Five,Technology,Equity,5,50,United States,US0000000005",
    ].join("\n"),
  );

  assert.equal(parsed.asOf, "2026-07-30");
});

test("retains the listing exchange used by provider symbol resolution", () => {
  const parsed = parseIsharesHoldingsCsv(
    [
      'Fund Holdings as of,"Jul 30, 2026"',
      "Ticker,Name,Sector,Asset Class,Weight (%),Market Value,Location,Exchange,ISIN",
      "AAPL,Apple,Technology,Equity,50,500,United States,NASDAQ,US0378331005",
      "MSFT,Microsoft,Technology,Equity,20,200,United States,NASDAQ,US5949181045",
      "JPM,JPMorgan,Financials,Equity,15,150,United States,New York Stock Exchange,US46625H1005",
      "NOVN,Novartis,Health Care,Equity,10,100,Switzerland,SIX Swiss Exchange,CH0012005267",
      "NESN,Nestle,Consumer Staples,Equity,5,50,Switzerland,SIX Swiss Exchange,CH0038863350",
    ].join("\n"),
  );

  assert.equal(parsed.holdings[0].exchange, "NASDAQ");
  assert.equal(parsed.holdings[2].exchange, "New York Stock Exchange");
});

test("keeps no-ISIN share classes separate with a ticker fallback", () => {
  const parsed = parseIsharesHoldingsCsv(
    [
      'Fund Holdings as of,"Jul 30, 2026"',
      "Ticker,Name,Sector,Asset Class,Weight (%),Market Value,Location,Exchange,ISIN",
      "LISN,CHOCOLADEFABRIKEN LINDT & SPRUENGLI,Consumer Staples,Equity,30,300,Switzerland,SIX Swiss Exchange,",
      "LISP,CHOCOLADEFABRIKEN LINDT & SPRUENGLI,Consumer Staples,Equity,20,200,Switzerland,SIX Swiss Exchange,",
      "ONE,One,Technology,Equity,20,200,United States,NASDAQ,",
      "TWO,Two,Technology,Equity,15,150,United States,NASDAQ,",
      "THREE,Three,Technology,Equity,15,150,United States,NASDAQ,",
    ].join("\n"),
  );

  const classes = parsed.holdings.filter((holding) => holding.name.includes("LINDT"));
  assert.equal(classes.length, 2);
  assert.notEqual(classes[0]?.securityId, classes[1]?.securityId);
  assert.deepEqual(classes.map((holding) => holding.weight).sort((a, b) => b - a), [30, 20]);
});

test("parses the current BlackRock product-data holdings response", () => {
  const parsed = parseIsharesHoldingsCsv(
    JSON.stringify({
      componentsByNameMap: {
        holdings: {
          containersByNameMap: {
            all: {
              dataPointsByNameMap: {
                asOfDate: { value: 20260731 },
                ticker: { value: ["NVDA", "AAPL", "MSFT", "AMZN", "META"] },
                issueName: {
                  value: [
                    "NVIDIA CORP",
                    "APPLE INC",
                    "MICROSOFT CORP",
                    "AMAZON COM INC",
                    "META PLATFORMS INC CLASS A",
                  ],
                },
                sectorName: {
                  value: [
                    "Information Technology",
                    "Information Technology",
                    "Information Technology",
                    "Consumer Discretionary",
                    "Communication",
                  ],
                },
                assetClass: { value: ["Equity", "Equity", "Equity", "Equity", "Equity"] },
                countryOfRisk: {
                  value: ["United States", "United States", "United States", "United States", "United States"],
                },
                isin: {
                  value: [
                    "US67066G1040",
                    "US0378331005",
                    "US5949181045",
                    "US0231351067",
                    "US30303M1027",
                  ],
                },
                cusip: {
                  value: [
                    "67066G104",
                    "037833100",
                    "594918104",
                    "023135106",
                    "30303M102",
                  ],
                },
                sedol: {
                  value: ["2379504", "2046251", "2588173", "2000019", "B7TL820"],
                },
                currencyCode: { value: ["USD", "USD", "USD", "USD", "USD"] },
                exchange: { value: ["NASDAQ", "NASDAQ", "NASDAQ", "NASDAQ", "NASDAQ"] },
                holdingPercent: { value: [7.5, 7, 5.3, 3.8, 3.2] },
                marketValue: { value: [750, 700, 530, 380, 320] },
              },
            },
          },
        },
      },
    }),
  );

  assert.equal(parsed.asOf, "2026-07-31");
  assert.equal(parsed.holdings.length, 5);
  assert.equal(parsed.holdings[0]?.ticker, "NVDA");
  assert.equal(parsed.holdings[0]?.exchange, "NASDAQ");
  assert.equal(parsed.holdings[0]?.marketValue, 750);
  assert.equal(parsed.holdings[0]?.cusip, "67066G104");
  assert.equal(parsed.holdings[0]?.sedol, "2379504");
});

test("uses SEDOL as the canonical fallback when BlackRock omits ISIN", () => {
  const parsed = parseIsharesHoldingsCsv(JSON.stringify({
    componentsByNameMap: {
      holdings: {
        containersByNameMap: {
          all: {
            dataPointsByNameMap: {
              asOfDate: { value: 20260731 },
              ticker: { value: ["ONE", "TWO", "THREE", "FOUR", "FIVE"] },
              issueName: { value: ["One", "Two", "Three", "Four", "Five"] },
              holdingPercent: { value: [20, 20, 20, 20, 20] },
              isin: { value: ["", "US0000000002", "US0000000003", "US0000000004", "US0000000005"] },
              sedol: { value: ["B012345", "B000002", "B000003", "B000004", "B000005"] },
              cusip: { value: ["000000001", "000000002", "000000003", "000000004", "000000005"] },
            },
          },
        },
      },
    },
  }));

  assert.equal(parsed.holdings[0]?.securityId, "SEDOL:B012345");
  assert.equal(parsed.holdings[0]?.sedol, "B012345");
  assert.equal(parsed.holdings[0]?.cusip, "000000001");
});

test("parses a tickerless BlackRock mutual-fund holdings CSV", () => {
  const raw = [
    'Fund Holdings as of,"Jun 30, 2026"',
    "Name,Market Value,Weight (%),Shares",
    '"NVIDIA CORP","759,250,108.87","8.64","3,794,543.00"',
    '"SK HYNIX INC","624,788,001.03","7.11","365,277.00"',
    '"BROADCOM INC","503,067,051.50","5.72","1,331,746.00"',
    '"LAM RESEARCH CORP","457,406,248.13","5.20","1,055,561.00"',
    '"SAMSUNG ELECTRONICS LTD","455,832,714.13","5.19","2,114,436.00"',
  ].join("\n");

  const parsed = parseIsharesHoldingsCsv(raw);

  assert.equal(parsed.asOf, "2026-06-30");
  assert.equal(parsed.holdings.length, 5);
  assert.deepEqual(parsed.holdings[0], {
    securityId: "NAME:NVIDIACORP",
    ticker: "—",
    name: "NVIDIA CORP",
    sector: "Unclassified",
    assetClass: "Unclassified",
    country: "Not reported",
    isin: undefined,
    weight: 8.64,
    marketValue: 759_250_108.87,
    currency: undefined,
    exchange: undefined,
    cusip: undefined,
    sedol: undefined,
  });
});
