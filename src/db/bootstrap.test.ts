import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ensureLocalDatabase } from "./bootstrap";
import { applicationRoot, closeDatabase, getDb } from "./client";
import {
  findEtfById,
  findEtfByTicker,
  findSecuritiesByIds,
} from "./repositories/catalog-repository";
import { etfs } from "./schema";

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
  const projectRoot = resolve("weightings-analytics");
  assert.equal(
    applicationRoot(join(projectRoot, ".next", "standalone")),
    projectRoot,
  );
  assert.equal(applicationRoot(projectRoot), projectRoot);
});
