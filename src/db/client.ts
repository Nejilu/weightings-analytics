import { mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

interface DatabaseState {
  path: string;
  sqlite: BetterSqlite3.Database;
  db: BetterSQLite3Database<typeof schema>;
}

const globalDatabase = globalThis as typeof globalThis & {
  __weightingsAnalyticsDatabase?: DatabaseState;
};

export function applicationRoot(workingDirectory = process.cwd()): string {
  const current = resolve(workingDirectory);
  return basename(current).toLocaleLowerCase("en-US") === "standalone" &&
    basename(dirname(current)).toLocaleLowerCase("en-US") === ".next"
    ? resolve(current, "..", "..")
    : current;
}

export function databasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  const value = configured || ".data/weightings-analytics.sqlite";
  return isAbsolute(value)
    ? value
    : resolve(/* turbopackIgnore: true */ applicationRoot(), value);
}

function createDatabase(): DatabaseState {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new BetterSqlite3(path);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");

  return {
    path,
    sqlite,
    db: drizzle({ client: sqlite, schema }),
  };
}

export function databaseState(): DatabaseState {
  const path = databasePath();
  const existing = globalDatabase.__weightingsAnalyticsDatabase;
  if (existing && (existing.path !== path || !existing.sqlite.open)) {
    if (existing.sqlite.open) existing.sqlite.close();
    delete globalDatabase.__weightingsAnalyticsDatabase;
  }
  globalDatabase.__weightingsAnalyticsDatabase ??= createDatabase();
  return globalDatabase.__weightingsAnalyticsDatabase;
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  return databaseState().db;
}

export function getSqlite(): BetterSqlite3.Database {
  return databaseState().sqlite;
}

export function isDatabaseOpen(): boolean {
  return Boolean(globalDatabase.__weightingsAnalyticsDatabase?.sqlite.open);
}

export function closeDatabase(): void {
  const state = globalDatabase.__weightingsAnalyticsDatabase;
  if (!state) return;
  state.sqlite.close();
  delete globalDatabase.__weightingsAnalyticsDatabase;
}
