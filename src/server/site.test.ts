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

test("missing configuration and production local mode fail closed", async () => {
  const saved = process.env.CF_ACCESS_AUD;
  delete process.env.CF_ACCESS_AUD;
  await assert.rejects(
    getSiteAccess(new Headers({ host: "public.example.com" })),
  );
  process.env.CF_ACCESS_AUD = saved;
  const nodeEnv = process.env.NODE_ENV;
  process.env.SITE_ACCESS_MODE = "local";
  Object.assign(process.env, { NODE_ENV: "production" });
  await assert.rejects(getSiteAccess(new Headers({ host: "localhost:3210" })));
  if (nodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
  else Object.assign(process.env, { NODE_ENV: nodeEnv });
  process.env.SITE_ACCESS_MODE = "cloudflare";
  assert.throws(() =>
    requireOwner(
      {
        owner: true,
        ownerOrigin: "https://owner.example.com",
        publicOrigin: "https://public.example.com",
      },
      request("/api/v1/portfolio", "PUT", {}, "public.example.com"),
    ),
  );
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

test("every v1 route is wrapped by the site access boundary", () => {
  function inspect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) inspect(path);
      else if (entry.name === "route.ts") {
        const source = readFileSync(path, "utf8");
        assert(source.includes("withSiteAccess"), path);
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
