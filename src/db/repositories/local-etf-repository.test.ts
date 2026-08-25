import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureLocalDatabase } from "../bootstrap";
import { closeDatabase, getSqlite } from "../client";
import {
  deleteLocalEtfRecord,
  migrateCustomEtfDefinitions,
  replaceCustomEtfRecord,
  replacePortfolioEtfRecord,
} from "./local-etf-repository";

test("updates and fully deletes custom and portfolio ETFs", () => {
  const originalPath = process.env.DATABASE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "weightings-analytics-local-etfs-"));
  try {
    process.env.DATABASE_PATH = join(directory, "local-etfs.sqlite");
    closeDatabase();
    ensureLocalDatabase();
    const sqlite = getSqlite();

    sqlite.exec(`
      INSERT INTO benchmarks (id, name, provider)
      VALUES ('test-custom', 'Test custom', 'Weightings Analytics');
      INSERT INTO benchmarks (id, name, provider)
      VALUES ('test-portfolio', 'Test portfolio', 'Weightings Analytics');
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
        'Weightings Analytics', 'test-custom', 'SYNTHETIC', 'Local workspace',
        'Weightings Analytics', 'USD', 'Look-through', '/custom', 'local://custom',
        'custom', NULL
      );
      INSERT INTO etfs (
        id, ticker, isin, name, issuer, benchmark_id, wrapper, domicile,
        exchange, trading_currency, distribution_policy, product_url,
        holdings_url, fund_type, portfolio_id
      ) VALUES (
        'portfolio-etf-test', 'PORT', 'LOCAL-PORT', 'Old portfolio name',
        'Weightings Analytics', 'test-portfolio', 'SYNTHETIC', 'Local workspace',
        'Weightings Analytics', 'USD', 'Look-through', '/portfolio', 'local://portfolio',
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

    sqlite.prepare("UPDATE etfs SET metadata_json = ? WHERE id = ?").run(
      JSON.stringify({
        compositionModel: "frozen-source-free-float",
        sourceEtfId: "ivv-us",
        sourceTicker: "IVV",
        selectedCount: 1,
        criteria: {
          countryMode: "include",
          countries: [],
          sectorMode: "include",
          sectors: [],
          overlapMode: "none",
        },
        editableDescription: "Legacy note",
        frozenAt: "2026-08-10T00:00:00Z",
      }),
      "custom-etf-test",
    );
    assert.equal(migrateCustomEtfDefinitions(), 1);
    const migratedMetadata = JSON.parse(
      (sqlite.prepare("SELECT metadata_json AS metadataJson FROM etfs WHERE id = ?")
        .get("custom-etf-test") as { metadataJson: string }).metadataJson,
    ) as {
      compositionModel: string;
      recalculation: string;
      selectedSecurities: Array<{ securityId: string }>;
      frozenAt?: string;
    };
    assert.equal(migratedMetadata.compositionModel, "dynamic-source-free-float");
    assert.equal(migratedMetadata.recalculation, "on-read");
    assert.equal(migratedMetadata.frozenAt, undefined);
    assert.deepEqual(
      migratedMetadata.selectedSecurities.map((security) => security.securityId),
      ["LOCAL-SECURITY"],
    );

    sqlite.exec(`
      INSERT INTO holding_snapshots (
        id, etf_id, as_of, fetched_at, source_url, source_hash, source_status,
        total_weight, row_count
      ) VALUES (
        'dynamic-custom-snapshot-test', 'custom-etf-test', '2026-08-11',
        '2026-08-11T00:00:00Z', 'local://source', 'dynamic-hash', 'live', 100, 1
      );
      INSERT INTO holdings (snapshot_id, security_id, weight)
      VALUES ('dynamic-custom-snapshot-test', 'LOCAL-SECURITY', 100);
    `);
    assert.equal(migrateCustomEtfDefinitions(), 0);
    assert.equal(
      (sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM holding_snapshots WHERE etf_id = ? AND source_hash LIKE 'frozen:%'",
        )
        .get("custom-etf-test") as { count: number }).count,
      0,
    );
    assert.equal(
      (sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM holding_snapshots WHERE etf_id = ? AND source_hash = 'dynamic-hash'",
        )
        .get("custom-etf-test") as { count: number }).count,
      1,
    );

    const rebuiltCustom = replaceCustomEtfRecord({
      id: "custom-etf-test",
      ticker: "NEWC",
      name: "Rebuilt custom ETF",
      description: "Rebuilt custom definition",
      editableDescription: "My custom note",
      sourceEtfId: "ivv-us",
      sourceTicker: "IVV",
      sourceAsOf: "2026-08-11",
      sourceFetchedAt: "2026-08-11T00:00:00Z",
      sourceUrl: "local://source",
      criteria: {
        countryMode: "include",
        countries: [],
        sectorMode: "include",
        sectors: [],
        overlapMode: "none",
      },
      selectedSecurities: [{
        securityId: "LOCAL-SECURITY",
        ticker: "LOCAL",
      }],
      selectedHoldings: [{
        securityId: "LOCAL-SECURITY",
        ticker: "LOCAL",
        name: "Local security",
        sector: "Technology",
        assetClass: "Equity",
        country: "United States",
        currency: "USD",
        weight: 100,
      }],
    });
    assert.equal(rebuiltCustom?.ticker, "NEWC");
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS count FROM holding_snapshots WHERE etf_id = ?")
        .get("custom-etf-test") as { count: number }).count,
      1,
    );
    assert.equal(
      (sqlite.prepare("SELECT as_of AS asOf FROM holding_snapshots WHERE etf_id = ?")
        .get("custom-etf-test") as { asOf: string }).asOf,
      "2026-08-11",
    );
    const customMetadata = JSON.parse(
      (sqlite.prepare("SELECT metadata_json AS metadataJson FROM etfs WHERE id = ?")
        .get("custom-etf-test") as { metadataJson: string }).metadataJson,
    ) as {
      compositionModel: string;
      recalculation: string;
      selectedSecurities: Array<{ securityId: string }>;
    };
    assert.equal(customMetadata.compositionModel, "dynamic-source-free-float");
    assert.equal(customMetadata.recalculation, "on-read");
    assert.deepEqual(
      customMetadata.selectedSecurities.map((security) => security.securityId),
      ["LOCAL-SECURITY"],
    );

    const rebuiltPortfolio = replacePortfolioEtfRecord({
      id: "portfolio-etf-test",
      portfolioId: "saved-portfolio-test",
      ticker: "NEWP",
      name: "Rebuilt portfolio ETF",
      description: "Rebuilt portfolio definition",
      editableDescription: "My portfolio note",
      items: [{
        id: "replacement-item",
        kind: "security",
        referenceId: "LOCAL-SECURITY",
        ticker: "LOCAL",
        name: "Local security",
        allocationWeight: 80,
        quantity: 5,
        inputMode: "shares",
        inputAmount: 5,
        initialPriceUsd: 20,
        initialValueUsd: 100,
        priceSymbol: "LOCAL",
        priceCurrency: "USD",
      }],
      cashPositions: [{ currency: "EUR", amount: 25 }],
    });
    assert.equal(rebuiltPortfolio?.name, "Rebuilt portfolio ETF");
    assert.equal(
      (sqlite.prepare("SELECT quantity FROM portfolio_items WHERE portfolio_id = ?")
        .get("saved-portfolio-test") as { quantity: number }).quantity,
      5,
    );
    assert.equal(
      (sqlite.prepare("SELECT amount FROM portfolio_cash_positions WHERE portfolio_id = ? AND currency = 'EUR'")
        .get("saved-portfolio-test") as { amount: number }).amount,
      25,
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
      (sqlite.prepare("SELECT COUNT(*) AS count FROM portfolio_cash_positions WHERE portfolio_id = ?")
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
