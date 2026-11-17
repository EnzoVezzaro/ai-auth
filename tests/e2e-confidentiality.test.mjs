import assert from "node:assert/strict";
import test from "node:test";
import { checkUninvitedTarget } from "../scripts/e2e/confidentiality.mjs";
import { KnownBug, createReport } from "../scripts/e2e/report.mjs";

test("an uninvited recipient keeps the step green only when it got nothing", async () => {
  const clean = {};
  assert.equal(checkUninvitedTarget(clean, false), false);
  assert.equal(clean.uninvitedTargetReceived, false);
});

test("a leak is recorded as a KnownBug so report.passed() is false", async () => {
  const evidence = {};
  assert.throws(
    () => checkUninvitedTarget(evidence, true),
    (error) =>
      error instanceof KnownBug && /targeted message/u.test(error.observed),
  );
  assert.equal(evidence.uninvitedTargetReceived, true);
  const report = createReport();
  await report.step(8, "confidentiality", () =>
    checkUninvitedTarget({}, true),
  );
  assert.equal(report.rows[0].status, "KNOWN-BUG");
  assert.equal(report.passed(), false);
});
