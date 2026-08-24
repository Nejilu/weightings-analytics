import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

const migrationDirectory = resolve(process.cwd(), "drizzle");
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "index-lens-migrations-"),
);
const databaseFile = join(temporaryDirectory, "upgrade.sqlite");
const sqlite = new Database(databaseFile);

function executeMigration(filename) {
  const sql = readFileSync(
    join(migrationDirectory, filename),
    "utf8",
  ).replaceAll("--> statement-breakpoint", "");
  sqlite.exec(sql);
}

try {
  executeMigration("0000_woozy_frightful_four.sql");
  sqlite
    .prepare(
      "INSERT INTO benchmarks (id, name, provider) VALUES (?, ?, ?)",
    )
    .run("legacy", "Legacy benchmark", "Test");
  sqlite
    .prepare(
      `INSERT INTO etfs (
        id, ticker, isin, name, issuer, benchmark_id, wrapper, domicile,
        exchange, trading_currency, distribution_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy-etf",
      "OLD",
      "TEST-OLD",
      "Legacy ETF",
      "Test",
      "legacy",
      "UCITS",
      "Test",
      "Test",
      "USD",
      "Accumulating",
    );

  executeMigration("0001_local_persistence.sql");
  executeMigration("0002_cold_firelord.sql");
  executeMigration("0003_safe_sentry.sql");
  executeMigration("0004_sturdy_mentallo.sql");
  executeMigration("0005_dark_sentinels.sql");
  executeMigration("0006_tense_sentry.sql");

  sqlite.exec(`
    INSERT INTO metric_definitions (
      id, key, name, entity_type, value_type
    ) VALUES ('security:eps_estimate_series:v1', 'eps_estimate_series',
      'EPS estimates', 'security', 'json');
    INSERT INTO securities (id, name) VALUES ('security:invalid-series', 'Invalid series');
    INSERT INTO securities (id, name) VALUES ('security:valid-series', 'Valid series');
    INSERT INTO metric_observations (
      id, metric_definition_id, entity_type, entity_id, as_of, value_json, captured_at
    ) VALUES
      ('invalid-estimate-series', 'security:eps_estimate_series:v1', 'security',
       'security:invalid-series', '2026-08-01',
       '{"providerSymbol":"NASDAQ:INVALID","currency":"USD","price":100,"points":[
         {"fiscalPeriod":"2026-Q1","estimate":1,"isHistorical":true},
         {"fiscalPeriod":"2026-Q1","estimate":1.1,"isHistorical":true},
         {"fiscalPeriod":"2026-Q2","estimate":1.2,"isHistorical":true},
         {"fiscalPeriod":"2026-Q3","estimate":1.3,"isHistorical":true},
         {"fiscalPeriod":"2026-Q4","estimate":1.4,"isHistorical":false},
         {"fiscalPeriod":"2027-Q1","estimate":1.5,"isHistorical":false},
         {"fiscalPeriod":"2027-Q2","estimate":1.6,"isHistorical":false},
         {"fiscalPeriod":"2027-Q3","estimate":1.7,"isHistorical":false}
       ]}', '2026-08-01T00:00:00.000Z'),
      ('valid-estimate-series', 'security:eps_estimate_series:v1', 'security',
       'security:valid-series', '2026-08-01',
       '{"providerSymbol":"NASDAQ:VALID","currency":"USD","price":100,"points":[
         {"fiscalPeriod":"2026-Q1","estimate":1,"isHistorical":true},
         {"fiscalPeriod":"2026-Q2","estimate":1.1,"isHistorical":true},
         {"fiscalPeriod":"2026-Q3","estimate":1.2,"isHistorical":true},
         {"fiscalPeriod":"2026-Q4","estimate":1.3,"isHistorical":true},
         {"fiscalPeriod":"2027-Q1","estimate":1.4,"isHistorical":false},
         {"fiscalPeriod":"2027-Q2","estimate":1.5,"isHistorical":false},
         {"fiscalPeriod":"2027-Q3","estimate":1.6,"isHistorical":false},
         {"fiscalPeriod":"2027-Q4","estimate":1.7,"isHistorical":false}
       ]}', '2026-08-01T00:00:00.000Z');
  `);
  executeMigration("0007_clean_invalid_estimate_series.sql");

  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS count FROM metric_observations WHERE id = 'invalid-estimate-series'",
    ).get().count,
    0,
  );
  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS count FROM metric_observations WHERE id = 'valid-estimate-series'",
    ).get().count,
    1,
  );

  sqlite.exec(`
    INSERT INTO metric_observations (
      id, metric_definition_id, entity_type, entity_id, as_of, value_json, captured_at
    ) VALUES
      ('malformed-estimate-json', 'security:eps_estimate_series:v1', 'security',
       'security:invalid-series', '2026-08-02', 'not-json', '2026-08-02T00:00:00.000Z'),
      ('missing-estimate-points', 'security:eps_estimate_series:v1', 'security',
       'security:invalid-series', '2026-08-03',
       '{"providerSymbol":"NASDAQ:INVALID","currency":"USD","price":100}',
       '2026-08-03T00:00:00.000Z');
  `);
  executeMigration("0008_quarantine_malformed_estimate_json.sql");

  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS count FROM metric_observations WHERE id IN ('malformed-estimate-json', 'missing-estimate-points')",
    ).get().count,
    0,
  );
  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS count FROM metric_observations WHERE id = 'valid-estimate-series'",
    ).get().count,
    1,
  );

  sqlite.exec(`
    INSERT INTO metric_definitions (
      id, key, name, entity_type, value_type
    ) VALUES ('security:pe_ttm:v1', 'pe_ttm', 'Retired P/E', 'security', 'number');
    INSERT INTO metric_observations (
      id, metric_definition_id, entity_type, entity_id, as_of, value_number, captured_at
    ) VALUES ('retired-pe-observation', 'security:pe_ttm:v1', 'security',
      'security:valid-series', '2026-08-03', 20, '2026-08-03T00:00:00.000Z');
  `);
  executeMigration("0009_retire_legacy_metric_definitions.sql");
  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS count FROM metric_definitions WHERE id = 'security:pe_ttm:v1'",
    ).get().count,
    0,
  );
  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS count FROM metric_observations WHERE id = 'retired-pe-observation'",
    ).get().count,
    0,
  );
  executeMigration("0009_retire_legacy_metric_definitions.sql");
  executeMigration("0010_persist_provider_negative_cache.sql");
  executeMigration("0011_melodic_cerise.sql");

  sqlite.exec(`
    INSERT INTO etfs (
      id, ticker, isin, name, issuer, benchmark_id, wrapper, domicile,
      exchange, trading_currency, distribution_policy
    ) VALUES
      ('acwi-us', 'ACWI', 'TEST-ACWI', 'ACWI', 'Test', 'legacy',
       'US_1940_ACT', 'United States', 'NASDAQ', 'USD', 'Distributing'),
      ('panx-ucits', 'PANX', 'TEST-PANX', 'PANX', 'Test', 'legacy',
       'SYNTHETIC', 'France', 'Euronext Paris', 'EUR', 'Accumulating');
    INSERT INTO securities (id, isin, primary_ticker, name) VALUES
      ('FR0010340141', 'FR0010340141', 'ADP', 'AEROPORTS DE PARIS SA'),
      ('US0530151036', 'US0530151036', 'ADP', 'AUTOMATIC DATA PROCESSING INC'),
      ('US5949181045', 'US5949181045', 'MSFT', 'MICROSOFT CORP');
    INSERT INTO holding_snapshots (
      id, etf_id, as_of, fetched_at, source_url, source_status,
      total_weight, row_count
    ) VALUES
      ('acwi-snapshot', 'acwi-us', '2026-08-19', '2026-08-20T20:00:00Z',
       'test', 'live', 100, 1),
      ('panx-snapshot', 'panx-ucits', '2026-08-19', '2026-08-20T21:00:00Z',
       'test', 'live', 100, 2);
    INSERT INTO holdings (
      snapshot_id, security_id, weight, market_value, source_ticker
    ) VALUES
      ('acwi-snapshot', 'US0530151036', 0.1, 40, 'ADP'),
      ('panx-snapshot', 'FR0010340141', 1.6393442623, 1, 'ADP'),
      ('panx-snapshot', 'US5949181045', 98.3606557377, 60, 'MSFT');
  `);
  executeMigration("0012_correct_panx_adp_identity.sql");

  const correctedPanx = sqlite.prepare(`
    SELECT security_id AS securityId, market_value AS marketValue, weight
    FROM holdings
    WHERE snapshot_id = 'panx-snapshot'
    ORDER BY security_id
  `).all();
  assert.deepEqual(correctedPanx, [
    { securityId: "US0530151036", marketValue: 40, weight: 40 },
    { securityId: "US5949181045", marketValue: 60, weight: 60 },
  ]);

  const upgradedEtf = sqlite
    .prepare(
      `SELECT product_url AS productUrl, holdings_url AS holdingsUrl,
        fund_type AS fundType
       FROM etfs WHERE id = ?`,
    )
    .get("legacy-etf");
  assert.deepEqual(upgradedEtf, {
    productUrl: "",
    holdingsUrl: "",
    fundType: "physical",
  });

  const tables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'portfolio_cash_positions', 'portfolios', 'portfolio_items',
         'security_provider_symbols'
       )
       ORDER BY name`,
    )
    .all();
  assert.deepEqual(
    tables.map((table) => table.name),
    [
      "portfolio_cash_positions",
      "portfolio_items",
      "portfolios",
      "security_provider_symbols",
    ],
  );

  const metricIndexes = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'metric_observations_latest_idx'`,
    )
    .all();
  assert.equal(metricIndexes.length, 1);

  const negativeCacheTables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'provider_negative_cache'`,
    )
    .all();
  assert.equal(negativeCacheTables.length, 1);
  const negativeCacheIndexes = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name IN (
         'provider_negative_cache_expiry_idx',
         'provider_negative_cache_symbol_idx'
       )
       ORDER BY name`,
    )
    .all();
  assert.deepEqual(
    negativeCacheIndexes.map((index) => index.name),
    [
      "provider_negative_cache_expiry_idx",
      "provider_negative_cache_symbol_idx",
    ],
  );

  console.log("Migration smoke test passed.");
} finally {
  sqlite.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
