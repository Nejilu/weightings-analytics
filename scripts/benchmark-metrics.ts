import { mkdir, mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { getMetricsOverview } from "../src/data/services/metrics-overview-service";
import { closeDatabase, databasePath } from "../src/db/client";

// Run with --conditions=react-server --import tsx. Each sample starts from the
// same SQLite backup; provider refreshes never modify the source database.
const argument = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const references = (argument("etfs") ?? "PF,ACWI").split(",").map((value) => value.trim()).filter(Boolean);
const runs = Number(argument("runs") ?? 2);
if (!references.length || references.length > 10 || !Number.isInteger(runs) || runs < 1 || runs > 10) {
  throw new Error("Use 1–10 ETF references and --runs=1–10.");
}
const output = resolve(argument("out") ?? "reports/metrics-benchmark.json");
const sourcePath = resolve(argument("database") ?? databasePath());
const previousPath = process.env.DATABASE_PATH;
await mkdir(dirname(output), { recursive: true });
const directory = await mkdtemp(join(dirname(output), "metrics-benchmark-"));
const source = new Database(sourcePath, { readonly: true });
const baseline = join(directory, "baseline.sqlite");
await source.backup(baseline);
source.close();
const results = [];
try {
  for (let round = 1; round <= runs; round++) {
    for (const reference of round % 2 ? references : [...references].reverse()) {
      const target = join(directory, `sample-${results.length}.sqlite`);
      const copy = new Database(baseline, { readonly: true });
      await copy.backup(target);
      copy.close();
      closeDatabase();
      process.env.DATABASE_PATH = target;
      const started = performance.now();
      try {
        const data = await getMetricsOverview([reference]);
        const row = { round, reference, ms: performance.now() - started,
          sourceStatus: data.sourceStatus, warnings: data.sourceWarnings,
          fundamentalsCaptureWindow: data.fundamentalsCaptureWindow,
          estimatesCaptureWindow: data.estimatesCaptureWindow,
          funds: data.etfs.map((fund) => ({ ticker: fund.ticker, holdings: fund.holdingsCount,
            mapped: fund.mappedHoldings, mappingCoverageWeight: fund.mappingCoverageWeight,
            metrics: fund.metrics.map((metric) => ({ key: metric.key, coveredHoldings: metric.coveredHoldings,
              coverageWeight: metric.coverageWeight })) })) };
        results.push(row);
        console.log(JSON.stringify({ ...row, funds: row.funds.map((fund) => ({
          ticker: fund.ticker, holdings: fund.holdings, mapped: fund.mapped,
          mappingCoverageWeight: fund.mappingCoverageWeight,
        })) }));
      } catch (error) {
        const row = { round, reference, ms: performance.now() - started,
          error: error instanceof Error ? error.message : String(error) };
        results.push(row); console.log(JSON.stringify(row)); process.exitCode = 1;
      } finally {
        closeDatabase();
      }
      await writeFile(output, JSON.stringify({ sourcePath, measuredAt: new Date().toISOString(), results }, null, 2));
    }
  }
} finally {
  closeDatabase();
  if (previousPath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousPath;
  if (!resolve(directory).startsWith(resolve(dirname(output)) + sep)) throw new Error("Unsafe benchmark cleanup path");
  // Only remove the exact database filenames created by this invocation.
  for (const name of ["baseline.sqlite", ...results.map((_, index) => `sample-${index}.sqlite`)]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(join(directory, name + suffix)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  await rmdir(directory);
}
