import assert from "node:assert/strict";
import test from "node:test";

import {
  tradingViewSymbolCandidateDetails,
  tradingViewSymbolCandidates,
} from "./tradingview-symbols";

test("uses the exact iShares listing exchange when it is available", () => {
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "AAPL",
    name: "Apple Inc",
    country: "United States",
    exchange: "NASDAQ",
  }), ["NASDAQ:AAPL"]);
});

test("Samsung GDRs use the verified LSIN order book, including the former SMSEL ticker", () => {
  for (const [ticker, symbol] of [["SMSN", "LSIN:SMSN"], ["SMSN.IL", "LSIN:SMSN"],
    ["SMSD", "LSIN:SMSD"], ["SMSD.IL", "LSIN:SMSD"], ["SMSEL", "LSIN:SMSD"]]) {
    for (const exchange of [undefined, "London Stock Exchange", "Luxembourg Stock Exchange"]) {
      assert.deepEqual(tradingViewSymbolCandidateDetails({ ticker, name: "SAMSUNG ELECTRONICS GDR",
        country: "Korea (South)", exchange }), [{ symbol, provenance: "confirmed_alias" }]);
    }
  }
  assert.deepEqual(tradingViewSymbolCandidates({ ticker: "005935", name: "SAMSUNG ELECTRONICS PREFERRED",
    country: "Korea (South)", exchange: "Korea Exchange (Stock Market)" }), ["KRX:005935"]);
});

test("prioritizes Euronext over the generic NYSE substring", () => {
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "ABI",
    name: "ANHEUSER-BUSCH INBEV SA",
    country: "Belgium",
    exchange: "Nyse Euronext - Euronext Brussels",
  }), ["EURONEXT:ABI"]);
});

test("falls back to plausible country exchanges for legacy snapshots", () => {
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "AAPL",
    name: "Apple Inc",
    country: "United States",
  }), ["NASDAQ:AAPL", "NYSE:AAPL", "AMEX:AAPL"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "005930",
    name: "Samsung Electronics Ltd",
    country: "Korea (South)",
  }), ["KRX:005930"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "036930",
    name: "Jusung Engineering Ltd",
    country: "Korea (South)",
    exchange: "Korea Exchange (Kosdaq)",
  }), ["KRX:036930"]);
});

test("retains imported ticker disambiguation rules", () => {
  for (const ticker of ["BRK B", "BRK_B", "BRK.B", "BRKB"]) {
    assert.deepEqual(tradingViewSymbolCandidates({ ticker, name: "Berkshire Hathaway Inc Class B",
      country: "United States", exchange: "New York Stock Exchange" }), ["NYSE:BRK.B"]);
  }
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "BRKB",
    name: "Berkshire Hathaway Inc Class B",
    country: "United States",
    exchange: "New York Stock Exchange",
  }), ["NYSE:BRK.B"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "CEMEXCPO",
    name: "Cemex SAB de CV",
    country: "Mexico",
    exchange: "Bolsa Mexicana de Valores",
  }), ["BMV:CEMEXCPO", "BMV:CEMEX/CPO"]);
});

test("keeps an overseas issuer on its actual depositary listing", () => {
  assert.deepEqual(tradingViewSymbolCandidates({ ticker: "ARM", name: "ARM HOLDINGS AMERICAN DEPOSITARY S",
    country: "United Kingdom", exchange: "NASDAQ" }), ["NASDAQ:ARM"]);
});

