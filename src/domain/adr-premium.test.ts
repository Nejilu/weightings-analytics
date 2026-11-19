import assert from "node:assert/strict";
import test from "node:test";
import { ADR_PAIRS, adrPairForListing, adrPairForSecurity, calculateAdrPremium, type PriceBar } from "./adr-premium";

const seconds = (iso: string) => Date.parse(iso) / 1_000;
const bar = (date: string, close: number, volume = 100): PriceBar => ({ timestamp: seconds(date), close, volume });
const daily = (date: string, close: number, duration = 23_400): PriceBar => ({ ...bar(date, close), sessionCloseTimestamp: seconds(date) + duration });
const now = Date.parse("2026-10-09T21:00:00Z");
const data = () => ({
  localDaily: [bar("2026-10-08T01:00:00Z", 2_550)],
  usDaily: [daily("2026-10-08T13:30:00Z", 457.99)],
  overnight: [bar("2026-10-08T05:26:00Z", 473.48)],
  fx: [bar("2026-10-08T05:25:00Z", 31.905, 0), bar("2026-10-08T19:55:00Z", 31.965, 0)],
});

test("row badges identify ADR instruments, explicit price overrides and merged ADR exposure", () => {
  const tsm = { securityId: "TW0002330008", ticker: "TSM", name: "Taiwan Semiconductor Manufacturing", kind: "security" };
  assert.equal(adrPairForListing(tsm)?.id, "tsmc");
  assert.equal(adrPairForListing({ ...tsm, ticker: "2330" }), null);
  assert.equal(adrPairForListing({ ...tsm, ticker: "TSM", priceSymbol: "2330.TW" }), null);
  assert.equal(adrPairForListing({ ...tsm, ticker: "2330", priceSymbol: "TSM" })?.id, "tsmc");
  assert.equal(adrPairForListing({ ...tsm, kind: "etf" }), null);
  assert.equal(adrPairForListing({ ...tsm, ticker: "UTSM" }), null);
  assert.equal(adrPairForListing({ ...tsm, ticker: "TSM / 2330", quoteTicker: "2330" }), null);
  assert.equal(adrPairForListing({ ...tsm, ticker: "TSM / 2330", quoteTicker: "2330", adrPremiumPairId: "tsmc" })?.id, "tsmc");
  assert.equal(adrPairForListing({ ...tsm, adrPremiumPairId: null }), null);
  const sk = { ticker: "SKHY", name: "SK Hynix ADR" };
  assert.equal(adrPairForListing(sk)?.id, "sk-hynix");
  assert.equal(adrPairForListing({ ...sk, adrPremiumPairId: "sk-hynix", priceSymbol: "HY9H.F" })?.id, "sk-hynix-gdr-us");
  assert.equal(adrPairForListing({ ...sk, ticker: "HY9H", priceSymbol: "HY9H.F" })?.id, "sk-hynix-gdr-us");
  assert.equal(adrPairForListing({ ...sk, ticker: "HY9H / 000660", quoteTicker: "HY9H" })?.id, "sk-hynix-gdr-us");
  assert.equal(adrPairForListing({ ...sk, ticker: "HY9H", adrPremiumPairId: null }), null);
  assert.equal(adrPairForListing({ ticker: "HY9H", name: "Unrelated issuer" }), null);
  assert.equal(adrPairForListing({ ...sk, ticker: "000660" }), null);
});

test("TSMC alignment uses completed traded bars and the actual last Asian session", () => {
  const input = data();
  input.overnight.push(bar("2026-10-08T05:29:00Z", 999, 0), bar("2026-10-08T05:30:00Z", 1_000));
  input.fx.push(bar("2026-10-08T05:30:00Z", 99, 0));
  const result = calculateAdrPremium(ADR_PAIRS[0], input, now);
  assert.equal(result.observation?.mode, "aligned");
  assert.equal(result.observation?.localCloseAt, "2026-10-08T05:30:00.000Z");
  assert.equal(result.observation?.adrPriceAt, "2026-10-08T05:27:00.000Z");
  assert.equal(result.observation?.adrMaxAgeSeconds, 240);
  assert.ok(Math.abs(result.observation!.premiumPct - 18.481407058823507) < 1e-8);
  assert.equal(result.fallbackReason, null);
});

