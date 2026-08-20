import type { Holding } from "@/domain/etf";
import {
  normalizeSecurityIdentityPart,
  planSecurityIdentityMerges,
  preferredSecurityId,
  securityCanonicalNameIdentity,
  securityListingIdentity,
  securityTickerCountryIdentity,
  type SecurityIdentityDescriptor,
} from "@/domain/security-identity";

import { getSqlite } from "./client";

type SqliteDatabase = ReturnType<typeof getSqlite>;

interface StoredSecurityRow {
  id: string;
  isin: string | null;
  primaryTicker: string | null;
  name: string;
  assetClass: string | null;
  sector: string | null;
  country: string | null;
  currency: string | null;
  identifiersJson: string | null;
}

interface StoredIdentifiers {
  exchange?: string;
  cusip?: string;
  sedol?: string;
}

function storedIdentifiers(value: string | null): StoredIdentifiers {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    return {
      exchange: typeof record.exchange === "string" ? record.exchange : undefined,
      cusip: typeof record.cusip === "string" ? record.cusip : undefined,
      sedol: typeof record.sedol === "string" ? record.sedol : undefined,
    };
  } catch {
    return {};
  }
}

function identityDescriptor(row: StoredSecurityRow): SecurityIdentityDescriptor {
  const identifiers = storedIdentifiers(row.identifiersJson);
  return {
    securityId: row.id,
    ticker: row.primaryTicker ?? undefined,
    name: row.name,
    country: row.country ?? undefined,
    isin: row.isin ?? undefined,
    cusip: identifiers.cusip,
    sedol: identifiers.sedol,
  };
}

function loadSecurities(sqlite: SqliteDatabase): StoredSecurityRow[] {
  return sqlite.prepare(`
    SELECT id, isin, primary_ticker AS primaryTicker, name,
      asset_class AS assetClass, sector, country, currency,
      identifiers_json AS identifiersJson
    FROM securities
  `).all() as StoredSecurityRow[];
}

function mergeStoredIdentifiers(
  source: StoredIdentifiers,
  target: StoredIdentifiers,
): string | null {
  const merged = {
    ...source,
    ...target,
  };
  return Object.values(merged).some(Boolean) ? JSON.stringify(merged) : null;
}

