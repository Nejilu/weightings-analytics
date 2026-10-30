import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import {
  getSiteAccess,
  requireOwner,
  siteConfiguration,
  verifyOwnerToken,
} from "./site-access";
import { publicationCatalog, publicAnalysis, siteCatalog } from "./public-data";
import {
  catalogRevision,
  invalidateSiteResults,
  siteRuntime,
  takeBudget,
} from "./site-runtime";
import { withSiteAccess } from "./site-route";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase, getDb, getSqlite } from "@/db/client";
import {
  etfs,
  portfolios,
  portfolioCashPositions,
  securities,
  marketPrices,
  portfolioValueSnapshots,
  portfolioHourlySnapshots,
} from "@/db/schema";
import { findEtfById } from "@/db/repositories/catalog-repository";
import { GET as catalogGET } from "@/app/api/v1/catalog/route";
import {
  GET as portfolioGET,
  PUT as portfolioPUT,
} from "@/app/api/v1/portfolio/route";
import {
  GET as localGET,
  PATCH as localPATCH,
  DELETE as localDELETE,
} from "@/app/api/v1/local-etfs/[etfId]/route";
import { POST as creatorPOST } from "@/app/api/v1/etf-creator/route";
import { POST as savePOST } from "@/app/api/v1/portfolio/save-as-etf/route";
import { PATCH as visibilityPATCH } from "@/app/api/v1/local-etfs/[etfId]/visibility/route";
import { GET as publishedGET } from "@/app/api/v1/published-portfolios/[etfId]/route";
import { GET as holdingsGET } from "@/app/api/v1/holdings/[ticker]/route";
import { GET as analysisGET } from "@/app/api/v1/holdings/[ticker]/analysis/route";
import { GET as compareGET } from "@/app/api/v1/compare/route";
import { GET as metricsGET } from "@/app/api/v1/metrics/overview/route";
import { GET as quoteGET } from "@/app/api/v1/prices/quote/route";
import { GET as fxGET } from "@/app/api/v1/prices/fx/route";
import { GET as publicDetailGET } from "@/app/api/v1/portfolio/published/[etfId]/route";
import { GET as publicHistoryGET } from "@/app/api/v1/portfolio/published/[etfId]/history/route";
import { persistFxRate } from "@/db/repositories/market-price-repository";
import { GET as dashboardGET } from "@/app/api/v1/portfolio/overview/route";
import { GET as aiConfigGET } from "@/app/api/v1/ai/config/route";
import { GET as aiRunsGET, POST as aiRunsPOST } from "@/app/api/v1/ai/runs/route";
import { GET as aiRunGET, DELETE as aiInterrupt } from "@/app/api/v1/ai/runs/[id]/route";
import { GET as aiEventsGET } from "@/app/api/v1/ai/runs/[id]/events/route";

