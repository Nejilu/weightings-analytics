import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { filterCreatorHoldings } from "@/domain/etf-creator";
import { analyzePortfolio } from "@/domain/processors/analyze-portfolio";
import { compareHoldings } from "@/domain/processors/compare-holdings";

import { ensureLocalDatabase } from "../bootstrap";
import { closeDatabase, getSqlite } from "../client";
import { findEtfById } from "./catalog-repository";
import {
  loadSnapshot,
  persistSnapshot,
} from "./holdings-repository";

test("reconciles source fallback IDs into one canonical security across every consumer", () => {
  const originalPath = process.env.DATABASE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "index-lens-identities-"));
  try {
    process.env.DATABASE_PATH = join(directory, "identity.sqlite");
    closeDatabase();
    ensureLocalDatabase();
    const acwi = findEtfById("acwi-us");
    const ivv = findEtfById("ivv-us");
    assert.ok(acwi);
    assert.ok(ivv);

    const legacyId = "NAME:APPLEINC:AAPL";
    const canonicalId = "US0378331005";
    const legacySnapshot = persistSnapshot({
      etf: acwi,
      asOf: "2026-07-31",
      fetchedAt: "2026-08-01T00:00:00.000Z",
      sourceUrl: "https://example.test/acwi.csv",
      sourceHash: "identity-test-acwi",
      holdings: [{
        securityId: legacyId,
        ticker: "AAPL",
        name: "APPLE CORP",
        sector: "Information Technology",
        assetClass: "Equity",
        country: "United States",
        weight: 50,
        marketValue: 500,
        currency: "USD",
        exchange: "NASDAQ",
      }],
    });

    const sqlite = getSqlite();
    sqlite.prepare(`
      INSERT INTO security_provider_symbols (
        provider, security_id, provider_symbol, status, confidence,
        last_verified_at, metadata_json
      ) VALUES ('tradingview', ?, 'NASDAQ:AAPL', 'resolved', 1,
        '2026-08-01T00:00:00.000Z', '{}')
    `).run(legacyId);
    sqlite.prepare(`
      INSERT INTO metric_definitions (
        id, key, name, entity_type, value_type
      ) VALUES ('identity-test-metric', 'identity_test', 'Identity test',
        'security', 'number')
    `).run();
    sqlite.prepare(`
      INSERT INTO metric_observations (
        id, metric_definition_id, entity_type, entity_id, as_of,
        value_number, captured_at
      ) VALUES ('identity-test-observation', 'identity-test-metric',
        'security', ?, '2026-08-01', 1, '2026-08-01T00:00:00.000Z')
    `).run(legacyId);
    sqlite.prepare(`
      INSERT INTO market_prices (
        id, asset_type, asset_id, provider_symbol, price, currency,
        fx_to_usd, price_usd, as_of, fetched_at, source
      ) VALUES ('identity-test-price', 'security', ?, 'AAPL', 200, 'USD',
        1, 200, '2026-08-01', '2026-08-01T00:00:00.000Z', 'test')
    `).run(legacyId);
    sqlite.prepare(`
      INSERT INTO portfolios (id, name, base_currency)
      VALUES ('default-portfolio', 'Portfolio', 'USD')
    `).run();
    sqlite.prepare(`
      INSERT INTO portfolio_items (
        id, portfolio_id, asset_type, security_id, allocation_weight
      ) VALUES ('identity-test-position', 'default-portfolio', 'security', ?, 100)
    `).run(legacyId);

    const canonicalSnapshot = persistSnapshot({
      etf: ivv,
      asOf: "2026-07-31",
      fetchedAt: "2026-08-01T01:00:00.000Z",
      sourceUrl: "https://example.test/ivv.json",
      sourceHash: "identity-test-ivv",
      holdings: [{
        securityId: canonicalId,
        ticker: "AAPL",
        name: "APPLE",
        sector: "Information Technology",
        assetClass: "Equity",
        country: "United States",
        isin: canonicalId,
        cusip: "037833100",
        sedol: "2046251",
        weight: 60,
        marketValue: 600,
        currency: "USD",
        exchange: "NASDAQ",
      }],
    });

    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM securities WHERE primary_ticker = 'AAPL'")
        .get() as { count: number }).count,
      1,
    );
    for (const table of ["holdings", "security_provider_symbols", "portfolio_items"]) {
      assert.equal(
        (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE security_id = ?`)
          .get(legacyId) as { count: number }).count,
        0,
      );
    }
    assert.equal(
      (sqlite.prepare(`SELECT entity_id AS id FROM metric_observations
        WHERE id = 'identity-test-observation'`).get() as { id: string }).id,
      canonicalId,
    );
    assert.equal(
      (sqlite.prepare(`SELECT asset_id AS id FROM market_prices
        WHERE id = 'identity-test-price'`).get() as { id: string }).id,
      canonicalId,
    );

    const legacyReloaded = loadSnapshot(acwi, legacySnapshot, "cached", 24);
    const canonicalReloaded = loadSnapshot(ivv, canonicalSnapshot, "cached", 24);
    assert.equal(legacyReloaded.holdings[0]?.securityId, canonicalId);
    assert.equal(legacyReloaded.holdings[0]?.isin, canonicalId);
    assert.equal(canonicalReloaded.holdings[0]?.cusip, "037833100");
    const comparison = compareHoldings(legacyReloaded, canonicalReloaded);
    assert.equal(comparison.sharedPositionsCount, 1);
    assert.equal(comparison.positions[0]?.securityId, canonicalId);

    const creatorOverlap = filterCreatorHoldings(
      legacyReloaded.holdings,
      {
        countryMode: "include",
        countries: [],
        sectorMode: "include",
        sectors: [],
        overlapMode: "include",
        overlapEtfId: ivv.id,
      },
      new Set(canonicalReloaded.holdings.map((holding) => holding.securityId)),
    );
    assert.deepEqual(creatorOverlap.map((holding) => holding.securityId), [canonicalId]);

    const portfolio = analyzePortfolio({
      items: [
        {
          id: "identity-etf-position",
          kind: "etf",
          referenceId: acwi.id,
          ticker: acwi.ticker,
          name: acwi.name,
          allocationWeight: 50,
        },
        {
          id: "identity-direct-position",
          kind: "security",
          referenceId: canonicalId,
          ticker: "AAPL",
          name: "APPLE INC",
          allocationWeight: 20,
        },
      ],
      etfSnapshots: new Map([[acwi.id, legacyReloaded]]),
      directSecurities: new Map([[canonicalId, {
        securityId: canonicalId,
        ticker: "AAPL",
        name: "APPLE INC",
        sector: "Information Technology",
        assetClass: "Equity",
        country: "United States",
        isin: canonicalId,
      }]]),
      calculatedAt: "2026-08-01T02:00:00.000Z",
    });
    assert.equal(portfolio.positions.filter((position) => position.securityId === canonicalId).length, 1);
    assert.equal(portfolio.positions[0]?.contributions.length, 2);
  } finally {
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconciles tickerless mutual-fund names regardless of snapshot load order", () => {
  const originalPath = process.env.DATABASE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "index-lens-name-identities-"));
  try {
    process.env.DATABASE_PATH = join(directory, "identity.sqlite");
    closeDatabase();
    ensureLocalDatabase();
    const bgsix = findEtfById("bgsix-us");
    const acwi = findEtfById("acwi-us");
    const ivv = findEtfById("ivv-us");
    assert.ok(bgsix);
    assert.ok(acwi);
    assert.ok(ivv);

    persistSnapshot({
      etf: ivv,
      asOf: "2026-07-31",
      fetchedAt: "2026-08-01T00:00:00.000Z",
      sourceUrl: "https://example.test/ivv.json",
      sourceHash: "name-identity-test-ivv",
      holdings: [{
        securityId: "US5949181045",
        ticker: "MSFT",
        name: "MICROSOFT",
        sector: "Information Technology",
        assetClass: "Equity",
        country: "United States",
        isin: "US5949181045",
        weight: 100,
      }],
    });

    const mutualFundSnapshot = persistSnapshot({
      etf: bgsix,
      asOf: "2026-06-30",
      fetchedAt: "2026-08-01T01:00:00.000Z",
      sourceUrl: "https://example.test/bgsix.csv",
      sourceHash: "name-identity-test-bgsix",
      holdings: [
        {
          securityId: "NAME:APPLEINC",
          ticker: "—",
          name: "APPLE INC",
          sector: "Unclassified",
          assetClass: "Unclassified",
          country: "Not reported",
          weight: 50,
        },
        {
          securityId: "NAME:MICROSOFTCORP",
          ticker: "—",
          name: "MICROSOFT CORP",
          sector: "Unclassified",
          assetClass: "Unclassified",
          country: "Not reported",
          weight: 50,
        },
      ],
    });

    persistSnapshot({
      etf: acwi,
      asOf: "2026-07-31",
      fetchedAt: "2026-08-01T02:00:00.000Z",
      sourceUrl: "https://example.test/acwi.json",
      sourceHash: "name-identity-test-acwi",
      holdings: [{
        securityId: "US0378331005",
        ticker: "AAPL",
        name: "APPLE",
        sector: "Information Technology",
        assetClass: "Equity",
        country: "United States",
        isin: "US0378331005",
        weight: 100,
      }],
    });

    const sqlite = getSqlite();
    sqlite.prepare(`
      INSERT INTO security_provider_symbols (
        provider, security_id, provider_symbol, status, confidence,
        last_verified_at, metadata_json
      ) VALUES
        ('tradingview', 'US0378331005', 'NASDAQ:AAPL', 'resolved', 1,
          '2026-08-01T03:00:00.000Z', '{}'),
        ('tradingview', 'US5949181045', 'NASDAQ:MSFT', 'resolved', 1,
          '2026-08-01T03:00:00.000Z', '{}')
    `).run();

    const reloaded = loadSnapshot(bgsix, mutualFundSnapshot, "cached", 24);
    assert.deepEqual(
      reloaded.holdings.map((holding) => [
        holding.securityId,
        holding.ticker,
        holding.name,
        holding.isin,
      ]),
      [
        ["US0378331005", "AAPL", "APPLE", "US0378331005"],
        ["US5949181045", "MSFT", "MICROSOFT", "US5949181045"],
      ],
    );
    assert.equal(
      (sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM holdings h
        JOIN security_provider_symbols p ON p.security_id = h.security_id
        WHERE h.snapshot_id = ? AND p.provider = 'tradingview'
          AND p.status = 'resolved'
      `).get(mutualFundSnapshot.id) as { count: number }).count,
      2,
    );
  } finally {
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