test("maps confirmed primary aliases for Mexico, Chile and Singapore", () => {
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "WALMEX*",
    name: "WALMART DE MEXICO V",
    country: "Mexico",
    exchange: "Bolsa Mexicana de Valores",
  }), ["BMV:WALMEX*", "BMV:WALMEX"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "PE&OLES*",
    name: "INDUST PENOLES",
    country: "Mexico",
    exchange: "Bolsa Mexicana de Valores",
  }), ["BMV:PE&OLES*", "BMV:PE_OLES"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "GENTERA*",
    name: "GENTERA SAB DE CV",
    country: "Mexico",
    exchange: "Bolsa Mexicana de Valores",
  }), ["BMV:GENTERA*", "BMV:GENTERA"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "SQM.B",
    name: "SOCIEDAD QUIMICA Y MINERA DE CHILE",
    country: "Chile",
    exchange: "Santiago Stock Exchange",
  }), ["BCS:SQM.B", "BCS:SQM/B", "BCS:SQM_B"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "AGUAS.A",
    name: "AGUAS ANDINAS SA",
    country: "Chile",
    exchange: "Santiago Stock Exchange",
  }), ["BCS:AGUAS.A", "BCS:AGUAS/A", "BCS:AGUAS_A"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "500048",
    name: "BEML LTD",
    country: "India",
    exchange: "Bse Ltd",
  }), ["BSE:500048", "NSE:BEML"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "534091",
    name: "MULTI COMMODITY EXCHANGE OF INDIA",
    country: "India",
    exchange: "Bse Ltd",
  }), ["BSE:534091", "NSE:MCX"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "EMBASSY",
    name: "EMBASSY OFFICE PARKS REIT UNITS",
    country: "India",
    exchange: "National Stock Exchange Of India",
  }), ["NSE:EMBASSY", "NSE:EMBASSY.RR"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "MINDSPACE",
    name: "MINDSPACE BUSINESS PARKS REITS UNI",
    country: "India",
    exchange: "National Stock Exchange Of India",
  }), ["NSE:MINDSPACE", "NSE:MINDSPACE.RR", "BSE:MINDSPACE"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "YNS",
    name: "YINSON HOLDINGS",
    country: "Malaysia",
    exchange: "Bursa Malaysia",
  }), ["MYX:YNS", "MYX:YINSON"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "FRTKF",
    name: "FRONTKEN CORPORATION",
    country: "Malaysia",
    exchange: "Bursa Malaysia",
  }), ["MYX:FRTKF", "MYX:FRONTKN"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "CICT",
    name: "CAPITALAND INTEGRATED COMMERCIAL TRUST",
    country: "Singapore",
    exchange: "Singapore Exchange",
  }), ["SGX:CICT", "SGX:C38U"]);
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "CLAR",
    name: "CAPITALAND ASCENDAS REIT",
    country: "Singapore",
    exchange: "Singapore Exchange",
  }), ["SGX:CLAR", "SGX:A17U"]);
});

test("keeps a US depositary receipt on its US listing", () => {
  assert.deepEqual(tradingViewSymbolCandidates({
    ticker: "ASML",
    name: "ASML Holding ADR Representing NV",
    country: "Netherlands",
    exchange: "Euronext Amsterdam",
  }), ["NASDAQ:ASML"]);
});

test("tries the TradingView HKEX form without leading zeroes", () => {
  const input = {
    ticker: "0700",
    name: "TENCENT HOLDINGS LTD",
    country: "Hong Kong",
    exchange: "Hong Kong Exchanges And Clearing Ltd",
  };
  assert.deepEqual(tradingViewSymbolCandidates(input), ["HKEX:0700", "HKEX:700"]);
  assert.deepEqual(tradingViewSymbolCandidateDetails(input), [
    { symbol: "HKEX:0700", provenance: "exact_exchange" },
    { symbol: "HKEX:700", provenance: "confirmed_alias" },
  ]);
});

test("exposes auditable provenance for exact, fallback, alias and cross-exchange candidates", () => {
  assert.deepEqual(
    tradingViewSymbolCandidateDetails({
      ticker: "AAPL",
      name: "Apple Inc",
      country: "United States",
      exchange: "NASDAQ",
    }),
    [{ symbol: "NASDAQ:AAPL", provenance: "exact_exchange" }],
  );
  assert.deepEqual(
    tradingViewSymbolCandidateDetails({
      ticker: "CEMEXCPO",
      name: "Cemex SAB de CV",
      country: "Mexico",
      exchange: "Bolsa Mexicana de Valores",
    }),
    [
      { symbol: "BMV:CEMEXCPO", provenance: "exact_exchange" },
      { symbol: "BMV:CEMEX/CPO", provenance: "confirmed_alias" },
    ],
  );
  assert.deepEqual(
    tradingViewSymbolCandidateDetails({
      ticker: "500048",
      name: "BEML LTD",
      country: "India",
      exchange: "Bse Ltd",
    }),
    [
      { symbol: "BSE:500048", provenance: "exact_exchange" },
      { symbol: "NSE:BEML", provenance: "cross_exchange" },
    ],
  );
  assert.deepEqual(
    tradingViewSymbolCandidateDetails({
      ticker: "AAPL",
      name: "Apple Inc",
      country: "United States",
    }),
    [
      { symbol: "NASDAQ:AAPL", provenance: "country_fallback" },
      { symbol: "NYSE:AAPL", provenance: "country_fallback" },
      { symbol: "AMEX:AAPL", provenance: "country_fallback" },
    ],
  );
});
