import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { prepareStandaloneAssets } from "./start-standalone-assets.mjs";

test("copies static and public assets into the standalone layout", () => {
  const root = mkdtempSync(join(tmpdir(), "weightings-analytics-standalone-assets-"));
  try {
    mkdirSync(join(root, ".next", "static"), { recursive: true });
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, ".next", "static", "chunk.css"), "body{}");
    writeFileSync(join(root, "public", "og.png"), "asset");

    assert.deepEqual(prepareStandaloneAssets(root), {
      staticCopied: true,
      publicCopied: true,
    });
    assert.equal(
      readFileSync(join(root, ".next", "standalone", ".next", "static", "chunk.css"), "utf8"),
      "body{}",
    );
    assert.equal(
      readFileSync(join(root, ".next", "standalone", "public", "og.png"), "utf8"),
      "asset",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports missing build assets without creating a false standalone layout", () => {
  const root = mkdtempSync(join(tmpdir(), "weightings-analytics-standalone-assets-empty-"));
  try {
    assert.deepEqual(prepareStandaloneAssets(root), {
      staticCopied: false,
      publicCopied: false,
    });
    assert.equal(existsSync(join(root, ".next", "standalone")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
