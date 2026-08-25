import "dotenv/config";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import Database from "better-sqlite3";

const SOURCE_METRIC_DEFINITION_IDS = [
  "security:price_to_book:v1",
  "security:price_to_sales:v1",
  "security:dividend_yield:v1",
  "security:return_on_equity:v1",
  "security:debt_to_equity:v1",
  "security:beta_1y:v1",
];
const ESTIMATE_SERIES_DEFINITION_ID = "security:eps_estimate_series:v1";

function configuredDatabasePath(value = process.env.DATABASE_PATH) {
  const configured = value?.trim() || ".data/weightings-analytics.sqlite";
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

function parseMetadata(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function exchangeFromIdentifiers(value) {
  const identifiers = parseMetadata(value);
  return typeof identifiers?.exchange === "string" && identifiers.exchange.trim()
    ? identifiers.exchange.trim()
    : "(unknown)";
}

function newerSnapshot(candidate, current) {
  if (!current) return true;
  return `${candidate.as_of}|${candidate.fetched_at}|${candidate.id}` >
    `${current.as_of}|${current.fetched_at}|${current.id}`;
}

function newestRow(candidate, current) {
  if (!current) return true;
  return candidate.captured_at > current.captured_at || (
    candidate.captured_at === current.captured_at && candidate.id > current.id
  );
}

function currentSnapshots(sqlite) {
  const latest = new Map();
  const rows = sqlite.prepare(`
    SELECT id, etf_id, as_of, fetched_at
    FROM holding_snapshots
  `).all();
  for (const row of rows) {
    if (newerSnapshot(row, latest.get(row.etf_id))) latest.set(row.etf_id, row);
  }
  return latest;
}

function loadCurrentEquityHoldings(sqlite, snapshots) {
  const ids = [...snapshots.values()].map((snapshot) => snapshot.id);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return sqlite.prepare(`
    SELECT hs.etf_id, hs.as_of, hs.fetched_at, h.security_id, h.weight,
           e.id AS etf_reference, e.ticker, s.asset_class, s.country,
           s.identifiers_json
    FROM holding_snapshots hs
    JOIN holdings h ON h.snapshot_id = hs.id
    JOIN securities s ON s.id = h.security_id
    JOIN etfs e ON e.id = hs.etf_id
    WHERE hs.id IN (${placeholders})
      AND h.weight > 0
      AND lower(coalesce(s.asset_class, '')) LIKE '%equity%'
  `).all(...ids);
}

function loadMappings(sqlite) {
  const output = new Map();
  const rows = sqlite.prepare(`
    SELECT security_id, provider_symbol, status, metadata_json,
           last_verified_at
    FROM security_provider_symbols
    WHERE provider = 'tradingview'
  `).all();
  let malformedMetadata = 0;
  let resolvedWithoutProvenance = 0;
  const provenanceCounts = new Map();
  for (const row of rows) {
    const metadata = parseMetadata(row.metadata_json);
    if (row.metadata_json && !metadata) malformedMetadata += 1;
    const resolved = row.status === "resolved" &&
      typeof row.provider_symbol === "string" && row.provider_symbol.trim().length > 0;
    const provenance = resolved && typeof metadata?.mappingProvenance === "string"
      ? metadata.mappingProvenance
      : null;
    if (resolved && !provenance) resolvedWithoutProvenance += 1;
    if (provenance) provenanceCounts.set(provenance, (provenanceCounts.get(provenance) ?? 0) + 1);
    output.set(row.security_id, {
      providerSymbol: resolved ? row.provider_symbol.trim() : null,
      status: row.status,
      provenance,
      lastVerifiedAt: row.last_verified_at,
    });
  }
  return {
    bySecurity: output,
    malformedMetadata,
    resolvedWithoutProvenance,
    provenanceCounts,
  };
}

function latestMetricRows(sqlite, definitionIds) {
  const placeholders = definitionIds.map(() => "?").join(",");
  const latest = new Map();
  const rows = sqlite.prepare(`
    SELECT id, metric_definition_id, entity_id, value_text, value_json, captured_at
    FROM metric_observations
    WHERE entity_type = 'security'
      AND metric_definition_id IN (${placeholders})
  `).all(...definitionIds);
  for (const row of rows) {
    const key = `${row.metric_definition_id}|${row.entity_id}`;
    if (newestRow(row, latest.get(key))) latest.set(key, row);
  }
  return [...latest.values()];
}

function countIdentityMismatches(sqlite, mappings) {
  const sourceRows = latestMetricRows(sqlite, SOURCE_METRIC_DEFINITION_IDS);
  const sourceMismatches = sourceRows.filter((row) => {
    const mapping = mappings.get(row.entity_id);
    return mapping?.providerSymbol && row.value_text && row.value_text !== mapping.providerSymbol;
  });
  const estimateRows = latestMetricRows(sqlite, [ESTIMATE_SERIES_DEFINITION_ID]);
  let estimateMismatches = 0;
  for (const row of estimateRows) {
    const mapping = mappings.get(row.entity_id);
    if (!mapping?.providerSymbol || !row.value_text) continue;
    let series;
    try {
      series = typeof row.value_json === "string" ? JSON.parse(row.value_json) : row.value_json;
    } catch {
      continue;
    }
    if (series && typeof series.providerSymbol === "string" &&
      series.providerSymbol !== mapping.providerSymbol) estimateMismatches += 1;
  }
  return {
    sourceMismatches: sourceMismatches.length,
    estimateMismatches,
  };
}

function buildEtfSummaries(holdings, mappings) {
  const summaries = new Map();
  for (const holding of holdings) {
    const key = holding.etf_reference;
    const summary = summaries.get(key) ?? {
      id: key,
      ticker: holding.ticker,
      asOf: holding.as_of,
      fetchedAt: holding.fetched_at,
      holdings: 0,
      mapped: 0,
      totalWeight: 0,
      mappedWeight: 0,
      provenance: {},
      countryExchange: new Map(),
    };
    const mapping = mappings.get(holding.security_id);
    const country = typeof holding.country === "string" && holding.country.trim()
      ? holding.country.trim()
      : "(unknown)";
    const exchange = exchangeFromIdentifiers(holding.identifiers_json);
    const countryExchangeKey = `${country}\u0000${exchange}`;
    const exposure = summary.countryExchange.get(countryExchangeKey) ?? {
      country,
      exchange,
      holdings: 0,
      mapped: 0,
      totalWeight: 0,
      mappedWeight: 0,
      provenance: {},
    };
    exposure.holdings += 1;
    exposure.totalWeight += holding.weight;
    summary.holdings += 1;
    summary.totalWeight += holding.weight;
    if (mapping?.providerSymbol) {
      summary.mapped += 1;
      summary.mappedWeight += holding.weight;
      const provenance = mapping.provenance ?? "missing_provenance";
      summary.provenance[provenance] = (summary.provenance[provenance] ?? 0) + holding.weight;
      exposure.mapped += 1;
      exposure.mappedWeight += holding.weight;
      exposure.provenance[provenance] = (exposure.provenance[provenance] ?? 0) + holding.weight;
    } else {
      summary.provenance.unmapped = (summary.provenance.unmapped ?? 0) + holding.weight;
      exposure.provenance.unmapped = (exposure.provenance.unmapped ?? 0) + holding.weight;
    }
    summary.countryExchange.set(countryExchangeKey, exposure);
    summaries.set(key, summary);
  }
  return [...summaries.values()]
    .map((summary) => ({
      ...summary,
      totalWeight: Number(summary.totalWeight.toFixed(6)),
      mappedWeight: Number(summary.mappedWeight.toFixed(6)),
      mappingCoverageWeight: summary.totalWeight > 0
        ? Number(((summary.mappedWeight / summary.totalWeight) * 100).toFixed(4))
        : 0,
      provenance: Object.fromEntries(Object.entries(summary.provenance)
        .map(([key, value]) => [key, Number(value.toFixed(6))])),
      countryExchange: [...summary.countryExchange.values()]
        .map((exposure) => ({
          ...exposure,
          totalWeight: Number(exposure.totalWeight.toFixed(6)),
          mappedWeight: Number(exposure.mappedWeight.toFixed(6)),
          mappingCoverageWeight: exposure.totalWeight > 0
            ? Number(((exposure.mappedWeight / exposure.totalWeight) * 100).toFixed(4))
            : 0,
          provenance: Object.fromEntries(Object.entries(exposure.provenance)
            .map(([key, value]) => [key, Number(value.toFixed(6))])),
        }))
        .sort((left, right) => right.totalWeight - left.totalWeight ||
          left.country.localeCompare(right.country) ||
          left.exchange.localeCompare(right.exchange)),
    }))
    .sort((left, right) => left.ticker.localeCompare(right.ticker));
}

function canonicalIdentityAudit(sqlite) {
  const duplicateListings = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT UPPER(TRIM(primary_ticker)), UPPER(TRIM(name)),
        UPPER(TRIM(COALESCE(country, '')))
      FROM securities
      WHERE primary_ticker IS NOT NULL AND TRIM(primary_ticker) <> ''
      GROUP BY 1, 2, 3
      HAVING COUNT(*) > 1
    )
  `).get().count;
  const duplicateStrongIdentifiers = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT kind, value FROM (
        SELECT 'SEDOL' AS kind,
          UPPER(TRIM(json_extract(
            CASE WHEN json_valid(identifiers_json) THEN identifiers_json ELSE '{}' END,
            '$.sedol'
          ))) AS value
        FROM securities
        UNION ALL
        SELECT 'CUSIP' AS kind,
          UPPER(TRIM(json_extract(
            CASE WHEN json_valid(identifiers_json) THEN identifiers_json ELSE '{}' END,
            '$.cusip'
          ))) AS value
        FROM securities
      )
      WHERE value IS NOT NULL AND value <> ''
      GROUP BY kind, value
      HAVING COUNT(*) > 1
    )
  `).get().count;
  const orphanQueries = [
    `SELECT COUNT(*) AS count FROM holdings AS item
      LEFT JOIN securities AS security ON security.id = item.security_id
      WHERE security.id IS NULL`,
    `SELECT COUNT(*) AS count FROM security_provider_symbols AS item
      LEFT JOIN securities AS security ON security.id = item.security_id
      WHERE security.id IS NULL`,
    `SELECT COUNT(*) AS count FROM portfolio_items AS item
      LEFT JOIN securities AS security ON security.id = item.security_id
      WHERE item.asset_type = 'security' AND security.id IS NULL`,
    `SELECT COUNT(*) AS count FROM market_prices AS item
      LEFT JOIN securities AS security ON security.id = item.asset_id
      WHERE item.asset_type = 'security' AND security.id IS NULL`,
    `SELECT COUNT(*) AS count FROM metric_observations AS item
      LEFT JOIN securities AS security ON security.id = item.entity_id
      WHERE item.entity_type = 'security' AND security.id IS NULL`,
  ];
  const orphanReferences = orphanQueries.reduce(
    (total, query) => total + sqlite.prepare(query).get().count,
    0,
  );
  return { duplicateListings, duplicateStrongIdentifiers, orphanReferences };
}

