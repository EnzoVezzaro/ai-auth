// tool-cancel must only cancel a request that came from the same issuer.
import assert from "node:assert/strict";
import test from "node:test";
import { createToolProvider } from "../tool-provider.js";
import { TOOL_ERROR_CODES } from "@enzovezzaro/ai-auth-wallet";

test("a cancel from another issuer cannot abort this issuer's request", async () => {
  const listeners = new Set();
  const sent = [];
  const signals = new Map();
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
        handler: async (_input, { signal }) =>
          await new Promise((resolve) => {
            signals.get("waiting")?.push(signal);
            signal.addEventListener("abort", () => resolve({ aborted: true }), {
              once: true,
            });
          }),
      },
    ],
    authorize: async () => true,
  });
  const nonce = sent.at(-1).payload.targetNonce;
  const emit = (issuer, payload) => {
    for (const listener of [...listeners])
      listener({
        direction: "in",
        envelope: { body: { type: "agent/action", issuer, payload } },
      });
  };
  signals.set("waiting", []);
  const A = "agent:requester-A-123456";
  const B = "agent:requester-B-123456";
  emit(A, {
    kind: "tool-request",
    requestId: "request-A-12345678",
    name: "notes.ping",
    input: {},
    targetWallet: room.wallet.id,
    targetSession: room.session,
    targetNonce: nonce,
    session: "requester-A-session",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const aSignal = signals.get("waiting").at(-1);
  assert.ok(aSignal, "A's handler is running");
  // B cancels A's request id: it must be ignored.
  emit(B, {
    kind: "tool-cancel",
    requestId: "request-A-12345678",
    targetWallet: room.wallet.id,
    targetSession: room.session,
    targetNonce: nonce,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aSignal.aborted, false, "another issuer cannot abort A's call");
  // The owner's cancel still works.
  emit(A, {
    kind: "tool-cancel",
    requestId: "request-A-12345678",
    targetWallet: room.wallet.id,
    targetSession: room.session,
    targetNonce: nonce,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aSignal.aborted, true, "the owner can abort its own call");
  const response = sent
    .filter((s) => s.payload.kind === "tool-response")
    .at(-1);
  assert.equal(response.payload.code, TOOL_ERROR_CODES.CANCELLED);
  provider.close();
});
