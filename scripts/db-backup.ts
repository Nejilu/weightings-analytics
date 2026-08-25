import "dotenv/config";

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  databasePath,
  getSqlite,
} from "../src/db/client";
import { migrateDatabase } from "../src/db/migrate";

migrateDatabase();

const source = databasePath();
const backupDirectory = join(dirname(source), "backups");
mkdirSync(backupDirectory, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = join(
  backupDirectory,
  `weightings-analytics-${timestamp}.sqlite`,
);

await getSqlite().backup(destination);
console.log(`Backup created at ${destination}`);
