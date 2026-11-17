// The wallet relay has browser top-level side effects, so these tests run the
// real source text of handleExternalSiteEvent in a VM with controlled globals.
import assert from "node:assert/strict";
import test from "node:test";
import {
  appSource,
  extractFunction,
  extractIfContaining,
  runFragment,
} from "./helpers/app-source.mjs";

async function relaySiteCursor(cursor) {
  const source = await appSource();
  const handler = extractFunction(source, "handleExternalSiteEvent");
  const sent = [];
  const sandbox = runFragment(handler, {
    state: {
      externalRequest: {},
      consent: { body: { payload: { capabilities: ["presence.read"] } } },
      room: {
        send: async (type, payload) => {
          sent.push({ type, payload });
        },
      },
      wallet: { name: "Human" },
    },
    externalSessionActive: () => true,
    debug: () => {},
  });
  await sandbox.handleExternalSiteEvent({
    type: "ai-auth/site-cursor",
    cursor,
  });
  return sent;
}

test("the wallet signs the page from the site so human cursors are page-scoped", async () => {
  const sent = await relaySiteCursor({ x: 0.25, y: 0.5, pageKey: "/docs" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "presence/cursor");
  assert.equal(sent[0].payload.pageKey, "/docs");
});

test("a malformed page key is not signed into a human cursor", async () => {
  const sent = await relaySiteCursor({
    x: 0.25,
    y: 0.5,
    pageKey: "x".repeat(201),
  });
  assert.equal(sent.length, 0, "an over-long page key is dropped");
});

test("the wallet chat list records agent collab/text as well as message/text", async () => {
  const source = await appSource();
  const branch = extractIfContaining(
    source,
    'if (type === "message/text" || type === "collab/text")',
  );
  for (const type of ["message/text", "collab/text"]) {
    const state = { messages: [] };
    runFragment(branch, {
      state,
      type,
      direction: "in",
      envelope: {
        body: {
          type,
          payload: { text: `hello from ${type}` },
          issuer: "agent:peer",
          createdAt: 123,
        },
      },
    });
    assert.equal(state.messages.length, 1, `${type} appears in the chat list`);
    assert.equal(state.messages[0].text, `hello from ${type}`);
    assert.equal(state.messages[0].issuer, "agent:peer");
  }
});
