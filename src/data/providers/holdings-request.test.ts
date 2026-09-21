import assert from "node:assert/strict";
import test from "node:test";
import { requestHoldingsSource, sourceFailure } from "./holdings-request";

test("optional relay leaves other providers direct and reports actionable safe codes", async () => {
  const original = globalThis.fetch;
  const priorRelay = process.env.ISHARES_RELAY_URL;
  try {
    process.env.ISHARES_RELAY_URL = "https://relay.example/";
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response("secret diagnostic text", { status: 429 });
    };
    await assert.rejects(requestHoldingsSource("https://www.ishares.com/test"), (error) => {
      assert.deepEqual(sourceFailure(error), { code: "HTTP_429", message: "Holdings relay/provider returned HTTP 429." });
      return true;
    });
    await assert.rejects(requestHoldingsSource("https://example.com/holdings"));
    assert.equal(calls[1], "https://example.com/holdings");
    delete process.env.ISHARES_RELAY_URL;
    await assert.rejects(requestHoldingsSource("https://www.ishares.com/test"));
    assert.equal(calls[2], "https://www.ishares.com/test");
    assert.equal(sourceFailure(new DOMException("secret", "TimeoutError")).code, "TIMEOUT");
    assert.equal(sourceFailure(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })).code, "ENOTFOUND");
    assert.equal(sourceFailure(new Error("private provider body")).code, "INVALID_PROVIDER_DATA");
    process.env.ISHARES_RELAY_URL = "https://relay.example/";
    globalThis.fetch = async () => new Response("no", { status: 403, headers: { "x-holdings-error-code": "RELAY_FORBIDDEN" } });
    await assert.rejects(requestHoldingsSource("https://www.blackrock.com/test"), (error) => sourceFailure(error).code === "RELAY_FORBIDDEN");
  } finally {
    globalThis.fetch = original;
    if (priorRelay === undefined) delete process.env.ISHARES_RELAY_URL;
    else process.env.ISHARES_RELAY_URL = priorRelay;
  }
});
