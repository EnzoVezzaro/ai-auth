import assert from "node:assert/strict";

/**
 * Polls `check` until truthy or the deadline passes. Uses a monotonic clock so
 * tests that override Date.now still keep a bounded wait, and reports the
 * condition name on failure.
 */
export async function until(
  check,
  { timeout = 5_000, interval = 20, message = "condition" } = {},
) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  assert.fail(`Timed out after ${timeout} ms waiting for ${message}`);
}
