import { ISHARES_HOLDINGS_HASH_PREFIX } from "../providers/ishares-csv";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalDatabase } from "@/db/bootstrap";
import { closeDatabase } from "@/db/client";
import { findEtfById } from "@/db/repositories/catalog-repository";
import { persistSnapshot } from "@/db/repositories/holdings-repository";
import { getHoldingsSnapshot } from "./holdings-service";
import { analyzeHoldings } from "@/domain/processors/analyze-holdings";
import { compareHoldings } from "@/domain/processors/compare-holdings";
import type { EtfCreatorCriteria } from "@/domain/etf-creator";
import type { Holding } from "@/domain/etf";
import { defaultCreatorCriteria, type CreatorSubset } from "@/domain/etf-creator";
import { migrateCustomEtfDefinitions } from "@/db/repositories/local-etf-repository";
import { createEtfFromSource, validatedCreatorCriteria } from "./etf-creator-service";
import { getLocalEtfDetail, updateCustomLocalEtf } from "./local-etf-service";

test("creator criteria default to free-float and reject unknown weighting methods", () => {
  const criteria: EtfCreatorCriteria = {
    countryMode: "include", countries: [], sectorMode: "include", sectors: [], overlapMode: "none",
  };
  assert.equal(validatedCreatorCriteria(criteria).weightingMode, "free-float");
  assert.equal(validatedCreatorCriteria({ ...criteria, weightingMode: "equal" }).weightingMode, "equal");
  for (const weightingMode of ["price", null, 42]) {
    assert.throws(() => validatedCreatorCriteria({ ...criteria, weightingMode } as EtfCreatorCriteria), /Invalid weighting mode/);
  }
});

test("creator rejects malformed multipliers and requires references without an overlap filter", () => {
  const criteria: EtfCreatorCriteria = {
    countryMode: "include", countries: [], sectorMode: "include", sectors: [], overlapMode: "none",
  };
  for (const factor of [-1, 1_001, Infinity, NaN, "2", null]) {
    assert.throws(() => validatedCreatorCriteria({
      ...criteria, weightMultipliers: { sectors: { Technology: factor } },
    } as EtfCreatorCriteria), /Weight multipliers must be numbers/);
  }
  for (const group of [[], null, "invalid"]) {
    assert.throws(() => validatedCreatorCriteria({
      ...criteria, weightMultipliers: { countries: group },
    } as unknown as EtfCreatorCriteria), /Invalid weight multiplier group/);
  }
  assert.throws(() => validatedCreatorCriteria({
    ...criteria, weightMultipliers: { overlap: 2 },
  }), /Select a reference ETF/);
  assert.equal(validatedCreatorCriteria({
    ...criteria, overlapEtfId: "peer", weightMultipliers: { overlap: 2 },
  }).overlapEtfId, "peer");
  assert.equal(validatedCreatorCriteria({
    ...criteria, overlapEtfId: "peer", weightMultipliers: { overlap: 1, nonOverlap: 1 },
  }).overlapEtfId, undefined);
});