const originalEnv = { ...process.env };
const directory = mkdtempSync(join(tmpdir(), "weightings-site-"));
const ctx = (etfId: string) => ({ params: Promise.resolve({ etfId }) });
function request(
  path: string,
  method = "GET",
  body?: unknown,
  host = "public.example.com",
) {
  return new Request(`https://${host}${path}`, {
    method,
    headers: {
      host,
      origin: host.startsWith("localhost")
        ? `http://${host}`
        : `https://${host}`,
      "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

before(() => {
  Object.assign(process.env, {
    DATABASE_PATH: join(directory, "test.sqlite"),
    SITE_ACCESS_MODE: "cloudflare",
    SITE_PUBLIC_ORIGIN: "https://public.example.com",
    SITE_OWNER_ORIGIN: "https://owner.example.com",
    CF_ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
    CF_ACCESS_AUD: "test-audience",
    SITE_OWNER_EMAIL: "owner@example.com",
  });
  ensureLocalDatabase();
  const base = findEtfById("ivv-us")!;
  for (const visibility of ["private", "weights", "public"] as const) {
    getDb()
      .insert(portfolios)
      .values({
        id: `portfolio-${visibility}`,
        name: `Portfolio ${visibility}`,
      })
      .run();
    getDb()
      .insert(portfolioCashPositions)
      .values({
        portfolioId: `portfolio-${visibility}`,
        currency: "USD",
        amount: 91827.36,
      })
      .run();
    getDb()
      .insert(etfs)
      .values({
        ...base,
        id: `test-${visibility}`,
        ticker: `TEST${visibility.toUpperCase()}`,
        isin: `TEST-${visibility}`,
        name: `Test ${visibility}`,
        issuer: "Test",
        fundType: "portfolio",
        portfolioId: `portfolio-${visibility}`,
        visibility,
        description: "Secret: 91827.36 USD cash",
        productUrl: `/portfolio/portfolio-${visibility}`,
        holdingsUrl: `local://portfolio/portfolio-${visibility}`,
      })
      .run();
  }
  for (const [id, source] of [
    ["child", "test-private"],
    ["grandchild", "child"],
    ["cycle-a", "cycle-b"],
    ["cycle-b", "cycle-a"],
  ]) {
    getDb()
      .insert(etfs)
      .values({
        ...base,
        id,
        ticker: id.toUpperCase(),
        isin: `TEST-${id}`,
        issuer: "Test",
        fundType: "custom",
        visibility: "public",
        metadataJson: { sourceEtfId: source },
      })
      .run();
  }
});
after(() => {
  closeDatabase();
  for (const key of Object.keys(process.env))
    if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(directory, { recursive: true, force: true });
});

test("Access validates signed owner identity, issuer, audience and expiry", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: "test" }],
  });
  const config = siteConfiguration();
  const token = async (overrides: Record<string, unknown> = {}) =>
    new SignJWT({ email: config.email, ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("owner")
      .setIssuedAt()
      .setIssuer(
        typeof overrides.iss === "string" ? overrides.iss : config.issuer,
      )
      .setAudience(
        typeof overrides.aud === "string" ? overrides.aud : config.audience,
      )
      .setExpirationTime(
        typeof overrides.exp === "number" ? overrides.exp : "1h",
      )
      .sign(privateKey);
  await verifyOwnerToken(await token(), config, keys);
  for (const invalid of [
    { email: "visitor@example.com" },
    { iss: "https://other.cloudflareaccess.com" },
    { aud: "wrong" },
    { exp: 1 },
  ]) {
    await assert.rejects(verifyOwnerToken(await token(invalid), config, keys));
  }
  const signed = await token();
  const [head, payload, signature] = signed.split(".");
  const tampered = `${head}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), email: "attacker@example.com" })).toString("base64url")}.${signature}`;
  await assert.rejects(verifyOwnerToken(tampered, config, keys));
  const publicHeaders = new Headers({
    host: "public.example.com",
    "cf-access-jwt-assertion": signed,
    "cf-access-authenticated-user-email": config.email,
  });
  assert.equal((await getSiteAccess(publicHeaders)).owner, false);
  await assert.rejects(
    getSiteAccess(
      new Headers({
        host: "owner.example.com",
        "cf-access-authenticated-user-email": config.email,
      }),
    ),
  );
  await assert.rejects(
    getSiteAccess(
      new Headers({
        host: "unknown.example.com",
        "x-forwarded-host": "owner.example.com",
      }),
    ),
  );
});

test("missing web configuration fails closed and compiled local mode stays on loopback", async () => {
  const saved = process.env.CF_ACCESS_AUD;
  delete process.env.CF_ACCESS_AUD;
  await assert.rejects(
    getSiteAccess(new Headers({ host: "public.example.com" })),
  );
  process.env.CF_ACCESS_AUD = saved;
  const nodeEnv = process.env.NODE_ENV;
  process.env.SITE_ACCESS_MODE = "local";
  Object.assign(process.env, { NODE_ENV: "production" });
  const access = await getSiteAccess(new Headers({ host: "localhost:3210" }));
  assert.equal(access.mode, "local");
  assert.equal(access.owner, true);
  await assert.rejects(getSiteAccess(new Headers({ host: "public.example.com" })));
  await assert.rejects(getSiteAccess(new Headers({ host: "owner.example.com", "x-forwarded-host": "localhost:3210" })));
  if (nodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
  else Object.assign(process.env, { NODE_ENV: nodeEnv });
  process.env.SITE_ACCESS_MODE = "cloudflare";
  assert.throws(() =>
    requireOwner(
      {
        mode: "web",
        owner: true,
        ownerOrigin: "https://owner.example.com",
        publicOrigin: "https://public.example.com",
      },
      request("/api/v1/portfolio", "PUT", {}, "public.example.com"),
    ),
  );
});

test("fresh installations default to local; partial web settings never downgrade access", async () => {
  const keys = ["SITE_ACCESS_MODE", "SITE_PUBLIC_ORIGIN", "SITE_OWNER_ORIGIN", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "SITE_OWNER_EMAIL", "SITE_LOCAL_PUBLIC_PREVIEW"];
  const saved = keys.map((key) => process.env[key]);
  try {
    keys.forEach((key) => { delete process.env[key]; });
    for (const host of ["localhost:3210", "127.0.0.1:3210", "[::1]:3210"]) {
      const access = await getSiteAccess(new Headers({ host }));
      assert.equal(access.mode, "local");
      assert.equal(access.owner, true);
      assert.equal(access.ownerOrigin, `http://${host}`);
    }
    await assert.rejects(getSiteAccess(new Headers({ host: "public.example.com" })));
    process.env.SITE_PUBLIC_ORIGIN = "https://public.example.com";
    await assert.rejects(getSiteAccess(new Headers({ host: "localhost:3210" })));
    delete process.env.SITE_PUBLIC_ORIGIN;
    process.env.SITE_ACCESS_MODE = "typo";
    await assert.rejects(getSiteAccess(new Headers({ host: "localhost:3210" })));
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});

test("local preview separates owner and public views on the same port", async () => {
  const previousPreview = process.env.SITE_LOCAL_PUBLIC_PREVIEW;
  const previousMode = process.env.SITE_ACCESS_MODE;
  process.env.SITE_ACCESS_MODE = "local";
  process.env.SITE_LOCAL_PUBLIC_PREVIEW = "true";
  try {
    const owner = await getSiteAccess(new Headers({ host: "localhost:3210" }));
    const visitor = await getSiteAccess(new Headers({ host: "127.0.0.1:3210" }));
    assert.equal(owner.owner, true);
    assert.equal(owner.mode, "web");
    assert.equal(visitor.owner, false);
    assert.equal(owner.publicOrigin, "http://127.0.0.1:3210");
    assert.equal(visitor.ownerOrigin, "http://localhost:3210");
    assert.equal((await portfolioGET(request("/api/v1/portfolio", "GET", undefined, "127.0.0.1:3210"))).status, 403);
    const response = await catalogGET(request("/api/v1/catalog", "GET", undefined, "127.0.0.1:3210"));
    assert.equal(response.status, 200);
    assert(!JSON.stringify(await response.json()).includes("test-private"));
  } finally {
    process.env.SITE_ACCESS_MODE = previousMode;
    if (previousPreview === undefined) delete process.env.SITE_LOCAL_PUBLIC_PREVIEW;
    else process.env.SITE_LOCAL_PUBLIC_PREVIEW = previousPreview;
  }
});

test("compiled local mode cannot enable the public development preview", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SITE_ACCESS_MODE: "local", SITE_LOCAL_PUBLIC_PREVIEW: "true", NODE_ENV: "production" });
    await assert.rejects(getSiteAccess(new Headers({ host: "localhost:3210" })));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("all owner APIs reject anonymous requests before reading or mutating data", async () => {
  const calls = [
    () => portfolioGET(request("/api/v1/portfolio")),
    () => portfolioPUT(request("/api/v1/portfolio", "PUT", {})),
    () => creatorPOST(request("/api/v1/etf-creator", "POST", {})),
    () => savePOST(request("/api/v1/portfolio/save-as-etf", "POST", {})),
    () =>
      localGET(request("/api/v1/local-etfs/test-public"), ctx("test-public")),
    () =>
      localPATCH(
        request("/api/v1/local-etfs/test-public", "PATCH", {}),
        ctx("test-public"),
      ),
    () =>
      localDELETE(
        request("/api/v1/local-etfs/test-public", "DELETE"),
        ctx("test-public"),
      ),
    () =>
      visibilityPATCH(
        request("/api/v1/local-etfs/test-public/visibility", "PATCH", {
          visibility: "private",
        }),
        ctx("test-public"),
      ),
  ];
  const count = getSqlite().prepare("SELECT count(*) AS n FROM etfs").get();
  for (const call of calls) assert.equal((await call()).status, 403);
  assert.deepEqual(
    getSqlite().prepare("SELECT count(*) AS n FROM etfs").get(),
    count,
  );
  assert.equal(findEtfById("test-public")?.visibility, "public");
});

test("public catalogue hides private ETFs, aliases, descendants and cycles", async () => {
  const response = await catalogGET(request("/api/v1/catalog"));
  assert.equal(response.status, 200);
  const json = await response.json();
  const ids = json.data.flatMap((g: { variants: Array<{ id: string }> }) =>
    g.variants.map((e) => e.id),
  );
  assert(ids.includes("ivv-us"));
  assert(ids.includes("test-weights"));
  assert(ids.includes("test-public"));
  for (const id of [
    "test-private",
    "child",
    "grandchild",
    "cycle-a",
    "cycle-b",
  ])
    assert(!ids.includes(id), id);
  const serialized = JSON.stringify(json);
  assert(!serialized.includes("91827.36"));
  assert(!serialized.includes("local://"));
  assert(!serialized.includes('"portfolioId"'));
  assert(response.headers.get("cache-control")?.includes("no-store"));
  assert(
    siteCatalog(true)
      .flatMap((g) => g.variants)
      .some((e) => e.id === "test-private"),
  );
});

test("direct IDs and tickers cannot access hidden holdings, analyses, comparisons, metrics or quotes", async () => {
  for (const reference of ["test-private", "TESTPRIVATE", "grandchild"]) {
    const context = { params: Promise.resolve({ ticker: reference }) };
    for (const response of [
      await holdingsGET(request(`/api/v1/holdings/${reference}`), context),
      await analysisGET(
        request(`/api/v1/holdings/${reference}/analysis`),
        context,
      ),
      await compareGET(
        request(`/api/v1/compare?left=ivv-us&right=${reference}`),
      ),
      await metricsGET(
        request(`/api/v1/metrics/overview?etfs=ivv-us,${reference}`),
      ),
      await quoteGET(
        request(`/api/v1/prices/quote?kind=etf&referenceId=${reference}`),
      ),
    ])
      assert.equal(response.status, 404);
  }
});

test("projects every metrics stream event and sanitizes provider errors for visitors", async () => {
  const encoder = new TextEncoder();
  const handler = withSiteAccess(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const frame of [{ phase: "fundamentals", data: { quantity: 99, marketValue: 12345, coverageWeight: 95 } },
      { error: "private database path and provider internals" }]) {
      controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
    }
    controller.close();
  } }), { headers: { "Content-Type": "application/x-ndjson" } }), "metrics");
  const response = await handler(request("/api/v1/metrics/overview?stream=true&etfs=ivv-us"));
  assert.equal(response.status, 200);
  const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(frames, [
    { phase: "fundamentals", data: { coverageWeight: 95 } },
    { error: "Data temporarily unavailable. Please retry." },
  ]);
  const hidden = await handler(request("/api/v1/metrics/overview?stream=true&etfs=test-private"));
  assert.equal(hidden.status, 404);
});

