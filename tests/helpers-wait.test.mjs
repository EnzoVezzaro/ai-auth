import assert from "node:assert/strict";
import test from "node:test";
import { until } from "./helpers/wait.mjs";

test("until polls a condition with a deadline instead of a fixed sleep", async () => {
  let ready = false;
  const pending = until(() => ready, {
    timeout: 2_000,
    interval: 5,
    message: "flag",
  });
  setTimeout(() => {
    ready = true;
  }, 30);
  await pending; // resolves as soon as the condition holds
});

test("until fails with the named condition when the deadline passes", async () => {
  await assert.rejects(
    until(() => false, {
      timeout: 40,
      interval: 5,
      message: "never true",
    }),
    /never true/u,
  );
});

test("until uses a monotonic clock even when Date.now is overridden", async () => {
  const realNow = Date.now;
  Date.now = () => 0;
  try {
    await assert.rejects(
      until(() => false, { timeout: 40, interval: 5, message: "clock" }),
      /clock/u,
    );
  } finally {
    Date.now = realNow;
  }
});
