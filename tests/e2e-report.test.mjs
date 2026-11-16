import assert from "node:assert/strict";
import test from "node:test";
import {
  createReport,
  KnownBug,
  NetworkFailure,
  Pending,
} from "../scripts/e2e/report.mjs";

async function record(...events) {
  const original = console.log;
  console.log = () => {};
  try {
    const report = createReport();
    for (const [step, name, event] of events) {
      await report.step(step, name, () => {
        if (event) throw event;
      });
    }
    return report;
  } finally {
    console.log = original;
  }
}

test("a run with only passing steps is reported as passing", async () => {
  const report = await record([1, "passes", undefined]);
  assert.equal(report.passed(), true);
});

test("a pending step is not reported as passing", async () => {
  const report = await record([1, "pending", new Pending("not run")]);
  assert.equal(report.passed(), false);
});

test("a failed step is not reported as passing", async () => {
  const report = await record([1, "fails", new Error("boom")]);
  assert.equal(report.passed(), false);
});

test("known bugs and network failures are not reported as passing", async () => {
  const report = await record(
    [1, "known bug", new KnownBug("a", "b")],
    [2, "network", new NetworkFailure("offline")],
  );
  assert.equal(report.passed(), false);
});

test("one pending step among passes still fails the run", async () => {
  const report = await record(
    [1, "passes", undefined],
    [2, "pending", new Pending("not run")],
    [3, "passes", undefined],
  );
  assert.equal(report.passed(), false);
});