test("stops metrics streams when publication changes before the next event", async () => {
  const encoder = new TextEncoder();
  let send!: ReadableStreamDefaultController<Uint8Array>;
  const handler = withSiteAccess(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { send = controller; } }),
    { headers: { "Content-Type": "application/x-ndjson" } }), "metrics");
  const response = await handler(request("/api/v1/metrics/overview?stream=true&etfs=ivv-us"));
  const reader = response.body!.getReader();
  send.enqueue(encoder.encode('{"phase":"fundamentals","data":{"coverageWeight":95}}\n'));
  assert.match(new TextDecoder().decode((await reader.read()).value), /fundamentals/);
  invalidateSiteResults();
  send.enqueue(encoder.encode('{"phase":"complete","data":{"mustNotAppear":true}}\n'));
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await reader.read()).value)),
    { error: "Data temporarily unavailable. Please retry." });
  assert.equal((await reader.read()).done, true);
});

test("weights projections remove exact amounts and stale embedded metadata without changing canonical data", async () => {
  const etf = findEtfById("test-weights")!;
  const source = {
    data: {
      etf,
      holdings: [
        { securityId: "CASH:USD", weight: 100, marketValue: 91827.36 },
      ],
      left: { etf },
      etfs: [{ etf }],
      totalMarketValueUsd: 91827.36,
      portfolioValuation: { totalMarketValueUsd: 91827.36, items: [], cash: [{ currency: "USD", amount: 91827.36, valueUsd: 91827.36, weight: 100 }] },
      quantity: 127.125,
      sourceUrl: "local://portfolio/secret",
    },
  };
  const result = publicAnalysis(source, publicationCatalog());
  const serialized = JSON.stringify(result);
  for (const secret of [
    "91827.36",
    "127.125",
    "local://",
    '"portfolioId"',
    '"marketValue"',
    '"portfolioValuation"',
  ])
    assert(!serialized.includes(secret), secret);
  assert(serialized.includes('"weight":100'));
  assert.equal(source.data.holdings[0].marketValue, 91827.36);
  assert(etf.description?.includes("91827.36"));
  const handler = withSiteAccess(
    () =>
      Response.json(source, {
        headers: {
          ETag: "owner-version",
          "Cache-Control": "public, max-age=86400",
        },
      }),
    "holdings",
  );
  const response = await handler(request("/api/v1/holdings/test-weights"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), null);
  assert(response.headers.get("cache-control")?.includes("no-store"));
});

