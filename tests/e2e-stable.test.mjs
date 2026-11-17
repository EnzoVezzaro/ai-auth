import assert from "node:assert/strict";
import test from "node:test";
import { expectStable } from "../scripts/e2e/helpers.mjs";

test("expectStable passes when a value remains unchanged for the window", async () => {
  let calls = 0;
  const value = await expectStable(
    async () => {
      calls += 1;
      return 7;
    },
    { window: 60, interval: 10 },
  );
  assert.equal(value, 7);
  assert.ok(calls >= 2, "the window was actually observed more than once");
});

test("expectStable fails when a late event changes the value", async () => {
  let calls = 0;
  await assert.rejects(
    expectStable(
      async () => {
        calls += 1;
        return calls >= 3 ? 8 : 7;
      },
      { window: 100, interval: 10, message: "late event" },
    ),
    /late event/u,
  );
});
