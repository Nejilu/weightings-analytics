import assert from "node:assert/strict";
import test from "node:test";
import { readJsonLines } from "./json-lines";

test("decodes fragmented UTF-8, multiple events and a final unterminated line", async () => {
  const data = new TextEncoder().encode('{"name":"métriques"}\n\n{"done":true}');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of data) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const results = [];
  for await (const result of readJsonLines(body)) results.push(result);
  assert.deepEqual(results, [{ name: "métriques" }, { done: true }]);
});

test("rejects a truncated event and cancels unread input when the consumer stops", async () => {
  const broken = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"broken":')); controller.close();
  } });
  await assert.rejects(async () => {
    for await (const event of readJsonLines(broken)) assert.fail(`Unexpected event: ${JSON.stringify(event)}`);
  }, SyntaxError);
  let cancelled = false;
  const open = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"ready":true}\n'));
  }, cancel() { cancelled = true; } });
  for await (const event of readJsonLines(open)) { assert.deepEqual(event, { ready: true }); break; }
  assert.equal(cancelled, true);
});
