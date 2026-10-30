import assert from "node:assert/strict";
import test from "node:test";
import { createConcurrencyLimiter, mapWithConcurrency } from "./async-utils";

test("maps items in input order while respecting the concurrency bound", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 10;
  });

  assert.deepEqual(result, [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});

test("returns an empty result without invoking workers", async () => {
  let invoked = false;
  const result = await mapWithConcurrency([], 4, async () => {
    invoked = true;
    return "unexpected";
  });

  assert.deepEqual(result, []);
  assert.equal(invoked, false);
});

test("a shared provider budget bounds overlapping batches and releases rejected requests", async () => {
  const run = createConcurrencyLimiter(2);
  const started: number[] = [];
  const release: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const request = (id: number) => run(async () => {
    started.push(id);
    maxActive = Math.max(maxActive, ++active);
    try {
      await new Promise<void>((resolve) => release.push(resolve));
      if (id === 1) throw new Error("provider unavailable");
      return id;
    } finally { active--; }
  });
  const settled = Promise.allSettled([request(0), request(1), request(2), request(3)]);
  assert.deepEqual(started, [0, 1]);
  release.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  release.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3]);
  for (const resolve of release.splice(0)) resolve();
  const results = await settled;
  assert.equal(results[1].status, "rejected");
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 3);
  assert.equal(maxActive, 2);
  assert.equal(await run(async () => 4), 4, "failures cannot leak a provider slot");
});

test("a synchronous failure also releases the provider budget", async () => {
  const run = createConcurrencyLimiter(1);
  const failure = run(() => { throw new Error("synchronous failure"); });
  const next = run(async () => "recovered");
  await assert.rejects(failure, /synchronous failure/);
  assert.equal(await next, "recovered");
});
