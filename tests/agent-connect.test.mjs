import assert from "node:assert/strict";
import test from "node:test";
import {
  createAIAuthConnectController,
  createAIAuthConnectInstruction,
} from "../packages/p2p/agent-connect.js";

const baseOptions = {
  siteOrigin: "https://www.body4ai.com",
  walletUrl: "https://wallet.body4ai.com/wallet/",
  capabilities: ["presence.read", "tools.invoke"],
  siteName: "BODY4AI",
};

function fakeConnection({
  name = "Research agent",
  capabilities = ["presence.read", "tools.invoke"],
  expiresAt = Date.now() + 60_000,
} = {}) {
  const lifecycle = new Set();
  let closed = false;
  let reason = "closed";
  const notify = (event) => {
    for (const listener of [...lifecycle]) {
      try {
        listener(event);
      } catch {}
    }
  };
  return {
    get closed() {
      return closed;
    },
    onLifecycle(listener) {
      if (closed) {
        listener({ type: "disconnected", reason });
        return () => {};
      }
      lifecycle.add(listener);
      // Mirrors connectAIAuthModal: the verified connected event fires
      // immediately on subscription.
      listener({
        type: "connected",
        label: name,
        identity: { id: "agent:test1234", name },
        capabilities,
        expiresAt,
      });
      return () => lifecycle.delete(listener);
    },
    close(input) {
      if (closed) return;
      closed = true;
      reason = input === "expired" ? "expired" : "closed";
      notify({ type: "disconnected", reason });
      lifecycle.clear();
    },
  };
}

test("connect instruction carries only public connection details", () => {
  const instruction = createAIAuthConnectInstruction(baseOptions);
  assert.equal(instruction.protocol, "ai-auth-wallet");
  assert.equal(instruction.version, 1);
  assert.equal(instruction.siteName, "BODY4AI");
  assert.equal(instruction.origin, "https://www.body4ai.com");
  assert.equal(instruction.room, "default");
  assert.equal(instruction.walletUrl, "https://wallet.body4ai.com/wallet/");
  assert.deepEqual(instruction.capabilities, ["presence.read", "tools.invoke"]);
  assert.match(
    instruction.instruction,
    /connectAIAuthModal/u,
    "copyable text includes the connect call",
  );
  assert.match(
    instruction.instruction,
    /https:\/\/wallet\.body4ai\.com\/wallet\//u,
  );
  assert.match(instruction.instruction, /onLifecycle/u);
  assert.deepEqual(JSON.parse(instruction.json), {
    protocol: "ai-auth-wallet",
    version: 1,
    siteName: "BODY4AI",
    origin: "https://www.body4ai.com",
    room: "default",
    walletUrl: "https://wallet.body4ai.com/wallet/",
    capabilities: ["presence.read", "tools.invoke"],
  });
  assert.equal(Object.isFrozen(instruction), true);
});

test("connect instruction accepts an explicit room and SDK source", () => {
  const instruction = createAIAuthConnectInstruction({
    ...baseOptions,
    room: "catalog",
    sdkSource:
      "https://unpkg.com/@enzovezzaro/ai-auth-wallet@latest/dist-p2p/ai-auth.js",
  });
  assert.equal(instruction.room, "catalog");
  assert.match(
    instruction.instruction,
    /https:\/\/unpkg\.com\/@enzovezzaro\/ai-auth-wallet@latest\/dist-p2p\/ai-auth\.js/u,
  );
});

test("connect instruction uses the wallet's canonical capability names", () => {
  const instruction = createAIAuthConnectInstruction({
    ...baseOptions,
    capabilities: [
      "tools.invoke",
      "presence.read",
      "tools.invoke",
      "resource:read",
      "api/read",
    ],
  });
  assert.deepEqual(instruction.capabilities, [
    "api/read",
    "presence.read",
    "resource:read",
    "tools.invoke",
  ]);
  for (const malformed of [
    "presence.",
    "presence..read",
    ".presence",
    "tools/",
    "tools__invoke",
  ]) {
    assert.throws(
      () =>
        createAIAuthConnectInstruction({
          ...baseOptions,
          capabilities: ["presence.read", malformed],
        }),
      /capability names/u,
      `Invalid capability must be rejected: ${malformed}`,
    );
  }
});

