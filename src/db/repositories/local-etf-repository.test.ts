import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureLocalDatabase } from "../bootstrap";
import { closeDatabase, getSqlite } from "../client";
import {
  deleteLocalEtfRecord,
  updateLocalEtfRecord,
} from "./local-etf-repository";

test("updates and fully deletes custom and portfolio ETFs", () => {
  const originalPath = process.env.DATABASE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "index-lens-local-etfs-"));
  try {
    process.env.DATABASE_PATH = join(directory, "local-etfs.sqlite");
    closeDatabase();
    ensureLocalDatabase();
    const sqlite = getSqlite();

    sqlite.exec(`
      INSERT INTO benchmarks (id, name, provider)
      VALUES ('test-custom', 'Test custom', 'IndexLens');
      INSERT INTO benchmarks (id, name, provider)
      VALUES ('test-portfolio', 'Test portfolio', 'IndexLens');
      INSERT INTO securities (id, primary_ticker, name)
      VALUES ('LOCAL-SECURITY', 'LOCAL', 'Local security');
      INSERT INTO portfolios (id, name, base_currency)
      VALUES ('saved-portfolio-test', 'Old portfolio name', 'USD');
      INSERT INTO etfs (
        id, ticker, isin, name, issuer, benchmark_id, wrapper, domicile,
        exchange, trading_currency, distribution_policy, product_url,
        holdings_url, fund_type, portfolio_id
      ) VALUES (
        'custom-etf-test', 'CUST', 'LOCAL-CUST', 'Old custom name',
        'IndexLens', 'test-custom', 'SYNTHETIC', 'Local workspace',
        'IndexLens', 'USD', 'Look-through', '/custom', 'local://custom',
        'custom', NULL
      );
      INSERT INTO etfs (
        id, ticker, isin, name, issuer, benchmark_id, wrapper, domicile,
        exchange, trading_currency, distribution_policy, product_url,
        holdings_url, fund_type, portfolio_id
      ) VALUES (
        'portfolio-etf-test', 'PORT', 'LOCAL-PORT', 'Old portfolio name',
        'IndexLens', 'test-portfolio', 'SYNTHETIC', 'Local workspace',
        'IndexLens', 'USD', 'Look-through', '/portfolio', 'local://portfolio',
        'portfolio', 'saved-portfolio-test'
      );
      INSERT INTO holding_snapshots (
        id, etf_id, as_of, fetched_at, source_url, source_status,
        total_weight, row_count
      ) VALUES (
        'custom-snapshot-test', 'custom-etf-test', '2026-08-10',
        '2026-08-10T00:00:00Z', 'local://custom', 'cached', 100, 1
      );
      INSERT INTO holdings (snapshot_id, security_id, weight)
      VALUES ('custom-snapshot-test', 'LOCAL-SECURITY', 100);
      INSERT INTO portfolio_items (
        id, portfolio_id, asset_type, security_id, allocation_weight
      ) VALUES (
        'saved-portfolio-item-test', 'saved-portfolio-test', 'security',
        'LOCAL-SECURITY', 100
      );
    `);

    const updated = updateLocalEtfRecord({
      id: "portfolio-etf-test",
      ticker: "NEWP",
      name: "New portfolio name",
      description: "Updated description",
    });
    assert.equal(updated?.ticker, "NEWP");
    assert.equal(
      (
        sqlite
          .prepare("SELECT name FROM portfolios WHERE id = ?")
          .get("saved-portfolio-test") as { name: string }
      ).name,
      "New portfolio name",
    );

    assert.equal(deleteLocalEtfRecord("custom-etf-test"), true);
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM holding_snapshots WHERE etf_id = ?")
          .get("custom-etf-test") as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM securities WHERE id = ?")
          .get("LOCAL-SECURITY") as { count: number }
      ).count,
      1,
    );

    assert.equal(deleteLocalEtfRecord("portfolio-etf-test"), true);
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM etfs WHERE id = ?")
        .get("portfolio-etf-test") as { count: number }).count,
      0,
    );
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM portfolios WHERE id = ?")
        .get("saved-portfolio-test") as { count: number }).count,
      0,
    );
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM portfolio_items WHERE portfolio_id = ?")
        .get("saved-portfolio-test") as { count: number }).count,
      0,
    );
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM securities WHERE id = ?")
        .get("LOCAL-SECURITY") as { count: number }).count,
      0,
    );
    assert.equal(deleteLocalEtfRecord("ivv-us"), false);
  } finally {
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
