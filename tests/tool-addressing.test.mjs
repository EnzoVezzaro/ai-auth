import test from "node:test";
import assert from "node:assert/strict";
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
    publicKey,
    privateKey: keys.privateKey,
    sign: (type, payload) =>
      signEnvelope(
        { id, publicKey, privateKey: keys.privateKey },
        type,
        payload,
      ),
  };
}

// A room double that records the addressing options each send is given.
function makeAgentRoom(agent) {
  const listeners = new Set();
  const sent = [];
  const room = {
    wallet: agent,
    session: "agent-room-session",
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(type, payload, options) {
      sent.push({ type, payload, options });
    },
  };
  const emit = (envelope) => {
    for (const listener of [...listeners])
      listener({ direction: "in", envelope });
  };
  return { room, sent, emit };
}

async function siteCatalog(site) {
  return site.sign("agent/action", {
    kind: "tool-catalog",
    tools: [
      {
        name: "site.search",
        description: "Read public data.",
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
    expiresAt: Date.now() + 30_000,
  });
}

test("a tool request is addressed to the site that serves the tool", async (t) => {
  const site = await makeWallet("Site wallet");
  const agent = await makeWallet("Agent wallet");
  const { room, sent, emit } = makeAgentRoom(agent);
  const client = createAIAuthAgentClient(room);
  t.after(() => client.close());
  emit(await siteCatalog(site));
  const [catalog] = client.catalogs;
  // Do not wait for a reply: only the outgoing request matters here.
  void client.callTool(catalog, "site.search", {}).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const request = sent.find((item) => item.payload?.kind === "tool-request");
  assert.ok(request, "the request is sent");
  assert.deepEqual(
    request.options,
    { to: site.id },
    "only the serving site is addressed, so other peers do not receive it",
  );
});
