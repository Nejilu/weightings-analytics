import assert from "node:assert/strict";
import test from "node:test";
import { ADR_PAIRS, type AdrPremiumView } from "@/domain/adr-premium";
import { createAdrPremiumStore } from "./adr-premium-store";

test("all row badges share one request, retain the server capture expiry and flag a failed refresh", async () => {
  let now = Date.parse("2026-10-09T20:00:00Z");
  const view = (index: number): AdrPremiumView => ({
    pair: ADR_PAIRS[index], capturedAt: new Date(now - 14 * 60_000).toISOString(), sourceStatus: "cached", fallbackReason: null,
    observation: { mode: "aligned", premiumPct: 18, localPrice: 2_550, localCloseAt: "2026-10-08T05:30:00Z", adrPrice: 473,
      adrPriceAt: "2026-10-08T05:27:00Z", adrMaxAgeSeconds: 240, localCurrencyPerUsd: 31.9, fxAt: "2026-10-08T05:30:00Z", parityUsd: 400 },
  });
  let calls = 0;
  let fail = false;
  const store = createAdrPremiumStore(async () => {
    calls++;
    if (fail) throw new Error("Transport unavailable");
    return Response.json({ data: Object.fromEntries(ADR_PAIRS.map((pair, index) => [pair.id, view(index)])) });
  }, () => now);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  const first = store.load();
  assert.equal(store.load(), first);
  await first;
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().data.tsmc?.observation?.premiumPct, 18);
  await store.load();
  assert.equal(calls, 1);
  now += 61_000;
  fail = true;
  await store.load();
  assert.equal(calls, 2);
  assert.equal(store.getSnapshot().data.tsmc?.sourceStatus, "stale");
  assert.equal(store.getSnapshot().data.tsmc?.observation?.premiumPct, 18);
  assert.equal(store.getSnapshot().status, "unavailable");
  assert.ok(notifications >= 4);
  unsubscribe();
});

test("initial API failure produces unavailable badges and retries after one minute", async () => {
  let now = 100_000;
  let calls = 0;
  const store = createAdrPremiumStore(async () => { calls++; return new Response("Unavailable", { status: 503 }); }, () => now);
  await store.load();
  assert.equal(store.getSnapshot().status, "unavailable");
  assert.deepEqual(store.getSnapshot().data, {});
  await store.load();
  assert.equal(calls, 1);
  now += 60_001;
  await store.load();
  assert.equal(calls, 2);
});

test("an unavailable pair in a successful response retries after one minute", async () => {
  let now = Date.parse("2026-10-10T00:00:00Z");
  let calls = 0;
  const store = createAdrPremiumStore(async () => {
    calls++;
    const view = (index: number) => ({ pair: ADR_PAIRS[index], observation: null, sourceStatus: "unavailable",
      fallbackReason: "fx-unavailable", capturedAt: new Date(now).toISOString() });
    return Response.json({ data: Object.fromEntries(ADR_PAIRS.map((pair, index) => [pair.id, view(index)])) });
  }, () => now);
  await store.load();
  await store.load();
  assert.equal(calls, 1);
  now += 60_001;
  await store.load();
  assert.equal(calls, 2);
});

test("manual refresh bypasses both caches and updates the shared badge data", async () => {
  let now = Date.parse("2026-10-10T00:00:00Z");
  const urls: string[] = [];
  const store = createAdrPremiumStore(async (url) => {
    urls.push(String(url));
    const view = (index: number) => ({ pair: ADR_PAIRS[index], observation: null, sourceStatus: "cached",
      fallbackReason: "prices-unavailable", capturedAt: new Date(now).toISOString() });
    return Response.json({ data: Object.fromEntries(ADR_PAIRS.map((pair, index) => [pair.id, view(index)])) });
  }, () => now);
  // Refreshing unrelated panels does not create a premium request.
  await store.refreshIfLoaded();
  assert.equal(urls.length, 0);
  await store.load();
  const firstCapture = store.getSnapshot().data.tsmc?.capturedAt;
  now += 1_000;
  const first = store.refreshIfLoaded();
  assert.equal(store.refreshIfLoaded(), first);
  await first;
  assert.deepEqual(urls, ["/api/v1/metrics/adr-premiums", "/api/v1/metrics/adr-premiums?refresh=true"]);
  assert.notEqual(store.getSnapshot().data.tsmc?.capturedAt, firstCapture);
});

test("manual refresh waits for an ordinary request and then forces one shared refresh", async () => {
  const urls: string[] = [];
  let release!: (value: Response) => void;
  const store = createAdrPremiumStore(async (url) => {
    urls.push(String(url));
    return urls.length === 1 ? new Promise<Response>((resolve) => { release = resolve; }) : new Response("No data", { status: 503 });
  });
  const ordinary = store.load();
  const forced = store.load(true);
  const otherForced = store.load(true);
  release(new Response("No data", { status: 503 }));
  await Promise.all([ordinary, forced, otherForced]);
  assert.deepEqual(urls, ["/api/v1/metrics/adr-premiums", "/api/v1/metrics/adr-premiums?refresh=true"]);
});
