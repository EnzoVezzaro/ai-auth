import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  createAIAuthAgentClient,
  identityFor,
  randomNonce,
  signEnvelope,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

const SITE_ORIGIN = "https://site.example";
const ROOM = "research";

async function makeWallet(name) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const id = await identityFor(publicKey);
  return {
    id,
    name,
    sign: (type, payload) =>
      signEnvelope(
        { id, publicKey, privateKey: keys.privateKey },
        type,
        payload,
      ),
  };
}

// A room double with the peer list a P2PRoom keeps (`peers` is a Map of presence).
function makeAgentRoom(agent) {
  const listeners = new Set();
  const peers = new Map();
  const room = {
    wallet: agent,
    session: "agent-room-session",
    peers,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send() {},
  };
  const emit = (envelope) => {
    for (const listener of [...listeners])
      listener({ direction: "in", envelope });
  };
  return { room, peers, emit };
}

async function siteCatalog(site) {
  return site.sign("agent/action", {
    kind: "tool-catalog",
    tools: [
      {
        name: "catalog.search_products",
        description: "Search the catalog.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    targetWallet: site.id,
    targetNonce: "target-page-nonce-123456789",
    targetSession: "site-room-session",
    room: ROOM,
    origin: SITE_ORIGIN,
    session: "site-room-session",
    nonce: randomNonce(),
    expiresAt: Date.now() + 60_000,
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a site's catalog stays while the site is present in the room", async (t) => {
  const site = await makeWallet("Site");
  const agent = await makeWallet("Agent");
  const { room, peers, emit } = makeAgentRoom(agent);
  peers.set(`${site.id}:site-room-session`, {
    id: site.id,
    session: "site-room-session",
  });
  const client = createAIAuthAgentClient(room, {
    presenceCheckMs: 10,
    absentGraceMs: 30,
  });
  t.after(() => client.close());
  emit(await siteCatalog(site));
  await wait(80);
  assert.equal(client.catalogs.length, 1, "present site keeps its catalog");
});

test("a site's catalog is dropped once its presence has been gone past the grace period", async (t) => {
  const site = await makeWallet("Site");
  const agent = await makeWallet("Agent");
  const { room, peers, emit } = makeAgentRoom(agent);
  peers.set(`${site.id}:site-room-session`, {
    id: site.id,
    session: "site-room-session",
  });
  const client = createAIAuthAgentClient(room, {
    presenceCheckMs: 10,
    absentGraceMs: 30,
  });
  t.after(() => client.close());
  emit(await siteCatalog(site));
  assert.equal(client.catalogs.length, 1);
  peers.clear(); // the site's presence lease has expired
  await wait(120);
  assert.equal(client.catalogs.length, 0, "stale catalog is removed");
});

test("calls to a site that has left fail at once instead of timing out", async (t) => {
  const site = await makeWallet("Site");
  const agent = await makeWallet("Agent");
  const { room, peers, emit } = makeAgentRoom(agent);
  peers.set(`${site.id}:site-room-session`, {
    id: site.id,
    session: "site-room-session",
  });
  const client = createAIAuthAgentClient(room, {
    presenceCheckMs: 10,
    absentGraceMs: 30,
    timeoutMs: 60_000,
  });
  t.after(() => client.close());
  emit(await siteCatalog(site));
  const [catalog] = client.catalogs;
  peers.clear();
  await wait(60);
  const started = Date.now();
  await assert.rejects(
    client.callTool(catalog, "catalog.search_products", {}),
    /no longer connected|not active/u,
  );
  assert.ok(
    Date.now() - started < 1000,
    "fails at once, not after the 60 s timeout",
  );
});

test("an agent's cursor is labeled with its name when the room has one", async (t) => {
  const named = await makeWallet("Agent");
  const sent = [];
  const room = {
    wallet: { id: named.id, name: "ChatGPT agent A" },
    session: "agent-room-session",
    peers: new Map(),
    subscribe: () => () => {},
    async send(type, payload) {
      sent.push({ type, payload });
    },
  };
  const client = createAIAuthAgentClient(room);
  t.after(() => client.close());
  client.publishCursor({ x: 0.5, y: 0.5 });
  assert.equal(sent[0].type, "presence/cursor");
  const published = sent[0].payload;
  assert.equal(published.type, "ai-auth-cursor", "the agent publishes v1");
  assert.equal(published.v, 1);
  assert.equal(published.x, 500000, "0..1 fractions scale into the tracker range");
  assert.equal(published.y, 500000);
  assert.equal(published.pageKey, null, "no page argument means site-wide");
  assert.equal(published.seq, 1, "seq increments per sender");
  assert.equal(published.visible, true);
  assert.equal(published.label, "ChatGPT agent A");
  client.publishCursor({ x: 0.25, y: 0.75 });
  assert.equal(sent[1].payload.seq, 2, "each publish increments the sequence");

  const anonymous = { ...room, wallet: { id: named.id } };
  const other = createAIAuthAgentClient(anonymous);
  t.after(() => other.close());
  sent.length = 0;
  other.publishCursor({ x: 0.1, y: 0.2 });
  assert.equal(sent[0].payload.label, "Agent " + named.id.slice(6, 26));
});

test("an agent can scope its v1 cursor to a page and hide it", async (t) => {
  const agent = await makeWallet("Agent");
  const sent = [];
  const room = {
    wallet: agent,
    session: "agent-room-session",
    peers: new Map(),
    subscribe: () => () => {},
    async send(type, payload) {
      sent.push({ type, payload });
    },
  };
  const client = createAIAuthAgentClient(room);
  t.after(() => client.close());
  client.publishCursor({
    x: 0.5,
    y: 0.5,
    page: "/product?id=7",
    visible: false,
    scroll: 0.2,
  });
  const payload = sent[0].payload;
  assert.equal(payload.pageKey, "/product?id=7", "the optional page scopes the cursor");
  assert.equal(payload.visible, false);
  assert.equal(payload.scroll, 0.2);
  assert.throws(
    () => client.publishCursor({ x: 0.5, y: 0.5, page: "p".repeat(201) }),
    TypeError,
    "an invalid page key is rejected",
  );
});

test("a new peer receives the agent's current cursor and last activity without the agent moving", async (t) => {
  const agent = await makeWallet("Agent");
  const newcomer = await makeWallet("Visitor");
  const sent = [];
  const listeners = new Set();
  const room = {
    wallet: { id: agent.id, name: "ChatGPT agent A" },
    session: "agent-room-session",
    peers: new Map(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(type, payload) {
      sent.push({ type, payload });
    },
  };
  const deliver = (envelope) => {
    for (const listener of [...listeners])
      listener({ direction: "in", envelope });
  };
  const client = createAIAuthAgentClient(room);
  t.after(() => client.close());
  client.publishCursor({ x: 0.4, y: 0.7 });
  client.publishAction({
    name: "catalog.browse",
    state: "progress",
    summary: "Looking at glasses",
  });
  sent.length = 0;

  const hello = await newcomer.sign("peer/hello", {
    label: "Visitor",
    session: "visitor-session",
  });
  deliver(hello);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const types = sent.map((m) => m.type);
  assert.ok(
    types.includes("presence/cursor"),
    "the cursor is re-sent to the newcomer",
  );
  assert.ok(
    types.includes("agent/action"),
    "the last activity is re-sent to the newcomer",
  );
  const resent = sent.find((m) => m.type === "presence/cursor").payload;
  assert.equal(resent.type, "ai-auth-cursor", "late joiners get the v1 cursor");
  assert.equal(resent.x, 400000);

  sent.length = 0;
  deliver(hello);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    sent.length,
    0,
    "a repeated hello within the throttle window does not re-send",
  );
});
