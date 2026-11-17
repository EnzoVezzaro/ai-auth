// An oversized tool result must reach the agent as a typed error, not as the
// generic DENIED outcome that hides the real reason.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createAIAuthAgentClient,
  TOOL_ERROR_CODES,
} from "../packages/p2p/index.js";

const until = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

test("an oversized result rejects with a distinct code, not DENIED", async (t) => {
  const listeners = new Set();
  let requestId = null;
  const room = {
    wallet: { id: "agent:requester-123456789", name: "Requester" },
    session: "agent-session-1",
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async send(_type, payload) {
      if (payload?.kind === "tool-request") requestId = payload.requestId;
    },
  };
  const emit = (payload) => {
    for (const listener of [...listeners])
      listener({
        direction: "in",
        envelope: {
          body: { type: "agent/action", issuer: "agent:site", payload },
        },
      });
  };
  const client = createAIAuthAgentClient(room);
  t.after(() => client.close());
  emit({
    kind: "tool-catalog",
    targetWallet: "agent:site",
    targetSession: "site-session",
    targetNonce: "target-nonce-1234567890",
    session: "site-session",
    expiresAt: Date.now() + 60_000,
    tools: [
      {
        name: "site.big",
        description: "Returns a lot",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  const catalog = client.catalogs.find((c) => c.wallet === "agent:site");
  assert.ok(catalog);
  const pending = client.callTool(catalog, "site.big", {});
  await until(() => requestId !== null);
  emit({
    kind: "tool-response",
    requestId,
    toWallet: room.wallet.id,
    toSession: room.session,
    targetWallet: "agent:site",
    targetSession: "site-session",
    targetNonce: "target-nonce-1234567890",
    result: "x".repeat(9_000),
  });
  await assert.rejects(pending, (error) => {
    assert.equal(
      error.code,
      TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
      "oversized data is a tool failure, not a policy denial",
    );
    assert.notEqual(error.code, TOOL_ERROR_CODES.DENIED);
    return true;
  });
});
