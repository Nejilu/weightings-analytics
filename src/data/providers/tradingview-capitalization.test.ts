import assert from "node:assert/strict";
import test from "node:test";
import { fetchTradingViewCapitalizations } from "./tradingview-capitalization";

test("the cap query explicitly converts to USD and keeps company metadata without estimating EPS", async () => {
  const rows = await fetchTradingViewCapitalizations(["TWSE:2330", "NYSE:TSM", "TWSE:2330"], async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.price_conversion, { to_currency: "usd" });
    assert.equal(body.symbols.tickers.length, 2);
    assert.deepEqual(body.columns, ["name", "description", "logoid", "market_cap_basic"]);
    return Response.json({ data: [
      { s: "TWSE:2330", d: ["2330", "TSMC", "taiwan-semiconductor", 1e12] },
      { s: "NYSE:TSM", d: ["TSM", "TSMC ADR", "taiwan-semiconductor", 1e12] },
      { s: "UNREQUESTED", d: ["BAD", "Bad", "bad", 1e15] },
    ] });
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].marketCapUsd, rows[1].marketCapUsd);
  assert.equal(rows[0].companyLogo, "taiwan-semiconductor");
});

test("provider outages never produce placeholder caps", async () => {
  await assert.rejects(fetchTradingViewCapitalizations(["NASDAQ:AAPL"], async () => new Response("unavailable", { status: 503 })), /unavailable/);
  const rows = await fetchTradingViewCapitalizations(["NASDAQ:AAPL"], async () => Response.json({ data: [{ s: "NASDAQ:AAPL", d: ["AAPL", "Apple", "apple", null] }] }));
  assert.equal(rows[0].marketCapUsd, null);
});