test("SK hynix US ADR ratio is one tenth of a Korean share", () => {
  const result = calculateAdrPremium(ADR_PAIRS[1], {
    localDaily: [bar("2026-10-08T00:00:00Z", 1_681_000)], usDaily: [],
    overnight: [bar("2026-10-08T06:29:00Z", 177.24)],
    fx: [bar("2026-10-08T06:25:00Z", 1_338.18, 0)],
  }, now);
  assert.ok(Math.abs(result.observation!.premiumPct - (177.24 * 1_338.18 / 168_100 - 1) * 100) < 1e-8);
  assert.equal(result.observation?.adrMaxAgeSeconds, 60);
});

test("SKHY versus HY9H adjusts the 10:1 receipt ratio and EUR/USD at Frankfurt's actual close", () => {
  const pair = ADR_PAIRS.find((pair) => pair.id === "sk-hynix-gdr-us")!;
  const input = {
    localDaily: [daily("2026-11-18T07:00:00Z", 900, 43_200)], usDaily: [],
    overnight: [bar("2026-11-18T18:59:00Z", 120)],
    fx: [bar("2026-11-18T18:55:00Z", 0.9, 0)],
  };
  const result = calculateAdrPremium(pair, input, Date.parse("2026-11-18T19:00:00Z"));
  assert.equal(result.observation?.mode, "aligned");
  assert.equal(result.observation?.localCloseAt, "2026-11-18T19:00:00.000Z");
  assert.equal(result.observation?.parityUsd, 100);
  assert.ok(Math.abs(result.observation!.premiumPct - 20) < 1e-10);
  assert.equal(calculateAdrPremium(pair, input, Date.parse("2026-11-18T18:59:00Z")).observation, null);
  assert.equal(calculateAdrPremium(pair, { ...input, localDaily: [bar("2026-11-18T07:00:00Z", 900)] }, now).observation, null);
});

test("HY9H comparison marks unsynchronized closes and requires an FX quote at the US close", () => {
  const pair = ADR_PAIRS.find((pair) => pair.id === "sk-hynix-gdr-us")!;
  const input = {
    localDaily: [daily("2026-11-18T07:00:00Z", 900, 43_200)],
    usDaily: [daily("2026-11-18T14:30:00Z", 120)], overnight: [],
    fx: [bar("2026-11-18T20:55:00Z", 0.9, 0)],
  };
  const result = calculateAdrPremium(pair, input, Date.parse("2026-11-18T21:00:00Z"));
  assert.equal(result.observation?.mode, "closing-prices");
  assert.equal(result.fallbackReason, "intraday-unavailable");
  assert.equal(result.observation?.adrPriceAt, "2026-11-18T21:00:00.000Z");
  assert.equal(calculateAdrPremium(pair, { ...input, fx: [] }, Date.parse("2026-11-18T21:00:00Z")).observation, null);
});

test("stale overnight or FX observations trigger an explicitly asynchronous close comparison", () => {
  const input = data();
  input.overnight = [bar("2026-10-08T05:24:00Z", 473)];
  input.usDaily.push(daily("2026-10-09T13:30:00Z", 450));
  // At 19 UTC the October 9 US bar is still trading; use October 8 close.
  const result = calculateAdrPremium(ADR_PAIRS[0], input, Date.parse("2026-10-09T19:00:00Z"));
  assert.equal(result.observation?.mode, "closing-prices");
  assert.equal(result.observation?.adrPrice, 457.99);
  assert.equal(result.observation?.adrPriceAt, "2026-10-08T20:00:00.000Z");
  assert.equal(result.observation?.adrMaxAgeSeconds, null);
  assert.equal(result.fallbackReason, "overnight-unavailable");
  input.overnight = data().overnight;
  input.fx = [bar("2026-10-08T19:55:00Z", 31.965, 0)];
  assert.equal(calculateAdrPremium(ADR_PAIRS[0], input, now).fallbackReason, "fx-unavailable");
  input.fx = [];
  assert.equal(calculateAdrPremium(ADR_PAIRS[0], input, now).observation, null);
});

