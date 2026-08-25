import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "weightings-analytics-metrics-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(temporaryDirectory, "metrics.sqlite");

const [{ closeDatabase, getDb }, { migrateDatabase }, repository, schema] = await Promise.all([
  import("../client"),
  import("../migrate"),
  import("./metrics-repository"),
  import("../schema"),
]);

test("persists metric batches and keeps definitions idempotent", () => {
  try {
    migrateDatabase();
    const db = getDb();
    db.insert(schema.securities).values([
      {
        id: "security:test",
        primaryTicker: "TEST",
        name: "Test Security",
        assetClass: "Equity",
      },
      {
        id: "security:test-2",
        primaryTicker: "TEST2",
        name: "Second Test Security",
        assetClass: "Equity",
      },
    ]).run();

    repository.ensureMetricDefinitions();
    db.insert(schema.metricDefinitions).values({
      id: "security:pe_ttm:v1",
      key: "pe_ttm",
      name: "Retired P/E",
      entityType: "security",
      valueType: "number",
    }).run();
    db.insert(schema.metricObservations).values({
      id: "retired-pe-observation",
      metricDefinitionId: "security:pe_ttm:v1",
      entityType: "security",
      entityId: "security:test",
      asOf: "2026-08-01",
      valueNumber: 20,
      capturedAt: "2026-08-01T00:00:00.000Z",
    }).run();
    repository.saveProviderSymbolsBatch([
      {
        securityId: "security:test",
        providerSymbol: "NASDAQ:TEST",
        status: "resolved",
        confidence: 1,
        verifiedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        securityId: "security:test-2",
        providerSymbol: "NASDAQ:TEST2",
        status: "resolved",
        confidence: 0.9,
        verifiedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    repository.saveSecurityMetricsBatch([
      {
        securityId: "security:test",
        providerSymbol: "NASDAQ:TEST",
        values: { price_to_book: 2.5, beta_1y: 1.1 },
      },
      {
        securityId: "security:test-2",
        providerSymbol: "NASDAQ:TEST2",
        values: { price_to_book: 3.5, beta_1y: 1.2 },
      },
    ], "2026-08-01T00:00:00.000Z");
    const makeSeries = (providerSymbol: string, price: number) => ({
      providerSymbol,
      currency: "USD",
      price,
      points: Array.from({ length: 8 }, (_, index) => ({
        fiscalPeriod: `Q${index + 1}`,
        estimate: 1 + index,
        isHistorical: index < 4,
        estimateDate: null,
        analystCount: 10,
      })),
    });
    repository.saveEstimateSeriesBatch([
      { securityId: "security:test", series: makeSeries("NASDAQ:TEST", 100) },
      { securityId: "security:test-2", series: makeSeries("NASDAQ:TEST2", 120) },
    ], "2026-08-01T00:00:00.000Z");
    db.insert(schema.metricObservations).values({
      id: "malformed-estimate-observation",
      metricDefinitionId: "security:eps_estimate_series:v1",
      entityType: "security",
      entityId: "security:test",
      asOf: "2026-08-03",
      valueText: "NASDAQ:TEST",
      valueJson: { points: [] },
      source: "test",
      capturedAt: "2026-08-03T00:00:00.000Z",
    }).run();
    repository.saveDerivedSecurityMetricsBatch([
      {
        securityId: "security:test",
        providerSymbol: "NASDAQ:TEST",
        values: { pe_estimate_window_0: 20, eps_growth_estimate_forward_4q: 15 },
        capturedAt: "2026-08-02T00:00:00.000Z",
      },
      {
        securityId: "security:test-2",
        providerSymbol: "NASDAQ:TEST2",
        values: { pe_estimate_window_0: 24, eps_growth_estimate_forward_4q: 12 },
        capturedAt: "2026-08-02T00:00:00.000Z",
      },
    ]);
    repository.saveSecurityMetricsBatch([
      {
        securityId: "security:test",
        providerSymbol: "NASDAQ:TEST",
        values: { price_to_book: 2.6, beta_1y: 1.2 },
      },
    ], "2026-08-01T00:00:00.000Z");
    repository.saveSecurityMetricsBatch([
      {
        securityId: "security:test",
        providerSymbol: "NASDAQ:TEST",
        values: { price_to_book: 2.8 },
      },
    ], "2026-08-02T00:00:00.000Z");

    const beforeSecondEnsure = db
      .select({ count: schema.metricObservations.id })
      .from(schema.metricObservations)
      .all().length;
    repository.ensureMetricDefinitions();
    const afterSecondEnsure = db
      .select({ count: schema.metricObservations.id })
      .from(schema.metricObservations)
      .all().length;

    assert.equal(beforeSecondEnsure, afterSecondEnsure);
    assert.equal(repository.loadProviderSymbols(["security:test", "security:test-2"]).size, 2);
    assert.equal(repository.loadLatestSecurityMetrics(["security:test", "security:test-2"]).get("security:test-2")?.values.price_to_book, 3.5);
    assert.equal(repository.loadLatestSecurityMetrics(["security:test"]).get("security:test")?.values.pe_estimate_window_0, 20);
    assert.equal(repository.loadLatestEstimateSeries(["security:test", "security:test-2"]).get("security:test-2")?.series.points.length, 8);
    assert.equal(repository.loadLatestEstimateSeries(["security:test"]).get("security:test")?.capturedAt, "2026-08-01T00:00:00.000Z");
    assert.equal(repository.loadLatestSecurityMetrics(["security:test"]).get("security:test")?.capturedAt, "2026-08-02T00:00:00.000Z");
    const latestMetrics = repository.loadLatestSecurityMetrics(["security:test"]).get("security:test");
    assert.equal(latestMetrics?.values.price_to_book, 2.8);
    assert.equal(latestMetrics?.values.beta_1y, 1.2);
    assert.equal(latestMetrics?.sourceCapturedAtByKey.get("beta_1y"), "2026-08-01T00:00:00.000Z");
    assert.equal(latestMetrics?.sourceProviderSymbolByKey.get("beta_1y"), "NASDAQ:TEST");
    assert.equal(latestMetrics?.capturedAt, "2026-08-02T00:00:00.000Z");
    assert.equal(db.select().from(schema.metricDefinitions).all()
      .some((definition) => definition.id === "security:pe_ttm:v1"), true);
    assert.equal(db.select().from(schema.metricObservations).all()
      .some((observation) => observation.id === "retired-pe-observation"), true);

    repository.saveDerivedSecurityMetricsBatch([
      {
        securityId: "security:test",
        providerSymbol: "NASDAQ:TEST",
        values: { pe_estimate_window_4: 22 },
        capturedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
    const invalidated = repository.loadLatestSecurityMetrics(["security:test"]).get("security:test");
    assert.equal(invalidated?.values.pe_estimate_window_0, undefined);
    assert.equal(invalidated?.values.pe_estimate_window_4, 22);

    const now = Date.parse("2026-08-04T00:00:00.000Z");
    repository.saveProviderNegativeCacheBatch([
      {
        provider: "tradingview",
        cacheKind: "estimate_series",
        providerSymbol: "NASDAQ:MISSING",
        metricKey: "",
        expiresAt: now + 60_000,
      },
      {
        provider: "tradingview",
        cacheKind: "source_metric",
        providerSymbol: "NASDAQ:PARTIAL",
        metricKey: "pe_ttm",
        expiresAt: now + 120_000,
      },
      {
        provider: "other-provider",
        cacheKind: "estimate_series",
        providerSymbol: "OTHER:MISSING",
        metricKey: "",
        expiresAt: now + 120_000,
      },
      {
        provider: "tradingview",
        cacheKind: "source_metric",
        providerSymbol: "NASDAQ:EXPIRED",
        metricKey: "pe_ttm",
        expiresAt: now,
      },
    ]);
    assert.deepEqual(
      repository.loadProviderNegativeCache(now).map((entry) => ({
        provider: entry.provider,
        cacheKind: entry.cacheKind,
        providerSymbol: entry.providerSymbol,
        metricKey: entry.metricKey,
        expiresAt: entry.expiresAt,
      })),
      [
        {
          provider: "tradingview",
          cacheKind: "estimate_series",
          providerSymbol: "NASDAQ:MISSING",
          metricKey: "",
          expiresAt: now + 60_000,
        },
        {
          provider: "tradingview",
          cacheKind: "source_metric",
          providerSymbol: "NASDAQ:PARTIAL",
          metricKey: "pe_ttm",
          expiresAt: now + 120_000,
        },
      ],
    );
    repository.pruneExpiredProviderNegativeCache(now);
    const expiredAfterPrune = db
      .select()
      .from(schema.providerNegativeCache)
      .all()
      .find((entry) => entry.providerSymbol === "NASDAQ:EXPIRED");
    assert.equal(expiredAfterPrune, undefined);
    repository.deleteProviderNegativeCacheBatch([
      {
        provider: "tradingview",
        cacheKind: "estimate_series",
        providerSymbol: "NASDAQ:MISSING",
        metricKey: "",
      },
    ]);
    assert.equal(
      repository.loadProviderNegativeCache(now).some((entry) =>
        entry.providerSymbol === "NASDAQ:MISSING"),
      false,
    );
  } finally {
    closeDatabase();
    if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalDatabasePath;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