export function auditDatabase(sqlite, database) {
  const snapshots = currentSnapshots(sqlite);
  const holdings = loadCurrentEquityHoldings(sqlite, snapshots);
  const mappingAudit = loadMappings(sqlite);
  const identity = {
    ...countIdentityMismatches(sqlite, mappingAudit.bySecurity),
    ...canonicalIdentityAudit(sqlite),
  };
  const resolved = [...mappingAudit.bySecurity.values()]
    .filter((mapping) => mapping.providerSymbol).length;
  const unresolved = [...mappingAudit.bySecurity.values()]
    .filter((mapping) => !mapping.providerSymbol).length;
  return {
    database,
    snapshotCount: snapshots.size,
    resolvedMappings: resolved,
    unresolvedMappings: unresolved,
    malformedMetadata: mappingAudit.malformedMetadata,
    resolvedWithoutProvenance: mappingAudit.resolvedWithoutProvenance,
    provenanceCounts: Object.fromEntries(mappingAudit.provenanceCounts),
    identity,
    etfs: buildEtfSummaries(holdings, mappingAudit.bySecurity),
  };
}

function printAudit(audit, json, breakdown) {
  if (json) {
    console.log(JSON.stringify(audit, null, 2));
    return;
  }
  console.log(`Database: ${audit.database}`);
  console.log(`TradingView mappings: ${audit.resolvedMappings.toLocaleString()} resolved, ${audit.unresolvedMappings.toLocaleString()} unresolved`);
  console.log(`Provenance: ${JSON.stringify(audit.provenanceCounts)}`);
  console.log(`Identity mismatches: source=${audit.identity.sourceMismatches}, estimates=${audit.identity.estimateMismatches}, duplicate listings=${audit.identity.duplicateListings}, duplicate strong identifiers=${audit.identity.duplicateStrongIdentifiers}, orphan references=${audit.identity.orphanReferences}`);
  console.log(`Metadata: malformed=${audit.malformedMetadata}, resolved without provenance=${audit.resolvedWithoutProvenance}`);
  for (const etf of audit.etfs) {
    console.log(`${etf.ticker}: ${etf.mapped}/${etf.holdings} mapped, ${etf.mappingCoverageWeight.toFixed(2)}% weight, provenance=${JSON.stringify(etf.provenance)}`);
    if (breakdown) {
      for (const exposure of etf.countryExchange) {
        console.log(`  ${exposure.country} / ${exposure.exchange}: ${exposure.mapped}/${exposure.holdings} mapped, ${exposure.mappingCoverageWeight.toFixed(2)}% weight`);
      }
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const breakdown = argv.includes("--breakdown");
  const strict = argv.includes("--strict");
  const explicitPathIndex = argv.indexOf("--database");
  const database = configuredDatabasePath(explicitPathIndex >= 0 ? argv[explicitPathIndex + 1] : undefined);
  if (!existsSync(database)) {
    throw new Error(`SQLite database does not exist: ${database}`);
  }
  const sqlite = new Database(database, { readonly: true });
  try {
    const audit = auditDatabase(sqlite, database);
    printAudit(audit, json, breakdown);
    if (strict && (
      audit.malformedMetadata > 0 ||
      audit.resolvedWithoutProvenance > 0 ||
      audit.identity.sourceMismatches > 0 ||
      audit.identity.estimateMismatches > 0 ||
      audit.identity.duplicateListings > 0 ||
      audit.identity.duplicateStrongIdentifiers > 0 ||
      audit.identity.orphanReferences > 0
    )) {
      process.exitCode = 2;
    }
    return audit;
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
