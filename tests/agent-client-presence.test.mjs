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
  assert.equal(sent[0].payload.label, "ChatGPT agent A");

  const anonymous = { ...room, wallet: { id: named.id } };
  const other = createAIAuthAgentClient(anonymous);
  t.after(() => other.close());
  sent.length = 0;
  other.publishCursor({ x: 0.1, y: 0.2 });
  assert.equal(sent[0].payload.label, "Agent " + named.id.slice(6, 26));
});
