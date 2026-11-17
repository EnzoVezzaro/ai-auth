import assert from "node:assert/strict";
import test from "node:test";
import {
  appSource,
  extractIfContaining,
  runFragment,
} from "./helpers/app-source.mjs";

const ORIGIN = "https://site.example";
const OTHER_ORIGIN = "https://other.example";

async function harness(externalOrigin = "") {
  const source = await appSource();
  const calls = [];
  const sandbox = runFragment(
    `async function handle(event) { ${extractIfContaining(
      source,
      'event.data?.type === "ai-auth/session-resume"',
    )} }`,
    {
      externalHost: "opener",
      state: { externalOrigin },
      confirmResume: undefined,
      confirmSessionResume: async (event) => calls.push(event),
    },
  );
  return { handle: sandbox.handle, calls };
}

test("the wallet accepts a resume message from the expected origin", async () => {
  const { handle, calls } = await harness();
  await handle({
    source: "opener",
    origin: ORIGIN,
    data: { type: "ai-auth/session-resume", audience: ORIGIN },
  });
  assert.equal(calls.length, 1, "a genuine resume request is processed");
});

test("the wallet ignores a resume message whose origin differs from its audience", async () => {
  const { handle, calls } = await harness();
  await handle({
    source: "opener",
    origin: OTHER_ORIGIN,
    data: { type: "ai-auth/session-resume", audience: ORIGIN },
  });
  assert.equal(calls.length, 0, "a forged audience cannot drive a resume");
});

test("an established session only resumes from its own origin", async () => {
  const { handle, calls } = await harness(ORIGIN);
  await handle({
    source: "opener",
    origin: OTHER_ORIGIN,
    data: { type: "ai-auth/session-resume", audience: OTHER_ORIGIN },
  });
  assert.equal(
    calls.length,
    0,
    "a different origin is ignored even when the audience matches it",
  );
  await handle({
    source: "opener",
    origin: ORIGIN,
    data: { type: "ai-auth/session-resume", audience: ORIGIN },
  });
  assert.equal(calls.length, 1, "the bound origin still works");
});

test("a resume message from another source is ignored", async () => {
  const { handle, calls } = await harness();
  await handle({
    source: "another-window",
    origin: ORIGIN,
    data: { type: "ai-auth/session-resume", audience: ORIGIN },
  });
  assert.equal(calls.length, 0, "only the opener may request a resume");
});