test("Analysis publishes valuation only for fully public portfolios using current visibility and an allowlist", async () => {
  const etf = findEtfById("test-public")!;
  const valuation = {
    totalMarketValueUsd: 10000,
    portfolioId: "secret-portfolio",
    items: [{ ticker: "A", name: "A", kind: "security", quantity: 30, currentValueUsd: 6000, allocationWeight: 60, initialValueUsd: 5000, id: "secret-item" }],
    cash: [{ currency: "EUR", amount: 3500, valueUsd: 4000, weight: 40, fxAsOf: "secret-date" }],
  };
  const source = { data: { etf, portfolioValuation: valuation, positions: [{ publishedWeight: 60 }] } };
  const handler = withSiteAccess(() => Response.json(source), "holdings");
  try {
    const response = await handler(request("/api/v1/holdings/test-public/analysis"));
    assert.equal(response.status, 200);
    const published = (await response.json()).data;
    assert.equal(published.portfolioValuation.totalMarketValueUsd, 10000);
    assert.equal(published.portfolioValuation.items[0].quantity, 30);
    assert.equal(published.portfolioValuation.cash[0].amount, 3500);
    assert(!JSON.stringify(published).includes("secret-"));
    assert(!JSON.stringify(published).includes("initialValueUsd"));
    assert(response.headers.get("cache-control")?.includes("no-store"));
    getDb().update(etfs).set({ visibility: "weights" }).where(eq(etfs.id, etf.id)).run();
    const weights = await handler(request("/api/v1/holdings/test-public/analysis"));
    assert.equal(weights.status, 200);
    const weightsData = (await weights.json()).data;
    assert.equal(weightsData.portfolioValuation, undefined);
    assert.equal(weightsData.positions[0].publishedWeight, 60);
    assert(!JSON.stringify(weightsData).includes("10000"));
    getDb().update(etfs).set({ visibility: "private" }).where(eq(etfs.id, etf.id)).run();
    assert.equal((await handler(request("/api/v1/holdings/test-public/analysis"))).status, 404);
  } finally {
    getDb().update(etfs).set({ visibility: "public" }).where(eq(etfs.id, etf.id)).run();
  }
});

