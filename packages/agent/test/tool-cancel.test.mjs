// Cancellation during the human authorization gate must stop the tool before
// its handler runs, and a cancel must only affect the issuer's own request.
import assert from "node:assert/strict";
import test from "node:test";
import { createToolProvider } from "../tool-provider.js";
import { TOOL_ERROR_CODES } from "@enzovezzaro/ai-auth-wallet";

function harness({ authorize }) {
  const listeners = new Set();
  const sent = [];
  let handlerCalls = 0;
  const room = {
    wallet: { id: "agent:provider-123456789" },
    session: "provider-session",
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async send(type, payload, options) {
      sent.push({ type, payload, options });
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
          handlerCalls += 1;
          return "late result";
        },
      },
    ],
    authorize,
  });
  const nonce = sent.at(-1).payload.targetNonce;
  const emit = (issuer, payload) => {
    for (const listener of [...listeners])
      listener({
        direction: "in",
        envelope: { body: { type: "agent/action", issuer, payload } },
      });
  };
  const request = (issuer, requestId) =>
    emit(issuer, {
      kind: "tool-request",
      requestId,
      name: "notes.ping",
      input: {},
      targetWallet: room.wallet.id,
      targetSession: room.session,
      targetNonce: nonce,
      session: `${issuer}-session`,
    });
  const cancel = (issuer, requestId) =>
    emit(issuer, {
      kind: "tool-cancel",
      requestId,
      targetWallet: room.wallet.id,
      targetSession: room.session,
      targetNonce: nonce,
    });
  const responses = () =>
    sent.filter((s) => s.payload.kind === "tool-response");
  return {
    provider,
    nonce,
    request,
    cancel,
    responses,
    get handlerCalls() {
      return handlerCalls;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("a cancel during authorize returns CANCELLED before the handler runs", async () => {
  let release;
  const h = harness({
    authorize: () => new Promise((resolve) => (release = resolve)),
  });
  h.request("agent:requester-123456789", "request-cancel-12345678");
  await tick();
  assert.equal(h.responses().length, 0);
  h.cancel("agent:requester-123456789", "request-cancel-12345678");
  release(true);
  await tick();
  const response = h.responses().at(-1);
  assert.ok(response, "a response was sent");
  assert.equal(response.payload.code, TOOL_ERROR_CODES.CANCELLED);
  assert.equal(
    h.handlerCalls,
    0,
    "an aborted authorization must never reach the handler",
  );
  h.provider.close();
});
