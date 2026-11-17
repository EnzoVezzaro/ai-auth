// armExpiry must not spin a 1 ms timer for a Never grant, must cap long delays
// at the 32-bit timer maximum, and must re-check a revoked connection.
import assert from "node:assert/strict";
import test from "node:test";
import {
  markVerifiedPageConnection,
  revokeVerifiedPageConnection,
} from "../packages/p2p/session.js";
import { registerAIAuthPageActions } from "../packages/p2p/index.js";

const MAX_TIMER_MS = 0x7fffffff;
const consent = (expiresAt) => ({
  body: { payload: { capabilities: ["tools.invoke"], expiresAt } },
});

function captureTimers() {
  const real = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    delays.push(ms);
    return real(fn, ms, ...args);
  };
  return {
    delays,
    restore: () => {
      globalThis.setTimeout = real;
    },
  };
}

test("a Never grant arms no timer at all", async (t) => {
  const connection = {};
  markVerifiedPageConnection(connection, consent(null));
  const timers = captureTimers();
  let api;
  try {
    api = await registerAIAuthPageActions({
      actions: [
        {
          name: "site.read",
          description: "Read",
          requiredCapability: "tools.invoke",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "ok",
        },
      ],
      connection,
      authorize: async () => true,
      modelContext: null,
    });
    assert.equal(
      timers.delays.includes(1),
      false,
      "a null expiry must not spin a 1 ms timer",
    );
  } finally {
    timers.restore();
    api?.close();
    revokeVerifiedPageConnection(connection);
  }
});

test("a far-future expiry is capped at the 32-bit timer maximum", async (t) => {
  const connection = {};
  markVerifiedPageConnection(connection, consent(Date.now() + 5_000_000_000));
  const timers = captureTimers();
  let api;
  try {
    api = await registerAIAuthPageActions({
      actions: [
        {
          name: "site.read",
          description: "Read",
          requiredCapability: "tools.invoke",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "ok",
        },
      ],
      connection,
      authorize: async () => true,
      modelContext: null,
    });
    assert.ok(timers.delays.length > 0);
    assert.equal(
      timers.delays[0],
      MAX_TIMER_MS,
      "the timer cannot exceed the 32-bit maximum",
    );
  } finally {
    timers.restore();
    api?.close();
    revokeVerifiedPageConnection(connection);
  }
});

test("revoking the connection stops tool execution", async (t) => {
  const connection = {};
  markVerifiedPageConnection(connection, consent(null));
  const api = await registerAIAuthPageActions({
    actions: [
      {
        name: "site.read",
        description: "Read",
        requiredCapability: "tools.invoke",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "ok",
      },
    ],
    connection,
    authorize: async () => true,
    modelContext: null,
  });
  t.after(() => api.close());
  revokeVerifiedPageConnection(connection);
  const outcome = await api.execute("site.read");
  assert.equal(outcome.code, "DENIED");
  assert.match(outcome.error, /not approved/);
});
