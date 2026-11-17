// Code Mode must actually stop a runaway script: `await 1; while(true){}`
// blocks an event loop, so a Promise.race timeout is not enough.
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentBridge } from "../bridge.js";

function fakeRuntime() {
  return {
    connectionState: {
      status: "idle",
      directPeerCount: 0,
      peers: [],
      diagnostics: {},
    },
    identity: { id: "agent:me", name: "me" },
    room: null,
    origin: "https://site.example",
    capabilities: ["messages.send", "presence.read", "tools.invoke"],
    agentRoom: {},
    peers: () => [],
    onEvent: () => () => {},
  };
}

test("a runaway async loop is terminated and reported as a timeout", async () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({ catalogs: [] }),
  });
  const started = Date.now();
  const out = await bridge.runCode({ code: "await 1; while(true){}" });
  const elapsed = Date.now() - started;
  assert.equal(out.ok, false, "the script must not be reported as successful");
  assert.match(out.reason, /timed out/i);
  assert.ok(
    elapsed < 8_000,
    `caller must be released promptly (took ${elapsed}ms)`,
  );
});

test("the sandbox aborts its in-flight tool calls on timeout", async () => {
  let toolSignal = null;
  const catalog = {
    wallet: "agent:site",
    session: "s",
    requestNonce: "n".repeat(24),
    expiresAt: Date.now() + 60_000,
    tools: [{ name: "t" }],
  };
  const client = {
    catalogs: [catalog],
    callTool: async (_catalog, _name, _input, options) => {
      toolSignal = options?.signal ?? null;
      await new Promise((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("cancelled after timeout");
    },
  };
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => client,
  });
  const out = await bridge.runCode({
    code: `aiAuth.invoke("t"); await 1; while(true){}`,
  });
  assert.equal(out.ok, false);
  assert.ok(toolSignal, "the script made a real tool call");
  assert.equal(
    toolSignal.aborted,
    true,
    "the tool call was aborted when the sandbox timed out",
  );
});
