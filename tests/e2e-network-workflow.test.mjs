// The real-network suites are intentionally outside release-blocking CI. This
// check keeps their dedicated nightly/manual workflow present and configured.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const workflow = await readFile(
  resolve(import.meta.dirname, "../.github/workflows/e2e-network.yml"),
  "utf8",
);

test("network E2E runs on manual dispatch and a nightly schedule", () => {
  assert.match(workflow, /^\s{2}workflow_dispatch:/mu);
  assert.match(workflow, /^\s{2}schedule:/mu);
  assert.match(workflow, /cron:\s*['"]?\d+\s+\d+\s+\*\s+\*\s+\*['"]?/u);
});

test("network E2E runs all three real-network suites", () => {
  for (const script of [
    "test:e2e:body4ai",
    "test:browser:resume",
    "test:browser:wheel",
  ])
    assert.match(workflow, new RegExp(`npm run ${script}`, "u"), script);
});

test("network E2E installs Playwright and retains screenshots", () => {
  assert.match(workflow, /npx playwright install/u);
  assert.match(workflow, /actions\/upload-artifact/u);
  assert.match(workflow, /test-results\/screenshots/u);
  assert.match(workflow, /retention-days:\s*\d+/u);
  assert.match(workflow, /if:\s*always\(\)/u);
});

test("network E2E needs no secrets", () => {
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./u);
});
