import assert from "node:assert/strict";
import test from "node:test";
import worker, { allowedUrl } from "./worker.mjs";

const upstream = "https://www.blackrock.com/varnish-api/test?portfolioId=339775";
const env = { ALLOWED_IP: "192.0.2.1", ALLOWED_URLS: [upstream] };
const request = (url = upstream, ip = env.ALLOWED_IP) => new Request(
  "https://relay.example/?url=" + encodeURIComponent(url),
  { headers: { "CF-Connecting-IP": ip } },
);

test("restricts targets and caller; permits only a validated holdings date", async () => {
  assert.equal(allowedUrl(upstream + "&asOfDate=20260918", env.ALLOWED_URLS), true);
  for (const url of [upstream + "&other=1", upstream + "&asOfDate=evil",
    upstream + "&asOfDate=20260918&asOfDate=20260911",
    "https://attacker.example/", "https://www.blackrock.com@attacker.example/"]) {
    assert.equal(allowedUrl(url, env.ALLOWED_URLS), false);
  }
  assert.equal((await worker.fetch(request(upstream, "192.0.2.2"), env)).status, 403);
  assert.equal((await worker.fetch(request("https://attacker.example/"), env)).status, 400);
});

test("preserves provider errors, streams success and refuses redirects", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("denied", { status: 403 });
    const denied = await worker.fetch(request(), env);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("x-holdings-error-code"), "HTTP_403");
    globalThis.fetch = async () => new Response("holdings", { headers: { "Content-Type": "text/csv" } });
    const ok = await worker.fetch(request(), env);
    assert.equal(await ok.text(), "holdings");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: "https://attacker.example/" } });
    assert.equal((await worker.fetch(request(), env)).headers.get("x-holdings-error-code"), "UPSTREAM_REDIRECT");
  } finally { globalThis.fetch = original; }
});
