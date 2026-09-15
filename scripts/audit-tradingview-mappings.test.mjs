import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { auditDatabase } from "./audit-tradingview-mappings.mjs";

function fixture({ valid }) {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE etfs (id TEXT PRIMARY KEY, ticker TEXT, active INTEGER, metadata_json TEXT);
    CREATE TABLE holding_snapshots (id TEXT PRIMARY KEY, etf_id TEXT, as_of TEXT, fetched_at TEXT);
    CREATE TABLE holdings (snapshot_id TEXT, security_id TEXT, weight REAL);
    CREATE TABLE securities (
      id TEXT PRIMARY KEY, primary_ticker TEXT, name TEXT, asset_class TEXT,
      country TEXT, identifiers_json TEXT
    );
    CREATE TABLE security_provider_symbols (
      provider TEXT, security_id TEXT, provider_symbol TEXT, status TEXT,
      metadata_json TEXT, last_verified_at TEXT
    );
    CREATE TABLE metric_observations (
      id TEXT PRIMARY KEY, metric_definition_id TEXT, entity_type TEXT,
      entity_id TEXT, value_text TEXT, value_json TEXT, captured_at TEXT
    );
    CREATE TABLE portfolio_items (asset_type TEXT, security_id TEXT);
    CREATE TABLE market_prices (asset_type TEXT, asset_id TEXT);
  `);
  const mappingSymbol = valid ? "NASDAQ:GOOD" : "NASDAQ:WRONG";
  const sourceSymbol = valid ? mappingSymbol : "NASDAQ:OTHER";
  sqlite.exec(`
    INSERT INTO etfs VALUES ('etf-1', 'TEST', 1, NULL);
    INSERT INTO holding_snapshots VALUES ('snapshot-1', 'etf-1', '2026-08-01', '2026-08-02T00:00:00.000Z');
    INSERT INTO securities VALUES (
      'security-1', 'GOOD', 'Good Company', 'Equity', 'Taiwan',
      '{"exchange":"Taiwan Stock Exchange"}'
    );
    INSERT INTO holdings VALUES ('snapshot-1', 'security-1', 100.0);
    INSERT INTO security_provider_symbols VALUES (
      'tradingview', 'security-1', '${mappingSymbol}', 'resolved',
      ${valid ? "'{\"mappingProvenance\":\"exact_exchange\"}'" : "NULL"},
      '2026-08-02T00:00:00.000Z'
    );
    INSERT INTO metric_observations VALUES (
      'source-1', 'security:price_to_book:v1', 'security', 'security-1',
      '${sourceSymbol}', NULL, '2026-08-02T00:00:00.000Z'
    );
    INSERT INTO metric_observations VALUES (
      'estimate-1', 'security:eps_estimate_series:v1', 'security', 'security-1',
      '${sourceSymbol}', '{"providerSymbol":"${sourceSymbol}"}', '2026-08-02T00:00:00.000Z'
    );
  `);
  return sqlite;
}

test("audits current ETF coverage and accepts a fully identified mapping", () => {
  const sqlite = fixture({ valid: true });
  try {
    const audit = auditDatabase(sqlite, "fixture");
    assert.equal(audit.resolvedMappings, 1);
    assert.equal(audit.resolvedWithoutProvenance, 0);
    assert.deepEqual(audit.identity, {
      sourceMismatches: 0,
      estimateMismatches: 0,
      duplicateListings: 0,
      historicalListingCollisions: [],
      duplicateStrongIdentifiers: 0,
      orphanReferences: 0,
    });
    assert.equal(audit.etfs[0].mappingCoverageWeight, 100);
    assert.deepEqual(audit.provenanceCounts, { exact_exchange: 1 });
    assert.deepEqual(audit.etfs[0].countryExchange, [{
      country: "Taiwan",
      exchange: "Taiwan Stock Exchange",
      holdings: 1,
      mapped: 1,
      totalWeight: 100,
      mappedWeight: 100,
      mappingCoverageWeight: 100,
      provenance: { exact_exchange: 100 },
    }]);
  } finally {
    sqlite.close();
  }
});

test("reports missing provenance and persisted identity mismatches", () => {
  const sqlite = fixture({ valid: false });
  try {
    const audit = auditDatabase(sqlite, "fixture");
    assert.equal(audit.resolvedWithoutProvenance, 1);
    assert.deepEqual(audit.identity, {
      sourceMismatches: 1,
      estimateMismatches: 1,
      duplicateListings: 0,
      historicalListingCollisions: [],
      duplicateStrongIdentifiers: 0,
      orphanReferences: 0,
    });
    assert.equal(audit.etfs[0].provenance.missing_provenance, 100);
  } finally {
    sqlite.close();
  }
});

test("reports duplicate strong identifiers even when listing labels differ", () => {
  const sqlite = fixture({ valid: true });
  try {
    sqlite.exec(`
      UPDATE securities
      SET identifiers_json = '{"exchange":"NASDAQ","sedol":"2046251"}'
      WHERE id = 'security-1';
      INSERT INTO securities VALUES (
        'security-2', 'AAPL-US', 'Apple Computer', 'Equity', 'US',
        '{"exchange":"NYSE","sedol":"2046251"}'
      );
    `);
    const audit = auditDatabase(sqlite, "fixture");
    assert.equal(audit.identity.duplicateListings, 0);
    assert.equal(audit.identity.duplicateStrongIdentifiers, 1);
  } finally {
    sqlite.close();
  }
});

function addHistoricalListing(sqlite) {
  sqlite.exec(`
    INSERT INTO securities VALUES (
      'old-security', 'GOOD', 'Good Company', 'Equity', 'Taiwan',
      '{"sedol":"OLD1234"}'
    );
    INSERT INTO holding_snapshots VALUES ('old-snapshot', 'etf-1', '2026-07-01', '2026-07-02');
    INSERT INTO holdings VALUES ('old-snapshot', 'old-security', 100);
  `);
}

test("reports historical label reuse separately without modifying identities or positions", () => {
  const sqlite = fixture({ valid: true });
  try {
    addHistoricalListing(sqlite);
    const before = sqlite.serialize();
    const audit = auditDatabase(sqlite, "fixture");
    assert.equal(audit.identity.duplicateListings, 0);
    assert.deepEqual(audit.identity.historicalListingCollisions, [{
      ticker: "GOOD", name: "GOOD COMPANY", country: "TAIWAN",
      currentIds: ["security-1"], historicalIds: ["old-security"],
    }]);
    assert.equal(audit.etfs[0].holdings, 1);
    assert.deepEqual(sqlite.serialize(), before);
  } finally {
    sqlite.close();
  }
});

for (const [reference, insert] of [
  ["current snapshot", "INSERT INTO holdings VALUES ('snapshot-1', 'old-security', 1)"],
  ["another ETF's latest snapshot", `
    INSERT INTO etfs VALUES ('etf-2', 'OTHER', 1, NULL);
    INSERT INTO holding_snapshots VALUES ('other-snapshot', 'etf-2', '2026-07-01', '2026-07-02');
    INSERT INTO holdings VALUES ('other-snapshot', 'old-security', 100);
  `],
  ["saved portfolio", "INSERT INTO portfolio_items VALUES ('security', 'old-security')"],
  ["saved ETF definition", `UPDATE etfs SET metadata_json = '{"componentSecurityIds":{"GOOD":"old-security"}}'`],
]) {
  test(`still flags a historical identity referenced by a ${reference}`, () => {
    const sqlite = fixture({ valid: true });
    try {
      addHistoricalListing(sqlite);
      sqlite.exec(insert);
      const audit = auditDatabase(sqlite, "fixture");
      assert.equal(audit.identity.duplicateListings, 1);
      assert.deepEqual(audit.identity.historicalListingCollisions, []);
    } finally {
      sqlite.close();
    }
  });
}

test("does not dismiss an unreferenced duplicate as historical", () => {
  const sqlite = fixture({ valid: true });
  try {
    sqlite.exec(`INSERT INTO securities VALUES ('duplicate', 'GOOD', 'Good Company', 'Equity', 'Taiwan', NULL)`);
    assert.equal(auditDatabase(sqlite, "fixture").identity.duplicateListings, 1);
  } finally {
    sqlite.close();
  }
});
