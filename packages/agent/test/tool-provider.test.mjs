// BroadcastChannel would link in-process runtimes outside the fake transport.
globalThis.BroadcastChannel = class {
  postMessage() {}
  close() {}
};
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileKeystore } from "../keystore.js";
import { createAgentRuntime } from "../runtime.js";
import { createToolProvider } from "../tool-provider.js";
import { createHub } from "./fake-transport.mjs";
import { createAIAuthAgentClient } from "../../p2p/index.js";

const PASS = "correct horse battery staple";
const ORIGIN = "https://site.example";
const CAPS = ["presence.read", "messages.send", "tools.invoke"];

async function setup(t, hub, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-tool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keystore = createFileKeystore({ dir, passphrase: PASS, env: {} });
  await keystore.create({ name: extra.name ?? "agent" });
  const runtime = createAgentRuntime({
    keystore,
    origin: ORIGIN,
    room: "lobby",
    capabilities: extra.capabilities ?? CAPS,
    descriptor: { name: extra.name ?? "agent" },
    joinRoom: hub.joinRoom,
    delay: async () => {},
    random: () => 0.5,
  });
  t.after(() => runtime.close());
  return { runtime, keystore, dir };
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("condition not reached");
};

const pingTool = (calls) => ({
  name: "notes.ping",
  description: "Answers with the input",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  handler: async (input, { requester }) => {
    calls.push({ input, requester });
    return { pong: input.q ?? null, at: 1 };
  },
});