test("never uses an unfinished Asian daily bar", () => {
  const input = data();
  input.localDaily.push(bar("2026-10-09T01:00:00Z", 3_000));
  assert.equal(calculateAdrPremium(ADR_PAIRS[0], input, Date.parse("2026-10-09T05:00:00Z")).observation?.localPrice, 2_550);
});

test("advances the synchronized date when the next completed Asian session becomes available", () => {
  const input = data();
  input.localDaily.push(bar("2026-10-12T01:00:00Z", 2_600));
  input.overnight.push(bar("2026-10-12T05:29:00Z", 470));
  input.fx.push(bar("2026-10-12T05:25:00Z", 32, 0));
  const before = calculateAdrPremium(ADR_PAIRS[0], input, Date.parse("2026-10-12T05:29:00Z"));
  assert.equal(before.observation?.localCloseAt, "2026-10-08T05:30:00.000Z");
  const after = calculateAdrPremium(ADR_PAIRS[0], input, Date.parse("2026-10-12T05:30:00Z"));
  assert.equal(after.observation?.mode, "aligned");
  assert.equal(after.observation?.localCloseAt, "2026-10-12T05:30:00.000Z");
  assert.equal(after.observation?.adrPriceAt, "2026-10-12T05:30:00.000Z");
  assert.equal(after.observation?.localPrice, 2_600);
});

test("US fallback respects summer and winter regular-session times", () => {
  for (const [date, open, close] of [["2026-01-08", "14:30", "21:00"], ["2026-07-08", "13:30", "20:00"]]) {
    const closeTime = `${date}T${close}:00Z`;
    const result = calculateAdrPremium(ADR_PAIRS[0], {
      localDaily: [bar(`${date}T01:00:00Z`, 100)], usDaily: [daily(`${date}T${open}:00Z`, 20)], overnight: [],
      fx: [{ timestamp: seconds(closeTime) - 300, close: 30, volume: 0 }],
    }, Date.parse(closeTime));
    assert.equal(result.observation?.adrPriceAt, new Date(closeTime).toISOString());
  }
});

test("shortened US sessions use the actual early close and its FX quote", () => {
  const result = calculateAdrPremium(ADR_PAIRS[0], {
    localDaily: [bar("2026-11-27T01:00:00Z", 100)],
    usDaily: [daily("2026-11-27T14:30:00Z", 20, 12_600)], overnight: [],
    fx: [bar("2026-11-27T17:55:00Z", 30, 0), bar("2026-11-27T20:55:00Z", 99, 0)],
  }, Date.parse("2026-11-27T19:00:00Z"));
  assert.equal(result.observation?.adrPriceAt, "2026-11-27T18:00:00.000Z");
  assert.equal(result.observation?.localCurrencyPerUsd, 30);
});

test("matches issuer identities on local and ADR listings without matching unrelated tickers", () => {
  const security = (ticker: string, name: string, isin?: string) => ({ ticker, name, isin, securityId: "fixture" });
  assert.equal(adrPairForSecurity(security("TSM", "Taiwan Semiconductor ADR"))?.id, "tsmc");
  assert.equal(adrPairForSecurity(security("2330", "TSMC"))?.id, "tsmc");
  assert.equal(adrPairForSecurity(security("000660", "SK HYNIX INC"))?.id, "sk-hynix");
  assert.equal(adrPairForSecurity(security("SKHY", "SK hynix Sponsored ADR"))?.underlyingPerAdr, 0.1);
  assert.equal(adrPairForSecurity(security("HY9H", "SK HYNIX GDR"))?.adrSymbol, "NASDAQ:SKHY");
  assert.equal(adrPairForSecurity(security("OTHER", "Unrecognized", "TW0002330008"))?.id, "tsmc");
  assert.equal(adrPairForSecurity(security("2330", "Unrelated issuer")), null);
  assert.equal(adrPairForSecurity(security("ASX", "ASE Technology ADR")), null);
});
