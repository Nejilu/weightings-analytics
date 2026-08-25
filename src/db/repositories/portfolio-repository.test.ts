import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureLocalDatabase } from "../bootstrap";
import { closeDatabase } from "../client";
import {
  loadDefaultPortfolio,
  loadPortfolioById,
  replaceDefaultPortfolio,
  saveDefaultPortfolioAsEtf,
} from "./portfolio-repository";

test("persists signed positions and multi-currency cash in saved portfolios", () => {
  const originalPath = process.env.DATABASE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "weightings-analytics-portfolio-cash-"));
  try {
    process.env.DATABASE_PATH = join(directory, "portfolio.sqlite");
    closeDatabase();
    ensureLocalDatabase();

    replaceDefaultPortfolio(
      [
        {
          id: "short-acwi",
          kind: "etf",
          referenceId: "acwi-us",
          ticker: "ACWI",
          name: "iShares MSCI ACWI ETF",
          allocationWeight: -25,
          quantity: -2,
          inputMode: "shares",
          inputAmount: -2,
        },
      ],
      [
        { currency: "USD", amount: 50_000 },
        { currency: "EUR", amount: -10_000 },
      ],
    );

    const stored = loadDefaultPortfolio();
    assert.equal(stored.items[0].quantity, -2);
    assert.deepEqual(stored.cashPositions, [
      { currency: "EUR", amount: -10_000 },
      { currency: "USD", amount: 50_000 },
    ]);

    const savedEtf = saveDefaultPortfolioAsEtf({
      ticker: "SIGN",
      name: "Signed portfolio",
      description: "Signed test portfolio",
    });
    const cloned = loadPortfolioById(savedEtf.portfolioId ?? "");
    assert.equal(cloned?.items[0].quantity, -2);
    assert.deepEqual(cloned?.cashPositions, stored.cashPositions);
  } finally {
    closeDatabase();
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