test("allocated subsets persist independent rules, merge shared stocks and preserve targets on refresh", async () => {
  const originalPath = process.env.DATABASE_PATH;
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "creator-subsets-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    closeDatabase(); ensureLocalDatabase();
    globalThis.fetch = async () => { throw new Error("This test must use cached source fixtures."); };
    const sourceEtf = findEtfById("qtop-us")!;
    const fixtures = [50, 25, 10, 5, 5, 5].map((weight, index) => ({
      securityId: `SUBSET-TEST-${index}`, ticker: `SUB${index}`, name: `Subset company ${index}`,
      sector: "Technology", assetClass: "Equity", country: index === 0 ? "United States" : "France", weight,
    }));
    const persistSource = (asOf: string, source: typeof fixtures) => persistSnapshot({
      etf: sourceEtf, asOf, fetchedAt: new Date().toISOString(), sourceUrl: sourceEtf.holdingsUrl,
      sourceHash: `${ISHARES_HOLDINGS_HASH_PREFIX}${asOf}`, holdings: source,
    });
    persistSource("2026-10-01", fixtures);
    const source = await getHoldingsSnapshot(sourceEtf.id);
    const securities = ["SUB0", "SUB1", "SUB2"].map((ticker) => {
      const holding = source.holdings.find((holding) => holding.ticker === ticker)!;
      return { securityId: holding.securityId, ticker };
    });
    const reference = await createEtfFromSource({
      ticker: "TSTSUBREF", name: "Subset second source", sourceEtfId: sourceEtf.id,
      selectedSecurityIds: securities.slice(1).map((security) => security.securityId), criteria: defaultCreatorCriteria(),
    });
    const subsets: CreatorSubset[] = [
      { id: "growth", name: "Growth", allocationWeight: 60, sourceEtfId: sourceEtf.id, criteria: { ...defaultCreatorCriteria(), sectors: ["Technology"] }, selectedSecurities: securities.slice(0, 2) },
      { id: "balance", name: "Balance", allocationWeight: 40, sourceEtfId: reference.id, criteria: { ...defaultCreatorCriteria(), weightingMode: "equal" }, selectedSecurities: securities.slice(1) },
    ];
    const draft = { ticker: "TSTSUBSET", name: "Allocated test ETF", description: "Two sleeves", sourceEtfId: sourceEtf.id, selectedSecurityIds: securities.map((security) => security.securityId), criteria: { ...defaultCreatorCriteria(), subsets } };
    assert.throws(() => validatedCreatorCriteria({ ...draft.criteria, subsets: [{ ...subsets[0], allocationWeight: 80 }, subsets[1]] }), /total 100%/);
    assert.throws(() => validatedCreatorCriteria({ ...draft.criteria, subsets: [{ ...subsets[0], criteria: draft.criteria }, subsets[1]] }), /Nested subsets/);
    assert.throws(() => validatedCreatorCriteria({ ...draft.criteria, subsets: [{ ...subsets[0], criteria: undefined as unknown as EtfCreatorCriteria }, subsets[1]] }), /Valid selection rules/);
    const created = await createEtfFromSource(draft);
    assert.match(created.description ?? "", /2 allocated subsets/);
    assert.equal(migrateCustomEtfDefinitions(), 0);
    let detail = await getLocalEtfDetail(created.id);
    if (detail.kind !== "custom") throw new Error("Expected a custom ETF");
    assert.deepEqual(detail.criteria.subsets?.map(({ allocationWeight, sourceEtfId, criteria }) => [allocationWeight, sourceEtfId, criteria.weightingMode]), [[60, sourceEtf.id, "free-float"], [40, reference.id, "equal"]]);
    const weights = (holdings: Holding[]) => Object.fromEntries(holdings.map((holding) => [holding.ticker, Math.round(holding.weight * 1e9) / 1e9]));
    assert.deepEqual(weights(detail.holdings), { SUB0: 40, SUB1: 40, SUB2: 20 });
    persistSource("2026-10-02", fixtures.map((holding, index) => ({ ...holding, weight: index === 0 ? 25 : index === 1 ? 50 : holding.weight })));
    assert.deepEqual(weights((await getHoldingsSnapshot(created.id)).holdings), { SUB1: 60, SUB0: 20, SUB2: 20 });
    const updatedSubsets = [
      { ...subsets[0], allocationWeight: 70, criteria: { ...subsets[0].criteria, weightMultipliers: { countries: { "United States": 2 } } } },
      { ...subsets[1], allocationWeight: 30 },
    ];
    await updateCustomLocalEtf(created.id, { ...draft, kind: "custom", criteria: { ...draft.criteria, subsets: updatedSubsets } });
    detail = await getLocalEtfDetail(created.id);
    if (detail.kind !== "custom") throw new Error("Expected a custom ETF");
    assert.deepEqual(weights(detail.holdings), { SUB1: 50, SUB0: 35, SUB2: 15 });
    assert.equal(detail.criteria.subsets?.[0].criteria.weightMultipliers?.countries?.["United States"], 2);
    assert.equal(migrateCustomEtfDefinitions(), 0);
    await assert.rejects(updateCustomLocalEtf(reference.id, { ...draft, kind: "custom", ticker: reference.ticker, name: reference.name, criteria: { ...defaultCreatorCriteria(), overlapEtfId: created.id, weightMultipliers: { overlap: 2 } } }), /do not depend on this ETF/);
    persistSource("2026-10-03", fixtures.map((holding, index) => index < 2 ? { ...holding, securityId: `SUBSET-REPLACEMENT-${index}`, ticker: `NEWS${index}`, name: `Replacement ${index}` } : holding));
    const unavailable = await getHoldingsSnapshot(created.id);
    assert.equal(unavailable.sourceStatus, "stale");
    assert.deepEqual(weights(unavailable.holdings), { SUB1: 50, SUB0: 35, SUB2: 15 });
    assert.match(unavailable.sourceIssues?.[0].message ?? "", /Growth/);
  } finally {
    globalThis.fetch = originalFetch; closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("custom multipliers persist and follow current source and overlap membership", async () => {
  const originalPath = process.env.DATABASE_PATH;
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "creator-multipliers-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    closeDatabase();
    ensureLocalDatabase();
    globalThis.fetch = async () => { throw new Error("This test must use cached source fixtures."); };
    const sourceEtf = findEtfById("qtop-us")!;
    const fixtures = [50, 25, 10, 5, 5, 5].map((weight, index) => ({
      securityId: `MULTIPLIER-TEST-${index}`, ticker: `MUL${index}`, name: `Multiplier company ${index}`,
      sector: "Technology", assetClass: "Equity", country: "United States", weight,
    }));
    const persistSource = (asOf: string, source: typeof fixtures) => persistSnapshot({
      etf: sourceEtf, asOf, fetchedAt: new Date().toISOString(),
      sourceUrl: sourceEtf.holdingsUrl, sourceHash: `${ISHARES_HOLDINGS_HASH_PREFIX}${asOf}`, holdings: source,
    });
    persistSource("2026-10-01", fixtures);
    const source = await getHoldingsSnapshot(sourceEtf.id);
    const selection = ["MUL0", "MUL1", "MUL2"].map((ticker) => source.holdings.find((holding) => holding.ticker === ticker)!.securityId);
    const baseCriteria: EtfCreatorCriteria = {
      countryMode: "include", countries: [], sectorMode: "include", sectors: [], overlapMode: "none",
    };
    const reference = await createEtfFromSource({
      ticker: "TSTMREF", name: "Multiplier reference", sourceEtfId: sourceEtf.id,
      selectedSecurityIds: [selection[0]], criteria: baseCriteria,
    });
    const criteria: EtfCreatorCriteria = {
      ...baseCriteria, overlapEtfId: reference.id,
      weightMultipliers: {
        countries: { "United States": 0.5 }, sectors: { Technology: 2 },
        securities: { [selection[0]]: 0.5 }, overlap: 3, nonOverlap: 0.5,
      },
    };
    const created = await createEtfFromSource({
      ticker: "TSTMULT", name: "Multiplier ETF", sourceEtfId: sourceEtf.id,
      selectedSecurityIds: selection, criteria,
    });
    assert.match(created.description ?? "", /custom country, sector, overlap and security multipliers/);
    assert.equal(migrateCustomEtfDefinitions(), 0);
    let detail = await getLocalEtfDetail(created.id);
    if (detail.kind !== "custom") throw new Error("Expected a custom ETF");
    assert.deepEqual(detail.criteria.weightMultipliers, criteria.weightMultipliers);
    assert.equal(detail.criteria.overlapMode, "none");
    assert.equal(detail.criteria.overlapEtfId, reference.id);
    const weightOf = (holdings: Holding[], ticker: string) => holdings.find((holding) => holding.ticker === ticker)!.weight;
    assert.ok(Math.abs(weightOf(detail.holdings, "MUL0") - 75 / 92.5 * 100) < 1e-12);

    await updateCustomLocalEtf(reference.id, {
      kind: "custom", ticker: reference.ticker, name: reference.name, description: "",
      sourceEtfId: sourceEtf.id, selectedSecurityIds: [selection[1]], criteria: baseCriteria,
    });
    const refreshed = await getHoldingsSnapshot(created.id);
    assert.ok(Math.abs(weightOf(refreshed.holdings, "MUL0") - 12.5 / 92.5 * 100) < 1e-12);
    assert.ok(Math.abs(weightOf(refreshed.holdings, "MUL1") - 75 / 92.5 * 100) < 1e-12);

    // The country multiplier follows current classification data on the next read.
    persistSource("2026-10-02", fixtures.map((holding, index) => index === 0 ? { ...holding, country: "France" } : holding));
    const updatedSource = await getHoldingsSnapshot(created.id);
    assert.ok(Math.abs(weightOf(updatedSource.holdings, "MUL0") - 25 / 105 * 100) < 1e-12);

    const updateDraft = {
      kind: "custom" as const, ticker: created.ticker, name: created.name, description: "",
      sourceEtfId: sourceEtf.id, selectedSecurityIds: selection, criteria,
    };
    await assert.rejects(updateCustomLocalEtf(created.id, {
      ...updateDraft, criteria: { ...baseCriteria, weightMultipliers: { sectors: { Technology: 0 } } },
    }), /at least one positive weight/);
    await assert.rejects(updateCustomLocalEtf(reference.id, {
      ...updateDraft, ticker: reference.ticker, name: reference.name,
      criteria: { ...baseCriteria, overlapEtfId: created.id, weightMultipliers: { overlap: 2 } },
    }), /do not depend on this ETF/);

    await updateCustomLocalEtf(created.id, {
      ...updateDraft,
      criteria: { ...baseCriteria, weightingMode: "equal", weightMultipliers: { securities: { [selection[0]]: 2 } } },
    });
    detail = await getLocalEtfDetail(created.id);
    if (detail.kind !== "custom") throw new Error("Expected a custom ETF");
    assert.equal(weightOf(detail.holdings, "MUL0"), 50);
    assert.equal(weightOf(detail.holdings, "MUL1"), 25);
    assert.equal(detail.criteria.overlapEtfId, undefined);
    assert.equal(migrateCustomEtfDefinitions(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("equal creator weights survive saving, migration, source changes and editing", async () => {
  const originalPath = process.env.DATABASE_PATH;
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "creator-weighting-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    closeDatabase();
    ensureLocalDatabase();
    globalThis.fetch = async () => { throw new Error("This test must use cached source fixtures."); };
    const sourceEtf = findEtfById("qtop-us")!;
    const sourceHoldings = [50, 25, 10, 5, 5, 5].map((weight, index) => ({
      securityId: `CREATOR-TEST-${index}`, ticker: `CRT${index}`, name: `Creator company ${index}`,
      sector: "Technology", assetClass: "Equity", country: "United States", weight,
    }));
    const persistSource = (asOf: string, source: typeof sourceHoldings) => persistSnapshot({
      etf: sourceEtf, asOf, fetchedAt: new Date().toISOString(),
      sourceUrl: sourceEtf.holdingsUrl, sourceHash: `${ISHARES_HOLDINGS_HASH_PREFIX}${asOf}`, holdings: source,
    });
    persistSource("2026-10-01", sourceHoldings);
    const source = await getHoldingsSnapshot(sourceEtf.id);
    const selection = source.holdings.slice(0, 3).map((holding) => holding.securityId);
    const criteria: EtfCreatorCriteria = {
      weightingMode: "equal", countryMode: "include", countries: [],
      sectorMode: "include", sectors: [], overlapMode: "none",
    };
    const created = await createEtfFromSource({
      ticker: "TSTEQUAL", name: "Test equal ETF", sourceEtfId: sourceEtf.id,
      selectedSecurityIds: selection, criteria,
    });
    assert.match(created.description ?? "", /equally weighted/);
    assert.equal(migrateCustomEtfDefinitions(), 0);
    let detail = await getLocalEtfDetail(created.id);
    assert.equal(detail.kind, "custom");
    if (detail.kind !== "custom") throw new Error("Expected a custom ETF");
    assert.equal(detail.criteria.weightingMode, "equal");
    assert.ok(detail.holdings.every((holding) => Math.abs(holding.weight - 100 / 3) < 1e-12));

    // One selected company leaves the source; equal weights redistribute to the other two.
    persistSource("2026-10-02", [
      { ...sourceHoldings[0], weight: 1 }, { ...sourceHoldings[1], weight: 89 },
      ...sourceHoldings.slice(3),
      { ...sourceHoldings[2], securityId: "CREATOR-NEW", ticker: "CRTNEW", name: "New company" },
    ]);
    const refreshed = await getHoldingsSnapshot(created.id);
    assert.deepEqual(refreshed.holdings.map((holding) => holding.weight), [50, 50]);
    assert.equal(refreshed.constituentCoverage?.missingTickers.length, 1);

    await updateCustomLocalEtf(created.id, {
      kind: "custom", ticker: created.ticker, name: created.name, description: "",
      sourceEtfId: sourceEtf.id, selectedSecurityIds: selection,
      criteria: { ...criteria, weightingMode: "free-float" },
    });
    detail = await getLocalEtfDetail(created.id);
    if (detail.kind !== "custom") throw new Error("Expected a custom ETF");
    assert.equal(detail.criteria.weightingMode, "free-float");
    assert.equal(detail.selectedSecurityIds.length, 3);
    assert.ok(Math.abs(detail.holdings.find((holding) => holding.ticker === "CRT0")!.weight - 100 / 90) < 1e-12);
    assert.equal(migrateCustomEtfDefinitions(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("403 survives stale fallback, aliases, analysis and comparison; relay refresh clears it", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "holdings-refresh-"));
  try {
    process.env.DATABASE_PATH = join(directory, "test.sqlite");
    delete process.env.ISHARES_RELAY_URL;
    ensureLocalDatabase();
    const etf = findEtfById("qtop-us")!;
    persistSnapshot({
      etf, asOf: "2026-09-11", fetchedAt: new Date().toISOString(),
      sourceUrl: etf.holdingsUrl, sourceHash: `${ISHARES_HOLDINGS_HASH_PREFIX}fixture`,
      holdings: Array.from({ length: 6 }, (_, i) => ({
        securityId: `TEST${i}`, ticker: `T${i}`, name: `Company ${i}`,
        sector: "Technology", assetClass: "Equity", country: "United States", weight: 100 / 6,
      })),
    });
    globalThis.fetch = async () => new Response("Access Denied", { status: 403 });
    const stale = await getHoldingsSnapshot("qtop-us", { forceRefresh: true });
    assert.equal(stale.sourceStatus, "stale");
    assert.equal(stale.asOf, "2026-09-11");
    assert.equal(stale.sourceIssues?.[0].code, "HTTP_403");
    const reloaded = await getHoldingsSnapshot("qtop-us");
    assert.equal(reloaded.sourceStatus, "stale");
    assert.equal(reloaded.sourceIssues?.[0].code, "HTTP_403");
    const alias = await getHoldingsSnapshot("qtop-ucits", { forceRefresh: true });
    assert.deepEqual(alias.sourceIssues, stale.sourceIssues);
    const clean = { ...stale, sourceStatus: "live" as const, sourceIssues: [] };
    assert.deepEqual(analyzeHoldings(clean, stale).sourceIssues, stale.sourceIssues);
    assert.deepEqual(compareHoldings(clean, stale).right.sourceIssues, stale.sourceIssues);
    await assert.rejects(getHoldingsSnapshot("ivv-us", { forceRefresh: true }), /HTTP_403/);

    process.env.ISHARES_RELAY_URL = "https://relay.example.test/";
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const relay = new URL(String(input));
      assert.equal(relay.origin, "https://relay.example.test");
      const upstream = new URL(relay.searchParams.get("url")!);
      requested.push(upstream.toString());
      const points = upstream.searchParams.has("asOfDate") ? {
        asOfDate: { value: 20260918 },
        ticker: { value: ["SPCX", "A", "B", "C", "D", "E"] },
        issueName: { value: ["SpaceX", "A", "B", "C", "D", "E"] },
        holdingPercent: { value: [3.71811, 20, 20, 20, 20, 16.28189] },
      } : { dateList: { value: [20260911, 20260918] } };
      return Response.json({ componentsByNameMap: { holdings: { containersByNameMap: {
        all: { dataPointsByNameMap: points },
      } } } });
    };
    const fresh = await getHoldingsSnapshot("qtop-us", { forceRefresh: true });
    assert.equal(fresh.sourceStatus, "live");
    assert.equal(fresh.asOf, "2026-09-18");
    assert.equal(fresh.holdings.find((h) => h.ticker === "SPCX")?.weight, 3.71811);
    assert.equal(fresh.sourceIssues, undefined);
    assert.equal(requested.length, 2);
    assert.match(fresh.sourceUrl, /^https:\/\/www.blackrock.com/);
    const cached = await getHoldingsSnapshot("qtop-us");
    assert.equal(cached.sourceStatus, "cached");
    assert.equal(cached.sourceIssues, undefined);
    assert.equal(requested.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase();
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  }
});
