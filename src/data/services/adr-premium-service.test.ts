import assert from "node:assert/strict";
import test from "node:test";
import type { TradingViewChart } from "../providers/tradingview-chart";
import { createAdrPremiumLoader } from "./adr-premium-service";

const stock = { securityId: "TW0002330008", ticker: "2330", name: "TSMC" };
const quote = (time: string, close: number, volume = 100) => ({ timestamp: Date.parse(time) / 1_000, close, volume });
const charts: Record<string, TradingViewChart> = {
  "TWSE:2330": { currency: "TWD", timezone: "Asia/Taipei", bars: [quote("2026-10-08T01:00:00Z", 2_550)] },
  "NYSE:TSM": { currency: "USD", timezone: "America/New_York", bars: [{ ...quote("2026-10-08T13:30:00Z", 457.99), sessionCloseTimestamp: Date.parse("2026-10-08T20:00:00Z") / 1_000 }] },
  "BOATS:TSM": { currency: "USD", timezone: "America/New_York", bars: [quote("2026-10-08T05:26:00Z", 473.48)] },
  "FX_IDC:USDTWD": { currency: "TWD", timezone: "Etc/UTC", bars: [quote("2026-10-08T05:25:00Z", 31.905, 0), quote("2026-10-08T19:55:00Z", 31.965, 0)] },
};

test("premium cache is shared across issuer listings, deduplicates requests and supports manual refresh", async () => {
  let calls = 0;
  let now = Date.parse("2026-10-09T21:00:00Z");
  let fail = false;
  const load = createAdrPremiumLoader(async (symbol) => {
    calls++;
    if (fail) throw new Error("Provider unavailable");
    return charts[symbol];
  }, () => now);
  const request = load(stock);
  assert.equal(load(stock, true), request);
  assert.equal((await request)?.sourceStatus, "live");
  assert.equal(calls, 4);
  assert.equal((await load({ ...stock, securityId: "US8740391003", ticker: "TSM" }))?.sourceStatus, "cached");
  assert.equal(calls, 4);
  assert.equal((await load(stock, true))?.sourceStatus, "live");
  assert.equal(calls, 8);
  now += 16 * 60_000;
  fail = true;
  const stale = await load(stock);
  assert.equal(stale?.sourceStatus, "stale");
  assert.equal(stale?.observation?.mode, "aligned");
  assert.equal(stale?.capturedAt, new Date(now - 16 * 60_000).toISOString());
  assert.equal(calls, 16);
  assert.equal(await load({ securityId: "other", ticker: "AAPL", name: "Apple" }), null);
  assert.equal(calls, 16);
});

test("overnight provider failure still returns a closing-price premium; total outage returns unavailable", async () => {
  const now = () => Date.parse("2026-10-09T21:00:00Z");
  const load = createAdrPremiumLoader(async (symbol) => {
    if (symbol.startsWith("BOATS:")) throw new Error("No overnight coverage");
    return charts[symbol];
  }, now);
  const result = await load(stock);
  assert.equal(result?.observation?.mode, "closing-prices");
  assert.equal(result?.fallbackReason, "overnight-unavailable");
  const outage = createAdrPremiumLoader(async () => { throw new Error("No data"); }, now);
  assert.equal((await outage(stock))?.sourceStatus, "unavailable");
});

test("rejects incorrect currencies and exchange timezones instead of displaying a spurious premium", async () => {
  for (const mismatch of [{ currency: "USD" }, { timezone: "America/New_York" }]) {
    const load = createAdrPremiumLoader(async (symbol) => symbol === "TWSE:2330"
      ? { ...charts[symbol], ...mismatch } : charts[symbol], () => Date.parse("2026-10-09T21:00:00Z"));
    assert.equal((await load(stock))?.observation, null);
  }
});

test("an intermittent overnight failure retains the aligned comparison for the same Asian session", async () => {
  let missingOvernight = false;
  const load = createAdrPremiumLoader(async (symbol) => {
    if (missingOvernight && symbol.startsWith("BOATS:")) throw new Error("Intermittent chart failure");
    return charts[symbol];
  }, () => Date.parse("2026-10-10T00:00:00Z"));
  const first = await load(stock);
  assert.equal(first?.observation?.mode, "aligned");
  missingOvernight = true;
  const refreshed = await load(stock, true);
  assert.equal(refreshed?.sourceStatus, "stale");
  assert.deepEqual(refreshed?.observation, first?.observation);
  assert.equal(refreshed?.capturedAt, first?.capturedAt);
  missingOvernight = false;
  assert.equal((await load(stock, true))?.sourceStatus, "live");
});

test("a transient chart connection retries only the failed symbol", async () => {
  const calls = new Map<string, number>();
  const load = createAdrPremiumLoader(async (symbol) => {
    calls.set(symbol, (calls.get(symbol) ?? 0) + 1);
    if (symbol === "BOATS:TSM" && calls.get(symbol) === 1) throw new Error("Transient connection failure");
    return charts[symbol];
  }, () => Date.parse("2026-10-10T00:00:00Z"));
  assert.equal((await load(stock))?.observation?.mode, "aligned");
  assert.equal(calls.get("BOATS:TSM"), 2);
  assert.equal(calls.get("TWSE:2330"), 1);
  assert.equal(calls.get("NYSE:TSM"), 1);
  assert.equal(calls.get("FX_IDC:USDTWD"), 1);
});

test("HY9H/US comparison requests Frankfurt, Nasdaq regular intraday and EUR/USD in its own cache", async () => {
  const calls: string[] = [];
  const close = Date.parse("2026-11-18T19:00:00Z") / 1_000;
  const load = createAdrPremiumLoader(async (symbol, interval) => {
    calls.push(`${symbol}:${interval}`);
    if (symbol === "FWB:HY9H") return { currency: "EUR", timezone: "Europe/Berlin",
      bars: [{ ...quote("2026-11-18T07:00:00Z", 900), sessionCloseTimestamp: close }] };
    if (symbol === "NASDAQ:SKHY") return { currency: "USD", timezone: "America/New_York",
      bars: [{ timestamp: close - 60, close: 120, volume: 100 }] };
    if (symbol === "FX_IDC:USDEUR") return { currency: "EUR", timezone: "Etc/UTC",
      bars: [{ timestamp: close - 300, close: 0.9, volume: 0 }] };
    throw new Error("Unexpected symbol");
  }, () => close * 1_000);
  const request = load("sk-hynix-gdr-us");
  assert.equal(load("sk-hynix-gdr-us"), request);
  const result = await request;
  assert.equal(result?.pair.id, "sk-hynix-gdr-us");
  assert.equal(result?.sourceStatus, "live");
  assert.ok(Math.abs(result!.observation!.premiumPct - 20) < 1e-10);
  assert.deepEqual(calls.sort(), ["FWB:HY9H:1D", "NASDAQ:SKHY:1D", "NASDAQ:SKHY:1", "FX_IDC:USDEUR:5"].sort());
  assert.equal((await load("sk-hynix-gdr-us"))?.sourceStatus, "cached");
  assert.equal(calls.length, 4);
});
