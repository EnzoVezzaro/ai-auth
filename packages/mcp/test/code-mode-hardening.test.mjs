// Hardening for the opt-in Code Mode sandbox: per-script call accounting,
// bounded logs, explicit oversized-shared-reply errors, truthful partial status
// on timeout, and abort propagation to send.
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentBridge } from "../bridge.js";

function fakeRuntime(overrides = {}) {
  return {
    connectionState: {
      status: "idle",
      connected: false,
      generation: 1,
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
    ...overrides,
  };
}

function makeClient({ hang = false } = {}) {
  let started = 0;
  const catalog = {
    wallet: "agent:site",
    session: "s",
    requestNonce: "n".repeat(24),
    expiresAt: Date.now() + 60_000,
    tools: [{ name: "t" }],
  };
  const callTool = async (_catalog, _name, _input, options) => {
    started += 1;
    if (!hang) return { hits: started };
    await new Promise((resolve) => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener("abort", resolve, { once: true });
    });
    throw new Error("cancelled after timeout");
  };
  return { bridge: { catalogs: [catalog], callTool }, count: () => started };
}

test("a script cannot exceed the total host-call cap", async () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({ catalogs: [] }),
  });
  const out = await bridge.runCode({
    code: `let last = "";
      for (let i = 0; i < 67; i++) {
        try { aiAuth.status(); } catch (e) { last = (e && e.code) + ":" + (e && e.message); }
      }
      return last;`,
  });
  assert.equal(out.ok, true, out.reason);
  assert.match(out.value, /CODE_FAILED/);
  assert.match(out.value, /call limit exceeded/i);
  assert.ok(
    out.calls >= 64,
    `all attempts are accounted for (got ${out.calls})`,
  );
  assert.ok(
    out.callOutcomes.some(
      (entry) => entry.ok === false && /call limit exceeded/i.test(entry.error),
    ),
    "the rejected calls are reported in the outcome log",
  );
});

test("outstanding async calls are capped independently of the total cap", async () => {
  const { bridge, count } = makeClient({ hang: true });
  const fullBridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => bridge,
  });
  const out = await fullBridge.runCode({
    code: `for (let i = 0; i < 12; i++) aiAuth.invoke("t");
      await 1; while (true) {}`,
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /timed out/i);
  assert.equal(
    count(),
    8,
    "only eight calls reached the tool; the next four were rejected by the cap",
  );
  assert.equal(out.calls, 12, "every attempt is counted");
});

test("each log entry is bounded to 240 characters and capped at 50 entries", async () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({ catalogs: [] }),
  });
  const lengthOut = await bridge.runCode({
    code: `console.log("x".repeat(1000)); return 1;`,
  });
  assert.equal(lengthOut.ok, true, lengthOut.reason);
  assert.equal(lengthOut.logs.length, 1);
  assert.equal(lengthOut.logs[0].length, 240);

  const countOut = await bridge.runCode({
    code: `for (let i = 0; i < 80; i++) console.log("L" + i); return 1;`,
  });
  assert.equal(countOut.ok, true, countOut.reason);
  assert.equal(countOut.logs.length, 50);
  assert.equal(countOut.logs[0], "L0");
  assert.equal(countOut.logs[49], "L49");
});

test("an oversized shared reply becomes an explicit error, not corrupt JSON", async () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime({ identity: { id: "x".repeat(300_000), name: "me" } }),
    clientFactory: () => ({ catalogs: [] }),
  });
  const out = await bridge.runCode({
    code: `try { aiAuth.status(); return "NO_ERROR"; }
      catch (e) { return "ERR:" + (e && e.message); }`,
  });
  assert.equal(out.ok, true, out.reason);
  assert.match(out.value, /^ERR:/);
  assert.match(out.value, /too large/i);
});

test("a timeout reports truthful partial status, never a rollback", async () => {
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({ catalogs: [] }),
  });
  const out = await bridge.runCode({
    code: `console.log("before"); const r = aiAuth.status();
      console.log("status:" + r.connection);
      await 1; while (true) {}`,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "CODE_FAILED");
  assert.match(out.reason, /timed out/i);
  assert.equal(out.partial, true);
  assert.equal(out.rolledBack, false);
  assert.match(out.note, /NOT rolled back/i);
  assert.match(out.note, /No retry/i);
  assert.deepEqual(out.logs, ["before", "status:idle"]);
  assert.ok(
    out.callOutcomes.some(
      (entry) => entry.method === "status" && entry.ok === true,
    ),
    "completed call outcomes are included in the partial result",
  );
});

test("caller abort returns partial status promptly without claiming rollback", async () => {
  const controller = new AbortController();
  const bridge = createAgentBridge({
    runtime: fakeRuntime(),
    clientFactory: () => ({ catalogs: [] }),
  });
  const started = Date.now();
  const run = bridge.runCode(
    { code: `await 1; while (true) {}` },
    { signal: controller.signal },
  );
  controller.abort();
  const out = await run;
  assert.equal(out.ok, false);
  assert.match(out.reason, /aborted/i);
  assert.equal(out.partial, true);
  assert.equal(out.rolledBack, false);
  assert.match(out.note, /NOT rolled back/i);
  assert.ok(Date.now() - started < 1_000, "abort releases the caller promptly");
});

test("send receives the shared signal and it is aborted on timeout", async () => {
  let sentSignal = null;
  const runtime = fakeRuntime({
    send: async (_type, _payload, options) => {
      sentSignal = options?.signal ?? null;
      await new Promise((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("cancelled after timeout");
    },
  });
  const bridge = createAgentBridge({
    runtime,
    clientFactory: () => ({ catalogs: [] }),
  });
  const out = await bridge.runCode({
    code: `aiAuth.send({ text: "hi" }); await 1; while (true) {}`,
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /timed out/i);
  assert.ok(
    sentSignal,
    "the send call received an options object with a signal",
  );
  assert.equal(sentSignal.aborted, true, "the shared signal was aborted");
});

test("send still completes normally when it resolves before the timeout", async () => {
  let sentSignal = null;
  const runtime = fakeRuntime({
    send: async (_type, _payload, options) => {
      sentSignal = options?.signal ?? null;
      return { body: { type: "message/text" } };
    },
  });
  const bridge = createAgentBridge({
    runtime,
    clientFactory: () => ({ catalogs: [] }),
  });
  const out = await bridge.runCode({
    code: `return (await aiAuth.send({ text: "hi" })).sent;`,
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.value, true);
  assert.ok(sentSignal, "the signal is forwarded on the success path too");
});
