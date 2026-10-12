import assert from "node:assert/strict";
import test from "node:test";
import type { Holding } from "./etf";
import { assignCapitalizationCompanies, buildCapitalizationObservations, capitalizationCompanyName, validMarketCapitalization, type CapitalizationObservation } from "./capitalization-reference";

const holding = (securityId: string, ticker: string, weight: number): Holding => ({ securityId, ticker, name: ticker, sector: "Tech", assetClass: "Equity", country: "US", weight });
const cap = (securityId: string, value: number): CapitalizationObservation => ({ securityId, ticker: securityId, marketCapUsd: value, providerSymbol: `NASDAQ:${securityId}`, capturedAt: "2026-10-12T10:00:00Z", status: "available" });

test("total capitalization validation rejects invalid scales without excluding normal small companies", () => {
  for (const value of [null, undefined, NaN, Infinity, -1, 0, 101_000_000_000_000]) assert.equal(validMarketCapitalization(value), false);
  for (const value of [1_000_000, 5_000_000_000_000]) assert.equal(validMarketCapitalization(value), true);
});

test("additional share classes merge only when issuer metadata and total cap agree", () => {
  assert.equal(capitalizationCompanyName("Hyundai Motor Company"), capitalizationCompanyName("Hyundai Motor Co Ltd Pfd. Shs 2"));
  assert.equal(capitalizationCompanyName("AXIA Energia SA"), capitalizationCompanyName("AXIA Energia SA Non-Cum Perp Pfd Registered Shs C"));
  assert.equal(capitalizationCompanyName("Chocoladefabriken Lindt & Spruengli AG"), capitalizationCompanyName("Chocoladefabriken Lindt & Spruengli AG Partizipsch."));
  const rows = [{ ...cap("ordinary", 100), companyName: "Samsung Electronics Co., Ltd." },
    { ...cap("preferred", 100), companyName: "Samsung Electronics Co Ltd Pfd Non-Voting" },
    { ...cap("unrelated", 1000), companyName: "Samsung Life" }];
  const assigned = assignCapitalizationCompanies(rows, new Map(rows.map((row) => [row.providerSymbol!, "shared-logo"])));
  assert.equal(assigned[0].companyId, "company:shared-logo:SAMSUNGELECTRONICS:ordinary");
  assert.equal(assigned[1].companyId, assigned[0].companyId);
  assert.equal(assigned[2].companyId, "unrelated");
  const merged = assignCapitalizationCompanies(rows.slice(0, 2), new Map(rows.map((row) => [row.providerSymbol!, "shared-logo"])));
  assert.equal(merged[0].companyId, "company:shared-logo:SAMSUNGELECTRONICS:ordinary");
  assert.equal(merged[1].companyId, "company:shared-logo:SAMSUNGELECTRONICS:ordinary");
  const similarCap = assignCapitalizationCompanies([rows[0], { ...rows[2], marketCapUsd: 100 }], new Map(rows.map((row) => [row.providerSymbol!, "shared-logo"])));
  assert.equal(similarCap[0].companyId, "ordinary");
  assert.equal(similarCap[1].companyId, "unrelated");
});

test("company capitalization is counted once across share classes and uses the largest held listing", () => {
  const target = [holding("a", "GOOGL", 15), holding("c", "GOOG", 10)];
  const source = new Map([['a', cap('a', 100)], ['c', cap('c', 101)]]);
  const rows = buildCapitalizationObservations(target, [holding("c", "GOOG", 30)], source);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].securityId, "economic:alphabet");
  assert.equal(rows[0].marketCapUsd, 100);
  assert.equal(rows[0].providerSymbol, "NASDAQ:a");
  assert.deepEqual(target.map((p) => p.weight), [15, 10]);
});

test("conflicting listing capitalizations are excluded and a valid alternative can replace an unavailable listing", () => {
  const target = [holding("a", "GOOGL", 15), holding("c", "GOOG", 10)];
  assert.equal(buildCapitalizationObservations(target, [], new Map([['a', cap('a', 100)], ['c', cap('c', 1000)]]))[0].status, "conflicting");
  const missing = { ...cap('a', 100), marketCapUsd: null, status: "stale" as const };
  const rows = buildCapitalizationObservations(target, [], new Map([['a', missing], ['c', cap('c', 101)]]));
  assert.equal(rows[0].marketCapUsd, 101);
  assert.equal(rows[0].status, "available");
  assert.equal(buildCapitalizationObservations([holding("unknown", "UNKNOWN", 5)], [], new Map())[0].status, "missing");
});
