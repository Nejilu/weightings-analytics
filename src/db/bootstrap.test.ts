import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ensureLocalDatabase } from "./bootstrap";
import { applicationRoot, closeDatabase, getDb, getSqlite } from "./client";
import { seedCatalog } from "./seed";
import { ensureMetricDefinitions } from "./repositories/metrics-repository";
import {
  findEtfById,
  findEtfByTicker,
  findSecuritiesByIds,
} from "./repositories/catalog-repository";
import { etfs } from "./schema";

test("catalog cleanup retains saved selections and removes caches of removed securities", () => {
  const originalPath = process.env.DATABASE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "cache-catalog-cleanup-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    closeDatabase(); ensureLocalDatabase(); ensureMetricDefinitions();
    const db = getSqlite();
    db.exec("INSERT INTO securities (id,name) VALUES ('REMOVED:OLD','Removed'),('SELECTED:KEEP','Selected')");
    const source = findEtfById("qtop-us")!;
    getDb().insert(etfs).values({ ...source, issuer: "Test", id: "saved-selection", ticker: "SELECT", isin: "TEST-SELECT",
      fundType: "custom", metadataJson: { sourceEtfId: source.id, selectedSecurities: [{ securityId: "SELECTED:KEEP", ticker: "KEEP" }] } }).run();
    for (const securityId of ['REMOVED:OLD','SELECTED:KEEP']) {
      db.prepare(`INSERT INTO metric_observations (id,metric_definition_id,entity_type,entity_id,as_of,value_number,captured_at)
        VALUES (?,'security:price_to_book:v1','security',?,'2026-10-01',2,'2026-10-01T00:00:00Z')`).run(`metric-${securityId}`,securityId);
      db.prepare(`INSERT INTO market_prices (id,asset_type,asset_id,provider_symbol,price,currency,fx_to_usd,price_usd,as_of,fetched_at,source)
        VALUES (?,'security',?,'TEST',100,'USD',1,100,'2026-10-01','2026-10-01T00:00:00Z','test')`).run(`listing-${securityId}`,`listing:${securityId}:TEST`);
    }
    seedCatalog();
    assert.equal(findSecuritiesByIds(['REMOVED:OLD']).size,0);
    assert.equal(findSecuritiesByIds(['SELECTED:KEEP']).size,1);
    assert.deepEqual(db.prepare('SELECT entity_id FROM metric_observations').all(), [{entity_id:'SELECTED:KEEP'}]);
    assert.deepEqual(db.prepare('SELECT asset_id FROM market_prices').all(), [{asset_id:'listing:SELECTED:KEEP:TEST'}]);
  } finally {
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
    rmSync(directory, {recursive:true,force:true});
  }
});

test("reinitializes migrations and catalog when DATABASE_PATH changes", () => {
  const originalPath = process.env.DATABASE_PATH;
  const firstDirectory = mkdtempSync(join(tmpdir(), "weightings-analytics-bootstrap-a-"));
  const secondDirectory = mkdtempSync(join(tmpdir(), "weightings-analytics-bootstrap-b-"));
  try {
    process.env.DATABASE_PATH = join(firstDirectory, "first.sqlite");
    ensureLocalDatabase();
    assert.equal(getDb().select({ id: etfs.id }).from(etfs).limit(1).get()?.id, "acwi-us");
    assert.equal(findEtfByTicker("QTOP")?.id, "qtop-us");
    assert.equal(
      findEtfById("qtop-ucits")?.holdingsSourceEtfId,
      "qtop-us",
    );
    assert.deepEqual(findSecuritiesByIds(["US55087P1049"]).get("US55087P1049"), {
      securityId: "US55087P1049",
      isin: "US55087P1049",
      ticker: "LYFT",
      name: "LYFT INC CLASS A",
      assetClass: "Equity",
      sector: "Industrials",
      country: "United States",
      exchange: "NASDAQ",
    });
    assert.ok(existsSync(process.env.DATABASE_PATH));

    closeDatabase();
    ensureLocalDatabase();
    assert.equal(getDb().select({ id: etfs.id }).from(etfs).limit(1).get()?.id, "acwi-us");

    process.env.DATABASE_PATH = join(secondDirectory, "second.sqlite");
    ensureLocalDatabase();
    assert.equal(getDb().select({ id: etfs.id }).from(etfs).limit(1).get()?.id, "acwi-us");
    assert.ok(existsSync(process.env.DATABASE_PATH));
  } finally {
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
    rmSync(firstDirectory, { recursive: true, force: true });
    rmSync(secondDirectory, { recursive: true, force: true });
  }
});

test("anchors direct standalone runtime paths to the project root", () => {
  const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  assert.equal(
    applicationRoot(join(projectRoot, ".next", "standalone")),
    projectRoot,
  );
  assert.equal(applicationRoot(projectRoot), projectRoot);
});
