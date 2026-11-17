// Request-id memory must be scoped to the requester: two peers may legally
// choose the same requestId, while a replay from one peer is still deduped.
import assert from "node:assert/strict";
import test from "node:test";
import { createToolProvider } from "../tool-provider.js";

test("equal requestIds from different requesters are both executed", async () => {
  const listeners = new Set();
  const sent = [];
  let calls = 0;
  const room = {
    wallet: { id: "agent:provider-123456789" },
    session: "provider-session",
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async send(type, payload) {
      sent.push({ type, payload });
    },
  };
  const provider = createToolProvider({
    room,
    tools: [
      {
        name: "notes.ping",
        description: "Ping",
        inputSchema: { type: "object", properties: {} },
        handler: async () => {
          calls += 1;
          return { n: calls };
        },
      },
    ],
    authorize: async () => true,
  });
  const nonce = sent.at(-1).payload.targetNonce;
  const emit = (issuer, session) =>
    listeners.forEach((fn) =>
      fn({
        direction: "in",
        envelope: {
          body: {
            type: "agent/action",
            issuer,
            payload: {
              kind: "tool-request",
              requestId: "request-shared-12345678",
              name: "notes.ping",
              input: {},
              targetWallet: room.wallet.id,
              targetSession: room.session,
              targetNonce: nonce,
              session,
            },
          },
        },
      }),
    );
  const A = "agent:requester-A-123456";
  const B = "agent:requester-B-123456";
  emit(A, "session-A");
  emit(B, "session-B");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2, "each requester owns its own request-id namespace");
  assert.equal(
    sent.filter((s) => s.payload.kind === "tool-response").length,
    2,
  );
  // A replay from the same requester is still ignored.
  emit(A, "session-A");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2, "a replay from one requester is still deduped");
  provider.close();
});
