// Synthetic browser-test data. Always creates a new temporary database.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalDatabase } from "../src/db/bootstrap";
import { closeDatabase, getDb } from "../src/db/client";
import { findEtfById } from "../src/db/repositories/catalog-repository";
import { persistSnapshot } from "../src/db/repositories/holdings-repository";
import {
  etfs,
  portfolios,
  portfolioItems,
  portfolioCashPositions,
  marketPrices,
} from "../src/db/schema";
import type { Holding } from "../src/domain/etf";

const directory = mkdtempSync(join(tmpdir(), "weightings-site-preview-"));
process.env.DATABASE_PATH = join(directory, "preview.sqlite");
ensureLocalDatabase();
const now = new Date().toISOString();
const holdings: Holding[] = Array.from({ length: 2000 }, (_, i) => ({
  securityId: `DEMO-${i}`,
  ticker: `DEMO${i}`,
  name: `Synthetic test company ${i}`,
  sector: i % 2 ? "Technology" : "Industrials",
  country: "United States",
  assetClass: "Equity",
  currency: "USD",
  exchange: "NASDAQ",
  weight: 0.05,
}));
for (const id of ["acwi-us", "ivv-us"]) {
  persistSnapshot({
    etf: findEtfById(id)!,
    asOf: now.slice(0, 10),
    fetchedAt: now,
    sourceUrl: "https://example.com/synthetic-test-data",
    sourceHash: `ishares-holdings-v3:demo-${id}`,
    holdings:
      id === "acwi-us"
        ? holdings
        : holdings.slice(0, 5).map((h) => ({ ...h, weight: 20 })),
  });
}
for (const visibility of ["private", "weights", "public"] as const) {
  const portfolioId = `demo-portfolio-${visibility}`;
  getDb()
    .insert(portfolios)
    .values({ id: portfolioId, name: `Demo ${visibility}` })
    .run();
  getDb()
    .insert(portfolioItems)
    .values({
      id: `demo-item-${visibility}`,
      portfolioId,
      assetType: "security",
      securityId: "DEMO-0",
      allocationWeight: 75,
      quantity: 123.456,
      inputMode: "shares",
      inputAmount: 123.456,
      initialPriceUsd: 100,
      initialValueUsd: 12345.6,
      priceSymbol: "DEMO0",
      priceCurrency: "USD",
    })
    .run();
  getDb()
    .insert(portfolioCashPositions)
    .values({ portfolioId, currency: "USD", amount: 4321.09 })
    .run();
  getDb()
    .insert(etfs)
    .values({
      ...findEtfById("ivv-us")!,
      id: `demo-${visibility}`,
      ticker: `DEMO${visibility.toUpperCase()}`,
      isin: `DEMO-${visibility}`,
      name: `Demo ${visibility} portfolio`,
      issuer: "Synthetic test data",
      fundType: "portfolio",
      visibility,
      portfolioId,
      description: "123.456 shares; 4321.09 USD cash",
      productUrl: `/portfolio/${portfolioId}`,
      holdingsUrl: `local://portfolio/${portfolioId}`,
      metadataJson: { editableDescription: "Synthetic browser-test portfolio" },
    })
    .run();
}
for (const id of ["DEMO-0", "listing:DEMO-0:DEMO0"]) {
  getDb()
    .insert(marketPrices)
    .values({
      id,
      assetType: "security",
      assetId: id,
      providerSymbol: "DEMO0",
      price: 100,
      currency: "USD",
      fxToUsd: 1,
      priceUsd: 100,
      asOf: now,
      fetchedAt: now,
      source: "synthetic-test",
    })
    .run();
}
closeDatabase();
console.log(process.env.DATABASE_PATH);