test("visitors can read the exchange rates used to convert public portfolio amounts", async () => {
  const now = new Date().toISOString();
  persistFxRate({ currency: "EUR", providerSymbol: "EURUSD=X", rateToUsd: 1.25, asOf: now, fetchedAt: now, sourceStatus: "cached" });
  const response = await fxGET(request("/api/v1/prices/fx?currency=EUR"));
  assert.equal(response.status, 200);
  const rate = (await response.json()).data;
  assert.equal(rate.rateToUsd, 1.25);
  assert.equal(1000 / rate.rateToUsd, 800);
  assert.equal((await fxGET(request("/api/v1/prices/fx?currency=USD"))).status, 200);
  assert.equal((await fxGET(request("/api/v1/prices/fx?currency=invalid"))).status, 400);
});

test("exact published portfolio amounts are readable only in public mode", async () => {
  for (const mode of ["private", "weights"]) {
    assert.equal(
      (
        await publishedGET(
          request(`/api/v1/published-portfolios/test-${mode}`),
          ctx(`test-${mode}`),
        )
      ).status,
      404,
    );
  }
  const response = await publishedGET(
    request("/api/v1/published-portfolios/test-public"),
    ctx("test-public"),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.cash[0].amount, 91827.36);
  assert(!JSON.stringify(payload).includes("portfolioId"));
});

test("portfolio dashboard publishes relative histories, hides private portfolios and limits absolute values to public portfolios", async () => {
  const originalFetch = globalThis.fetch;
  const originalMetadata = getDb().select({ metadata: etfs.metadataJson }).from(etfs).where(eq(etfs.id, "test-public")).get()!.metadata;
  try {
    globalThis.fetch = async () => { throw new Error("Dashboard must only read saved snapshots"); };
    for (const visibility of ["private", "weights", "public"] as const) {
      const base = visibility === "private" ? 123456.77 : visibility === "weights" ? 987654.32 : 100000;
      getDb().insert(portfolioValueSnapshots).values([0, 1].map((index) => ({
        portfolioId: `portfolio-${visibility}`, date: `2026-10-0${index + 1}`, capturedAt: `2026-10-0${index + 1}T20:10:00Z`,
        valueUsd: base * (1 + index * 0.1), valueEur: base / 1.2 * (1 + index * 0.05), eurToUsd: 1.2,
        quotesAsOf: "2026-10-01", fxAsOf: "2026-10-01", reason: "scheduled" as const,
        invested: { indexUsd: 100 + index * 8, indexEur: 100 + index * 4, segment: "2026-10-01", grossExposureUsd: 765432.1,
          positions: [{ kind: "security" as const, referenceId: "secret-security", ticker: "SECRET", quantity: 54321, priceUsd: 14, exposureMultiplier: 1 }] },
      }))).run();
      const recent = new Date(Date.now() - 3_600_000).toISOString();
      getDb().insert(portfolioHourlySnapshots).values({
        portfolioId: `portfolio-${visibility}`, date: recent.slice(0, 10), slotAt: recent, capturedAt: recent,
        valueUsd: base, valueEur: base / 1.2, eurToUsd: 1.2, quotesAsOf: recent, fxAsOf: recent, reason: "hourly",
        invested: { indexUsd: 112, indexEur: 106, segment: recent, grossExposureUsd: 765432.1,
          positions: [{ kind: "security", referenceId: "secret-security", ticker: "SECRET", quantity: 54321, priceUsd: 14, exposureMultiplier: 1 }] },
      }).run();
    }
    const response = await dashboardGET(request("/api/v1/portfolio/overview"));
    assert.equal(response.status, 200);
    const entries = (await response.json()).data;
    assert.deepEqual(entries.map((entry: { id: string }) => entry.id).sort(), ["test-public", "test-weights"]);
    const weights = entries.find((entry: { id: string }) => entry.id === "test-weights");
    assert.equal(weights.snapshots[0].indexUsd, 100);
    assert.ok(Math.abs(weights.snapshots[1].indexUsd - 110) < 0.000001);
    assert.equal(weights.snapshots[0].valueUsd, undefined);
    assert.equal(weights.snapshots[0].valueEur, undefined);
    assert.equal(weights.snapshots[1].investedIndexUsd, 108);
    assert.equal(weights.snapshots[1].investedIndexEur, 104);
    assert.equal(weights.snapshots[0].investedSegment, "2026-10-01");
    assert.equal(weights.hourlySnapshots[0].indexUsd, 100);
    assert.equal(weights.hourlySnapshots[0].investedIndexUsd, 112);
    assert.equal(weights.hourlySnapshots[0].valueUsd, undefined);
    assert.ok(weights.hourlySnapshots[0].slotAt);
    assert(!JSON.stringify(entries).includes("secret-security"));
    assert(!JSON.stringify(entries).includes("765432"));
    assert(!JSON.stringify(entries).includes("quantity"));
    assert.equal(entries.find((entry: { id: string }) => entry.id === "test-public").snapshots[0].valueUsd, 100000);
    assert(!JSON.stringify(entries).includes("987654"));
    assert(!JSON.stringify(entries).includes("123456"));
    assert(!JSON.stringify(entries).includes("portfolioId"));
    assert(response.headers.get("cache-control")?.includes("no-store"));
    process.env.SITE_ACCESS_MODE = "local";
    const ownerResponse = await dashboardGET(request("/api/v1/portfolio/overview", "GET", undefined, "localhost:3210"));
    const ownerEntries = (await ownerResponse.json()).data;
    assert.equal(ownerEntries.length, 3);
    assert.equal(ownerEntries.find((entry: { id: string }) => entry.id === "test-weights").snapshots[0].valueUsd, 987654.32);
    assert.equal(ownerEntries.find((entry: { id: string }) => entry.id === "test-weights").hourlySnapshots[0].valueUsd, 987654.32);
    process.env.SITE_ACCESS_MODE = "cloudflare";
    getDb().update(etfs).set({ visibility: "weights" }).where(eq(etfs.id, "test-public")).run();
    const reduced = (await (await dashboardGET(request("/api/v1/portfolio/overview"))).json()).data;
    assert.equal(reduced.find((entry: { id: string }) => entry.id === "test-public").snapshots[0].valueUsd, undefined);
    assert.equal(reduced.find((entry: { id: string }) => entry.id === "test-public").hourlySnapshots[0].valueUsd, undefined);
    getDb().update(etfs).set({ visibility: "private" }).where(eq(etfs.id, "test-public")).run();
    const hidden = (await (await dashboardGET(request("/api/v1/portfolio/overview"))).json()).data;
    assert.deepEqual(hidden.map((entry: { id: string }) => entry.id), ["test-weights"]);
    getDb().update(etfs).set({ visibility: "public", metadataJson: { sourceEtfId: "test-private" } }).where(eq(etfs.id, "test-public")).run();
    const dependent = (await (await dashboardGET(request("/api/v1/portfolio/overview"))).json()).data;
    assert.deepEqual(dependent.map((entry: { id: string }) => entry.id), ["test-weights"]);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SITE_ACCESS_MODE = "cloudflare";
    getDb().update(etfs).set({ visibility: "public", metadataJson: originalMetadata ?? null }).where(eq(etfs.id, "test-public")).run();
  }
});