test("connect instruction rejects unsafe origins, wallets, and rooms", () => {
  assert.throws(
    () =>
      createAIAuthConnectInstruction({
        ...baseOptions,
        siteOrigin: "https://www.body4ai.com/catalog",
      }),
    /exact HTTP origin/u,
  );
  assert.throws(
    () =>
      createAIAuthConnectInstruction({
        ...baseOptions,
        siteOrigin: "http://www.body4ai.com",
      }),
    /exact HTTP origin/u,
  );
  assert.throws(
    () =>
      createAIAuthConnectInstruction({
        ...baseOptions,
        walletUrl: "http://wallet.body4ai.com/wallet/",
      }),
    /HTTPS/u,
  );
  assert.throws(
    () =>
      createAIAuthConnectInstruction({
        ...baseOptions,
        capabilities: [],
      }),
    /non-empty array/u,
  );
  assert.throws(
    () =>
      createAIAuthConnectInstruction({
        ...baseOptions,
        capabilities: ["presence.read", "BAD CAPABILITY"],
      }),
    /capability names/u,
  );
  assert.throws(
    () =>
      createAIAuthConnectInstruction({
        ...baseOptions,
        room: "not a room!",
      }),
    /safe characters/u,
  );
});

test("controller moves idle, connecting, connected, then disconnected", async () => {
  const connection = fakeConnection();
  const states = [];
  const controller = createAIAuthConnectController({
    instruction: "copy me",
    connect: async () => connection,
  });
  controller.subscribe((state) => states.push(state.status));

  assert.equal(controller.getState().status, "idle");
  await controller.connect();
  assert.equal(controller.getState().status, "connected");
  assert.equal(controller.getState().label, "Research agent");
  assert.deepEqual(
    [...controller.getState().capabilities],
    ["presence.read", "tools.invoke"],
  );

  connection.close();
  assert.equal(controller.getState().status, "disconnected");
  assert.equal(controller.getState().reason, "closed");

  connection.close("expired");
  controller.disconnect();
  assert.deepEqual(states, ["idle", "connecting", "connected", "disconnected"]);
  controller.close();
});

test("controller reflects the expired disconnect reason", async () => {
  const connection = fakeConnection();
  const controller = createAIAuthConnectController({
    connect: async () => connection,
  });
  await controller.connect();
  connection.close("expired");
  assert.equal(controller.getState().status, "disconnected");
  assert.equal(controller.getState().reason, "expired");
  controller.close();
});

test("controller falls back to idle with the handshake error", async () => {
  const controller = createAIAuthConnectController({
    connect: async () => {
      throw new Error("The wallet declined this site request");
    },
  });
  await controller.connect();
  const state = controller.getState();
  assert.equal(state.status, "idle");
  assert.match(state.error, /wallet declined/u);
  controller.close();
});

test("controller requires a connect function and ignores duplicate starts", async () => {
  const controller = createAIAuthConnectController({});
  await assert.rejects(
    () => controller.connect(),
    /connect function is required/u,
  );
  assert.equal(controller.getState().status, "idle");

  let connectCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const busy = createAIAuthConnectController({
    connect: async () => {
      connectCalls += 1;
      await gate;
      return fakeConnection();
    },
  });
  const first = busy.connect();
  await busy.connect();
  release();
  await first;
  assert.equal(connectCalls, 1);
  assert.equal(busy.getState().status, "connected");
  busy.close();
});

test("controller adopts an existing verified connection", () => {
  const connection = fakeConnection();
  const controller = createAIAuthConnectController({});
  controller.setConnection(connection);
  assert.equal(controller.getState().status, "connected");
  assert.equal(controller.getState().connection, connection);
  controller.disconnect();
  assert.equal(controller.getState().status, "disconnected");
  assert.equal(connection.closed, true);
  controller.close();
});

test("controller ignores an invalid connection object", () => {
  const controller = createAIAuthConnectController({});
  assert.throws(
    () => controller.setConnection({}),
    /page connection is required/u,
  );
  assert.equal(controller.getState().status, "idle");
  controller.close();
});

test("closed controller stops reflecting lifecycle changes", async () => {
  const connection = fakeConnection();
  const controller = createAIAuthConnectController({
    connect: async () => connection,
  });
  await controller.connect();
  controller.close();
  connection.close();
  assert.equal(controller.getState().status, "connected");
});
