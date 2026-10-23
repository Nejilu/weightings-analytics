import "dotenv/config";

import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { databasePath } from "../src/db/client";

// One current, verified backup. Never migrate or modify the source to back it up.
const source = new BetterSqlite3(databasePath(), { readonly: true, fileMustExist: true });
const directory = join(dirname(databasePath()), "backups");
mkdirSync(directory, { recursive: true });
const destination = join(directory, "latest.sqlite");
const temporary = join(directory, `.latest-${process.pid}-${Date.now()}.sqlite`);

try {
  await source.backup(temporary);
  const check = new BetterSqlite3(temporary, { readonly: true, fileMustExist: true });
  try {
    if (check.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("Backup verification failed; the previous backup is retained.");
    }
  } finally {
    check.close();
  }
  renameSync(temporary, destination);
  console.log(`Verified backup saved to ${destination} (retention: one copy).`);
} finally {
  source.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      unlinkSync(temporary + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