test("visitors can open the Portfolio detail with amounts only for fully public portfolios", async () => {
  for (const mode of ["public", "weights"] as const) {
    const path = `/api/v1/portfolio/published/test-${mode}`;
    const response = await publicDetailGET(request(path), ctx(`test-${mode}`));
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.kind, "portfolio");
    assert.equal(data.portfolio.amountsVisible, mode === "public");
    assert.equal(data.portfolio.id, `test-${mode}`);
    assert.equal(data.portfolio.cashPositions[0].weight, 100);
    assert.equal(data.portfolio.cashPositions[0].amount, mode === "public" ? 91827.36 : undefined);
    assert.equal(data.portfolio.analysis.totalMarketValueUsd, mode === "public" ? 91827.36 : undefined);
    assert(!JSON.stringify(data).includes("Secret:"));
    assert(!JSON.stringify(data).includes(`portfolio-${mode}`));
    if (mode === "weights") assert(!JSON.stringify(data).includes("91827"));
    const historyResponse = await publicHistoryGET(request(`${path}/history`), ctx(`test-${mode}`));
    assert.equal(historyResponse.status, 200);
    const history = (await historyResponse.json()).data;
    assert.equal(history.snapshots[0].indexUsd, 100);
    assert.equal(history.snapshots[0].valueUsd, mode === "public" ? 100000 : undefined);
    assert.equal(history.snapshots[1].investedIndexUsd, 108);
    assert.equal(history.snapshots[1].investedIndexEur, 104);
    assert.equal(history.hourlySnapshots[0].reason, "hourly");
    assert.equal(history.hourlySnapshots[0].indexUsd, 100);
    assert.equal(history.hourlySnapshots[0].investedIndexUsd, 112);
    assert.equal(history.hourlySnapshots[0].valueUsd, mode === "public" ? 100000 : undefined);
    assert.equal(history.hourlyLastError, null);
    assert(!JSON.stringify(history).includes("secret-security"));
    assert(!JSON.stringify(history).includes("grossExposureUsd"));
    assert(!JSON.stringify(history).includes("quantity"));
    assert.equal(history.lastError, null);
    if (mode === "weights") assert(!JSON.stringify(history).includes("987654"));
  }
  assert.equal((await publicDetailGET(request("/api/v1/portfolio/published/test-private"), ctx("test-private"))).status, 404);
  assert.equal((await publicHistoryGET(request("/api/v1/portfolio/published/test-private/history"), ctx("test-private"))).status, 404);
  assert.equal((await publicDetailGET(request("/api/v1/portfolio/published/ivv-us"), ctx("ivv-us"))).status, 404);
});