function mergeSecurity(
  sqlite: SqliteDatabase,
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) return false;
  const selectSecurity = sqlite.prepare(`
    SELECT id, isin, primary_ticker AS primaryTicker, name,
      asset_class AS assetClass, sector, country, currency,
      identifiers_json AS identifiersJson
    FROM securities WHERE id = ?
  `);
  const source = selectSecurity.get(sourceId) as StoredSecurityRow | undefined;
  const target = selectSecurity.get(targetId) as StoredSecurityRow | undefined;
  if (!source || !target) return false;

  sqlite.prepare(`
    UPDATE securities SET
      isin = COALESCE(isin, ?),
      primary_ticker = COALESCE(primary_ticker, ?),
      asset_class = COALESCE(asset_class, ?),
      sector = COALESCE(sector, ?),
      country = COALESCE(country, ?),
      currency = COALESCE(currency, ?),
      identifiers_json = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    source.isin,
    source.primaryTicker,
    source.assetClass,
    source.sector,
    source.country,
    source.currency,
    mergeStoredIdentifiers(
      storedIdentifiers(source.identifiersJson),
      storedIdentifiers(target.identifiersJson),
    ),
    targetId,
  );

  sqlite.prepare(`
    UPDATE holdings AS target SET
      weight = target.weight + COALESCE((
        SELECT source.weight FROM holdings AS source
        WHERE source.snapshot_id = target.snapshot_id AND source.security_id = ?
      ), 0),
      quantity = CASE WHEN target.quantity IS NULL AND (
        SELECT source.quantity FROM holdings AS source
        WHERE source.snapshot_id = target.snapshot_id AND source.security_id = ?
      ) IS NULL THEN NULL ELSE COALESCE(target.quantity, 0) + COALESCE((
        SELECT source.quantity FROM holdings AS source
        WHERE source.snapshot_id = target.snapshot_id AND source.security_id = ?
      ), 0) END,
      market_value = CASE WHEN target.market_value IS NULL AND (
        SELECT source.market_value FROM holdings AS source
        WHERE source.snapshot_id = target.snapshot_id AND source.security_id = ?
      ) IS NULL THEN NULL ELSE COALESCE(target.market_value, 0) + COALESCE((
        SELECT source.market_value FROM holdings AS source
        WHERE source.snapshot_id = target.snapshot_id AND source.security_id = ?
      ), 0) END
    WHERE target.security_id = ? AND EXISTS (
      SELECT 1 FROM holdings AS source
      WHERE source.snapshot_id = target.snapshot_id AND source.security_id = ?
    )
  `).run(sourceId, sourceId, sourceId, sourceId, sourceId, targetId, sourceId);
  sqlite.prepare(`
    DELETE FROM holdings WHERE security_id = ? AND EXISTS (
      SELECT 1 FROM holdings AS target
      WHERE target.snapshot_id = holdings.snapshot_id AND target.security_id = ?
    )
  `).run(sourceId, targetId);
  sqlite.prepare("UPDATE holdings SET security_id = ? WHERE security_id = ?")
    .run(targetId, sourceId);

  sqlite.prepare(`
    DELETE FROM security_provider_symbols AS target
    WHERE target.security_id = ? AND EXISTS (
      SELECT 1 FROM security_provider_symbols AS source
      WHERE source.security_id = ? AND source.provider = target.provider
        AND (
          (source.status = 'resolved' AND target.status <> 'resolved') OR
          source.last_verified_at > target.last_verified_at
        )
    )
  `).run(targetId, sourceId);
  sqlite.prepare(`
    DELETE FROM security_provider_symbols WHERE security_id = ? AND EXISTS (
      SELECT 1 FROM security_provider_symbols AS target
      WHERE target.provider = security_provider_symbols.provider
        AND target.security_id = ?
    )
  `).run(sourceId, targetId);
  sqlite.prepare(`
    UPDATE security_provider_symbols SET security_id = ? WHERE security_id = ?
  `).run(targetId, sourceId);

  sqlite.prepare(`
    UPDATE portfolio_items AS target SET
      allocation_weight = target.allocation_weight + COALESCE((
        SELECT source.allocation_weight FROM portfolio_items AS source
        WHERE source.portfolio_id = target.portfolio_id AND source.security_id = ?
      ), 0),
      quantity = CASE WHEN target.quantity IS NULL AND (
        SELECT source.quantity FROM portfolio_items AS source
        WHERE source.portfolio_id = target.portfolio_id AND source.security_id = ?
      ) IS NULL THEN NULL ELSE COALESCE(target.quantity, 0) + COALESCE((
        SELECT source.quantity FROM portfolio_items AS source
        WHERE source.portfolio_id = target.portfolio_id AND source.security_id = ?
      ), 0) END,
      initial_value_usd = CASE WHEN target.initial_value_usd IS NULL AND (
        SELECT source.initial_value_usd FROM portfolio_items AS source
        WHERE source.portfolio_id = target.portfolio_id AND source.security_id = ?
      ) IS NULL THEN NULL ELSE COALESCE(target.initial_value_usd, 0) + COALESCE((
        SELECT source.initial_value_usd FROM portfolio_items AS source
        WHERE source.portfolio_id = target.portfolio_id AND source.security_id = ?
      ), 0) END,
      input_amount = CASE WHEN target.input_amount IS NULL AND (
        SELECT source.input_amount FROM portfolio_items AS source
        WHERE source.portfolio_id = target.portfolio_id AND source.security_id = ?
      ) IS NULL THEN NULL ELSE COALESCE(target.input_amount, 0) + COALESCE((
        SELECT source.input_amount FROM portfolio_items AS source
        WHERE source.portfolio_id = target.portfolio_id AND source.security_id = ?
      ), 0) END,
      updated_at = CURRENT_TIMESTAMP
    WHERE target.security_id = ? AND EXISTS (
      SELECT 1 FROM portfolio_items AS source
      WHERE source.portfolio_id = target.portfolio_id AND source.security_id = ?
    )
  `).run(
    sourceId,
    sourceId,
    sourceId,
    sourceId,
    sourceId,
    sourceId,
    sourceId,
    targetId,
    sourceId,
  );
  sqlite.prepare(`
    DELETE FROM portfolio_items WHERE security_id = ? AND EXISTS (
      SELECT 1 FROM portfolio_items AS target
      WHERE target.portfolio_id = portfolio_items.portfolio_id
        AND target.security_id = ?
    )
  `).run(sourceId, targetId);
  sqlite.prepare("UPDATE portfolio_items SET security_id = ? WHERE security_id = ?")
    .run(targetId, sourceId);

  sqlite.prepare(`
    DELETE FROM market_prices AS target
    WHERE target.asset_type = 'security' AND target.asset_id = ? AND EXISTS (
      SELECT 1 FROM market_prices AS source
      WHERE source.asset_type = 'security' AND source.asset_id = ?
        AND source.fetched_at > target.fetched_at
    )
  `).run(targetId, sourceId);
  sqlite.prepare(`
    DELETE FROM market_prices WHERE asset_type = 'security' AND asset_id = ?
      AND EXISTS (
        SELECT 1 FROM market_prices AS target
        WHERE target.asset_type = 'security' AND target.asset_id = ?
      )
  `).run(sourceId, targetId);
  sqlite.prepare(`
    UPDATE market_prices SET asset_id = ?
    WHERE asset_type = 'security' AND asset_id = ?
  `).run(targetId, sourceId);

  sqlite.prepare(`
    DELETE FROM metric_observations AS target
    WHERE target.entity_type = 'security' AND target.entity_id = ? AND EXISTS (
      SELECT 1 FROM metric_observations AS source
      WHERE source.entity_type = 'security' AND source.entity_id = ?
        AND source.metric_definition_id = target.metric_definition_id
        AND source.as_of = target.as_of
        AND source.captured_at > target.captured_at
    )
  `).run(targetId, sourceId);
  sqlite.prepare(`
    DELETE FROM metric_observations WHERE entity_type = 'security' AND entity_id = ?
      AND EXISTS (
        SELECT 1 FROM metric_observations AS target
        WHERE target.entity_type = 'security' AND target.entity_id = ?
          AND target.metric_definition_id = metric_observations.metric_definition_id
          AND target.as_of = metric_observations.as_of
      )
  `).run(sourceId, targetId);
  sqlite.prepare(`
    UPDATE metric_observations SET entity_id = ?
    WHERE entity_type = 'security' AND entity_id = ?
  `).run(targetId, sourceId);

  sqlite.prepare("DELETE FROM securities WHERE id = ?").run(sourceId);
  return true;
}

export function reconcilePersistedSecurityIdentities(
  sqlite = getSqlite(),
  useTransaction = true,
): number {
  const merges = planSecurityIdentityMerges(
    loadSecurities(sqlite).map(identityDescriptor),
  );
  const apply = () => merges.reduce(
    (count, merge) =>
      count + (mergeSecurity(sqlite, merge.sourceId, merge.targetId) ? 1 : 0),
    0,
  );
  return useTransaction ? sqlite.transaction(apply)() : apply();
}

export function canonicalizeHoldingsWithPersistedIdentities(
  input: Holding[],
  sqlite = getSqlite(),
): Holding[] {
  const rows = loadSecurities(sqlite);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byListing = new Map<string, StoredSecurityRow[]>();
  const byTickerCountry = new Map<string, StoredSecurityRow[]>();
  const byCanonicalName = new Map<string, StoredSecurityRow[]>();
  for (const row of rows) {
    const descriptor = identityDescriptor(row);
    const listingKey = securityListingIdentity(descriptor);
    if (listingKey) {
      const group = byListing.get(listingKey) ?? [];
      group.push(row);
      byListing.set(listingKey, group);
    }
    const tickerCountryKey = securityTickerCountryIdentity(descriptor);
    if (tickerCountryKey) {
      const group = byTickerCountry.get(tickerCountryKey) ?? [];
      group.push(row);
      byTickerCountry.set(tickerCountryKey, group);
    }
    const hasDurableIdentity = Boolean(
      normalizeSecurityIdentityPart(descriptor.isin) ||
      normalizeSecurityIdentityPart(descriptor.sedol) ||
      normalizeSecurityIdentityPart(descriptor.cusip),
    );
    const canonicalNameKey = securityCanonicalNameIdentity(descriptor.name);
    if (hasDurableIdentity && canonicalNameKey) {
      const group = byCanonicalName.get(canonicalNameKey) ?? [];
      group.push(row);
      byCanonicalName.set(canonicalNameKey, group);
    }
  }

  const merged = new Map<string, Holding>();
  for (const holding of input) {
    const preferredId = preferredSecurityId(holding);
    const listingKey = securityListingIdentity(holding);
    const listingCandidates = listingKey ? byListing.get(listingKey) ?? [] : [];
    const tickerCountryKey = securityTickerCountryIdentity(holding);
    const tickerCountryCandidates = tickerCountryKey
      ? byTickerCountry.get(tickerCountryKey) ?? []
      : [];
    const canResolveByName =
      holding.securityId.startsWith("NAME:") &&
      !normalizeSecurityIdentityPart(holding.ticker) &&
      !normalizeSecurityIdentityPart(holding.isin) &&
      !normalizeSecurityIdentityPart(holding.sedol) &&
      !normalizeSecurityIdentityPart(holding.cusip);
    const canonicalNameKey = securityCanonicalNameIdentity(holding.name);
    const canonicalNameCandidates = canResolveByName && canonicalNameKey
      ? byCanonicalName.get(canonicalNameKey) ?? []
      : [];
    const stored = byId.get(preferredId) ??
      byId.get(holding.securityId) ??
      (listingCandidates.length === 1 ? listingCandidates[0] : undefined) ??
      (tickerCountryCandidates.length === 1
        ? tickerCountryCandidates[0]
        : undefined) ??
      (canonicalNameCandidates.length === 1
        ? canonicalNameCandidates[0]
        : undefined);
    const identifiers = storedIdentifiers(stored?.identifiersJson ?? null);
    const canonical: Holding = {
      ...holding,
      securityId: stored?.id ?? preferredId,
      isin: holding.isin ?? stored?.isin ?? undefined,
      cusip: holding.cusip ?? identifiers.cusip,
      sedol: holding.sedol ?? identifiers.sedol,
      exchange: holding.exchange ?? identifiers.exchange,
    };
    const existing = merged.get(canonical.securityId);
    if (!existing) {
      merged.set(canonical.securityId, canonical);
      continue;
    }
    existing.weight += canonical.weight;
    if (canonical.marketValue !== undefined) {
      existing.marketValue = (existing.marketValue ?? 0) + canonical.marketValue;
    }
  }
  return [...merged.values()];
}