test("a runtime publishes tools another agent calls with no browser present", async (t) => {
  const hub = createHub();
  const a = await setup(t, hub, { name: "A" });
  const b = await setup(t, hub, { name: "B" });
  const calls = [];
  const provider = a.runtime.provideTools({
    tools: [pingTool(calls)],
    authorize: (requester, name, input) =>
      name === "notes.ping" && input.token === "ok",
  });
  assert.deepEqual(provider.tools, ["notes.ping"]);
  await a.runtime.join();
  await b.runtime.join();

  const client = createAIAuthAgentClient(b.runtime.agentRoom);
  t.after(() => client.close());
  await until(() =>
    client.catalogs.some(
      (c) =>
        c.wallet === a.runtime.identity.id &&
        c.tools.some((tool) => tool.name === "notes.ping"),
    ),
  );
  const catalog = client.catalogs.find(
    (c) => c.wallet === a.runtime.identity.id,
  );

  const result = await client.callTool(catalog, "notes.ping", {
    q: "hello",
    token: "ok",
  });
  assert.deepEqual(result, { pong: "hello", at: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requester, b.runtime.identity.id);
  // The site page never existed: no visitor, no wallet popup, no browser.
  assert.equal(a.runtime.connectionState.status, "direct-peer-connected");
});

test("a denied call fails without running the handler", async (t) => {
  const hub = createHub();
  const a = await setup(t, hub, { name: "A" });
  const b = await setup(t, hub, { name: "B" });
  const calls = [];
  a.runtime.provideTools({
    tools: [pingTool(calls)],
    authorize: (_requester, _name, input) => input.token === "ok",
  });
  await a.runtime.join();
  await b.runtime.join();
  const client = createAIAuthAgentClient(b.runtime.agentRoom);
  t.after(() => client.close());
  await until(() =>
    client.catalogs.some((c) => c.wallet === a.runtime.identity.id),
  );
  const catalog = client.catalogs.find(
    (c) => c.wallet === a.runtime.identity.id,
  );
  await assert.rejects(
    client.callTool(catalog, "notes.ping", { q: "x" }),
    /did not allow that tool/u,
  );
  assert.equal(calls.length, 0);
});

test("closing the provider withdraws the catalog", async (t) => {
  const hub = createHub();
  const a = await setup(t, hub, { name: "A" });
  const b = await setup(t, hub, { name: "B" });
  const provider = a.runtime.provideTools({
    tools: [pingTool([])],
    authorize: () => true,
  });
  await a.runtime.join();
  await b.runtime.join();
  const client = createAIAuthAgentClient(b.runtime.agentRoom);
  t.after(() => client.close());
  await until(() =>
    client.catalogs.some(
      (c) => c.wallet === a.runtime.identity.id && c.tools.length === 1,
    ),
  );
  provider.close();
  await until(() =>
    client.catalogs.some(
      (c) => c.wallet === a.runtime.identity.id && c.tools.length === 0,
    ),
  );
});

test("provider validation rejects unsafe tool definitions", () => {
  const room = {
    wallet: { id: "w" },
    session: "s",
    send: async () => {},
    subscribe: () => () => {},
  };
  const authorize = () => true;
  assert.throws(
    () => createToolProvider({ room, tools: [], authorize }),
    /1 to 32/u,
  );
  assert.throws(
    () =>
      createToolProvider({
        room,
        tools: [{ name: "Bad Name", handler: async () => {} }],
        authorize,
      }),
    /lowercase name/u,
  );
  assert.throws(
    () =>
      createToolProvider({
        room,
        tools: [
          { name: "a.b", handler: async () => {} },
          { name: "a.b", handler: async () => {} },
        ],
        authorize,
      }),
    /Duplicate/u,
  );
  assert.throws(
    () => createToolProvider({ room, tools: [{ name: "a.b" }], authorize }),
    /handler/u,
  );
  assert.throws(
    () => createToolProvider({ room, tools: [], authorize: undefined }),
    /authorize/u,
  );
});

test("provideTools requires tools.invoke and a live runtime", async (t) => {
  const hub = createHub();
  const readOnly = await setup(t, hub, {
    name: "R",
    capabilities: ["presence.read"],
  });
  assert.throws(
    () =>
      readOnly.runtime.provideTools({
        tools: [pingTool([])],
        authorize: () => true,
      }),
    /tools\.invoke/u,
  );
  const a = await setup(t, hub, { name: "A" });
  await a.runtime.close();
  assert.throws(
    () =>
      a.runtime.provideTools({
        tools: [pingTool([])],
        authorize: () => true,
      }),
    /closed/u,
  );
});

test("handler failures and oversized results are reported as errors", async (t) => {
  const hub = createHub();
  const a = await setup(t, hub, { name: "A" });
  const b = await setup(t, hub, { name: "B" });
  a.runtime.provideTools({
    tools: [
      {
        name: "boom.fail",
        handler: async () => {
          throw new Error("secret detail");
        },
      },
      {
        name: "boom.large",
        handler: async () => ({ text: "x".repeat(20_000) }),
      },
    ],
    authorize: () => true,
  });
  await a.runtime.join();
  await b.runtime.join();
  const client = createAIAuthAgentClient(b.runtime.agentRoom);
  t.after(() => client.close());
  await until(() =>
    client.catalogs.some(
      (c) => c.wallet === a.runtime.identity.id && c.tools.length === 2,
    ),
  );
  const catalog = client.catalogs.find(
    (c) => c.wallet === a.runtime.identity.id,
  );
  await assert.rejects(
    client.callTool(catalog, "boom.fail", {}),
    /could not complete/u,
  );
  await assert.rejects(
    client.callTool(catalog, "boom.large", {}),
    /too large/u,
  );
});

test("the catalog is announced again for a new live session", async (t) => {
  const hub = createHub();
  const a = await setup(t, hub, { name: "A" });
  const b = await setup(t, hub, { name: "B" });
  a.runtime.provideTools({
    tools: [pingTool([])],
    authorize: () => true,
  });
  await a.runtime.join();
  const first = a.runtime.agentRoom.session;
  await b.runtime.join();
  const client = createAIAuthAgentClient(b.runtime.agentRoom);
  t.after(() => client.close());
  await until(() =>
    client.catalogs.some(
      (c) => c.wallet === a.runtime.identity.id && c.tools.length === 1,
    ),
  );
  // A reconnect inside the same room gets a fresh session id; the provider
  // must publish a catalog bound to it, or calls would target the dead one.
  await a.runtime.join("lobby");
  assert.notEqual(a.runtime.agentRoom.session, first);
  await until(() =>
    client.catalogs.some(
      (c) =>
        c.wallet === a.runtime.identity.id &&
        c.session === a.runtime.agentRoom.session &&
        c.tools.length === 1,
    ),
  );
});