test("weights-only Portfolio details omit share quantities and original investment metadata", async () => {
  const etf = findEtfById("test-weights")!;
  const handler = withSiteAccess(async () => Response.json({ data: {
    kind: "portfolio", etf, editableDescription: "secret description with exact investment",
    portfolio: {
      id: "secret-editor-id", name: "Weights", baseCurrency: "USD", updatedAt: "2026-10-14",
      items: [{ id: "secret-item-id", kind: "security", referenceId: "stock", ticker: "STK", name: "Stock", allocationWeight: -5, quantity: -9876, inputAmount: 12345, initialPriceUsd: 999, currentValueUsd: -98765 }],
      cashPositions: [{ currency: "USD", amount: 54321, weight: 20, valueUsd: 54321 }],
      analysis: { totalMarketValueUsd: 987654, grossExposureWeight: 5, positions: [{ securityId: "stock", ticker: "STK", name: "Stock", weight: -5, contributions: [{ itemId: "secret-item-id", ticker: "STK", kind: "security", weight: -5 }] }] },
    },
  } }), "portfolio-detail");
  const response = await handler(request("/api/v1/portfolio/published/test-weights"));
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.portfolio.items[0].allocationWeight, -5);
  assert.equal(data.portfolio.items[0].quantity, undefined);
  assert.equal(data.portfolio.items[0].currentValueUsd, undefined);
  assert.equal(data.portfolio.analysis.positions[0].contributions[0].weight, -5);
  const text = JSON.stringify(data);
  for (const secret of ["secret-", "inputAmount", "initialPriceUsd", "9876", "54321", "quantity", "valueUsd"]) assert(!text.includes(secret), secret);
});

test("owner can change visibility without provider calls, immediately invalidating public access", async () => {
  const beforeRevision = catalogRevision();
  process.env.SITE_ACCESS_MODE = "local";
  try {
    const invalid = await visibilityPATCH(
      request(
        "/api/v1/local-etfs/test-public/visibility",
        "PATCH",
        { visibility: "invalid" },
        "localhost:3210",
      ),
      ctx("test-public"),
    );
    assert.equal(invalid.status, 400);
    const response = await visibilityPATCH(
      request(
        "/api/v1/local-etfs/test-public/visibility",
        "PATCH",
        { visibility: "private" },
        "localhost:3210",
      ),
      ctx("test-public"),
    );
    assert.equal(response.status, 200);
    assert.notEqual(catalogRevision(), beforeRevision);
  } finally {
    process.env.SITE_ACCESS_MODE = "cloudflare";
  }
  assert.equal(
    (
      await publishedGET(
        request("/api/v1/published-portfolios/test-public"),
        ctx("test-public"),
      )
    ).status,
    404,
  );
  assert(
    !siteCatalog(false)
      .flatMap((g) => g.variants)
      .some((e) => e.id === "test-public"),
  );
});

test("in-flight old representations are rejected after any owner mutation", async () => {
  const handler = withSiteAccess(async () => {
    invalidateSiteResults();
    return Response.json({ data: { amount: 91827.36 } });
  }, "published-portfolio");
  getDb()
    .update(etfs)
    .set({ visibility: "public" })
    .where(eq(etfs.id, "test-public"))
    .run();
  assert.equal(
    (await handler(request("/api/v1/published-portfolios/test-public"))).status,
    409,
  );
});

test("force refresh is throttled while ordinary reads remain available", async () => {
  siteRuntime.limits.clear();
  const seen: boolean[] = [];
  const handler = withSiteAccess((req: Request) => {
    seen.push(new URL(req.url).searchParams.get("refresh") === "true");
    return Response.json({ data: {} });
  }, "holdings");
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await handler(request("/api/v1/holdings/ivv-us?refresh=true"))).status,
      200,
    );
  assert.deepEqual(seen, [true, false, false]);
  assert(takeBudget("test", 1, 100, 0));
  assert(!takeBudget("test", 1, 100, 1));
  assert(takeBudget("test", 1, 100, 101));
});

test("public POST reads preserve their body and reject oversized or malformed payloads", async () => {
  siteRuntime.limits.clear();
  const seen: unknown[] = [];
  const handler = withSiteAccess(async (req: Request) => {
    seen.push(await req.json());
    return Response.json({ data: [] });
  }, "read");
  const body = {
    quotes: [{ key: "one", securityId: "TEST", ticker: "TEST" }],
    refresh: true,
  };
  assert.equal(
    (await handler(request("/api/v1/prices/quotes", "POST", body))).status,
    200,
  );
  assert.equal(
    (await handler(request("/api/v1/prices/quotes", "POST", body))).status,
    200,
  );
  assert.deepEqual(seen, [body, { ...body, refresh: false }]);
  assert.equal(
    (await handler(request("/api/v1/prices/quotes", "POST", null))).status,
    400,
  );
  assert.equal(
    (
      await handler(
        request("/api/v1/prices/quotes", "POST", {
          padding: "a".repeat(65_000),
        }),
      )
    ).status,
    413,
  );
  assert.equal(seen.length, 2);
});

