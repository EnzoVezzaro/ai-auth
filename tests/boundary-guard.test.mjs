import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");

// Examples and test fixtures are integration scaffolding, not SDK surface.
const EXCLUDED_DIRS = new Set([
  "example",
  "examples",
  "fixtures",
  "test",
  "testdata",
  "tests",
  "__fixtures__",
  "__tests__",
]);
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".ts"]);
const SITE_PATTERN = /body4ai/iu;

function sdkCodeFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) files.push(...sdkCodeFiles(full));
    } else if (
      entry.isFile() &&
      CODE_EXTENSIONS.has(path.extname(entry.name))
    ) {
      files.push(full);
    }
  }
  return files;
}

test("SDK packages contain no site-specific name or origin", () => {
  const violations = [];
  for (const file of sdkCodeFiles(packagesDir)) {
    const relative = path.relative(root, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (SITE_PATTERN.test(line)) {
        violations.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `Site-specific references in SDK packages (outside examples/fixtures):\n${violations.join("\n")}`,
  );
});