test("owner creates and edits a portfolio through the API and publication changes immediately", async () => {
  siteRuntime.limits.clear();
  const now = new Date().toISOString();
  getDb()
    .insert(securities)
    .values({
      id: "SITE-STOCK",
      primaryTicker: "SITESTOCK",
      name: "Site test stock",
      assetClass: "Equity",
      country: "United States",
      sector: "Industrials",
    })
    .run();
  getDb()
    .insert(marketPrices)
    .values({
      id: "site-price",
      assetType: "security",
      assetId: "SITE-STOCK",
      providerSymbol: "SITESTOCK",
      price: 10,
      currency: "USD",
      fxToUsd: 1,
      priceUsd: 10,
      asOf: now,
      fetchedAt: now,
      source: "test",
      quoteMetadata: { session: "regular" },
    })
    .run();
  const items = [
    {
      id: "one",
      kind: "security",
      referenceId: "SITE-STOCK",
      inputMode: "shares",
      inputAmount: 127.125,
    },
  ];
  const cashPositions = [{ currency: "USD", amount: 321.09 }];
  let id = "";
  process.env.SITE_ACCESS_MODE = "local";
  try {
    const saved = await portfolioPUT(
      request(
        "/api/v1/portfolio",
        "PUT",
        { items, cashPositions },
        "localhost:3210",
      ),
    );
    assert.equal(saved.status, 200);
    const created = await savePOST(
      request(
        "/api/v1/portfolio/save-as-etf",
        "POST",
        {
          ticker: "SITEPF",
          name: "Site test portfolio",
          visibility: "weights",
        },
        "localhost:3210",
      ),
    );
    assert.equal(created.status, 201);
    id = (await created.json()).data.id;
  } finally {
    process.env.SITE_ACCESS_MODE = "cloudflare";
  }
  assert(
    siteCatalog(false)
      .flatMap((g) => g.variants)
      .some((e) => e.id === id),
  );
  assert.equal(
    (await publishedGET(request(`/api/v1/published-portfolios/${id}`), ctx(id)))
      .status,
    404,
  );
  process.env.SITE_ACCESS_MODE = "local";
  try {
    const updated = await localPATCH(
      request(
        `/api/v1/local-etfs/${id}`,
        "PATCH",
        {
          kind: "portfolio",
          ticker: "SITEPF",
          name: "Site test portfolio",
          description: "",
          visibility: "public",
          items,
          cashPositions,
        },
        "localhost:3210",
      ),
      ctx(id),
    );
    assert.equal(updated.status, 200);
  } finally {
    process.env.SITE_ACCESS_MODE = "cloudflare";
  }
  const published = await publishedGET(
    request(`/api/v1/published-portfolios/${id}`),
    ctx(id),
  );
  assert.equal(published.status, 200);
  const detail = (await published.json()).data;
  assert.equal(detail.items[0].quantity, 127.125);
  assert.equal(detail.cash[0].amount, 321.09);
  assert.equal(detail.totalMarketValueUsd, 1592.34);
});

test("AI endpoints reject visitors and unsigned owner requests before T3 or database access", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  for (const host of ["public.example.com", "owner.example.com"]) {
    const context = { params: Promise.resolve({ id }) };
    const responses = await Promise.all([
      aiConfigGET(request("/api/v1/ai/config", "GET", undefined, host)),
      aiRunsGET(request("/api/v1/ai/runs", "GET", undefined, host)),
      aiRunsPOST(request("/api/v1/ai/runs", "POST", {}, host)),
      aiRunGET(request(`/api/v1/ai/runs/${id}`, "GET", undefined, host), context),
      aiInterrupt(request(`/api/v1/ai/runs/${id}`, "DELETE", undefined, host), context),
      aiEventsGET(request(`/api/v1/ai/runs/${id}/events`, "GET", undefined, host), context),
    ]);
    for (const response of responses) assert.equal(response.status, 403);
  }
  process.env.SITE_ACCESS_MODE = "local";
  try {
    const badOrigin = new Request("http://localhost:3000/api/v1/ai/runs", { method: "POST", headers: { host: "localhost:3000", origin: "https://attacker.example" }, body: "{}" });
    assert.equal((await aiRunsPOST(badOrigin)).status, 403);
  } finally { process.env.SITE_ACCESS_MODE = "cloudflare"; }
});

test("every v1 route is wrapped by the site access boundary", () => {
  function inspect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) inspect(path);
      else if (entry.name === "route.ts") {
        const source = readFileSync(path, "utf8");
        assert(source.includes("withSiteAccess") || (path.includes(`${join("api", "v1", "ai")}`) && source.includes("withAiAccess")), path);
        assert(
          !/export (?:async )?function (?:GET|POST|PUT|PATCH|DELETE)/.test(
            source,
          ),
          path,
        );
      }
    }
  }
  inspect("src/app/api/v1");
});
