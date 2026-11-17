import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { identityFor, RECEIPT_TYPE } from "../packages/p2p/index.js";
import { P2PRoom } from "../packages/p2p/p2p.js";
import { CollaborationTransfers } from "../packages/p2p/collaboration.js";
import { mountCollaborationWheel } from "../packages/p2p/collaboration-wheel.js";
import { createAgentBridge } from "../packages/mcp/bridge.js";
import { createStubDom } from "./dom-stub.mjs";

globalThis.crypto ??= webcrypto;
globalThis.Option ??= class {
  constructor(text, value) {
    this.textContent = text;
    this.value = value;
  }
};

const ORIGIN = "https://example.test";
const CAPABILITIES = ["messages.send", "content.share"];

async function wallet(name) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    id: await identityFor(publicKey),
    name,
    publicKey,
    privateKey: keys.privateKey,
  };
}

// Two real rooms wired directly, with real signing/verification and receipts.
async function pair(t) {
  const human = new P2PRoom(await wallet("human"), "chat", {
    origin: ORIGIN,
    capabilities: CAPABILITIES,
  });
  const agent = new P2PRoom(await wallet("agent"), "chat", {
    origin: ORIGIN,
    capabilities: CAPABILITIES,
  });
  human.directPeerCount = 1;
  agent.directPeerCount = 1;
  const jobs = new Set();
  for (const [from, to] of [
    [human, agent],
    [agent, human],
  ])
    from.subscribe(({ direction, envelope }) => {
      if (direction !== "out") return;
      const job = to.receive(envelope);
      jobs.add(job);
      job.finally(() => jobs.delete(job));
    });
  t.after(async () => {
    await Promise.all([human.close(), agent.close()]);
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.all([...jobs]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { human, agent, settle };
}

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition not reached");
};

// A real wheel mounted on `room`, with a verified recipient entry for `peer`.
async function mountWheel(t, room, peer) {
  const { doc } = createStubDom();
  const transfers = new CollaborationTransfers(room);
  room.peers.set(`${peer.wallet.id}:${room.session ?? "peer"}`, {
    id: peer.wallet.id,
    publicKey: peer.wallet.publicKey,
    seenAt: Date.now(),
  });
  const dispose = mountCollaborationWheel(transfers, {
    target: doc.body,
    room,
    network: {
      connectionState: {
        status: "direct-peer-connected",
        directPeerCount: 1,
        peers: [],
      },
    },
  });
  const host = doc.body.children.find(
    (node) => node.dataset.aiAuthCollaborationWheel === "true",
  );
  t.after(() => {
    dispose();
    transfers.close();
  });
  return { shadow: host.shadowRoot, transfers };
}

function runtimeForRoom(room, listeners) {
  return {
    connectionState: {
      status: "direct-peer-connected",
      connected: true,
      generation: room.session,
      authorization: "active",
      directPeerCount: 1,
      diagnostics: {},
    },
    identity: room.wallet,
    room: "chat",
    origin: room.origin,
    capabilities: [...room.capabilities],
    agentRoom: room,
    peers: () => [],
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    send: (type, payload, options) => room.send(type, payload, options),
  };
}

test("legacy message/text from an old agent is shown in the wheel log", async (t) => {
  const { human, agent, settle } = await pair(t);
  const { shadow } = await mountWheel(t, human, agent);
  const log = () => shadow.querySelector(".log").textContent;
  await agent.send("message/text", { text: "legacy hello" });
  await settle();
  await until(() => log().includes("legacy hello"));
  assert.match(log(), /legacy hello/u);
});

test("a collab/text sent through ai_auth_send appears in the wheel log", async (t) => {
  const { human, agent, settle } = await pair(t);
  const { shadow } = await mountWheel(t, human, agent);
  const bridge = createAgentBridge({
    runtime: runtimeForRoom(agent, new Set()),
    clientFactory: () => ({}),
  });
  const result = await bridge.send({
    text: "from the agent",
    to: human.wallet.id,
  });
  assert.match(result.messageId, /^[a-f0-9-]{36}$/u);
  assert.equal(result.state, "sent-to-transport");
  await settle();
  await until(() =>
    shadow.querySelector(".log").textContent.includes("from the agent"),
  );
  assert.match(
    shadow.querySelector(".log").textContent,
    /from the agent/u,
  );
});

test("a targeted wheel message reaches the agent and the sender sees a receipt", async (t) => {
  const { human, agent, settle } = await pair(t);
  const { shadow } = await mountWheel(t, human, agent);
  const agentTransfers = new CollaborationTransfers(agent);
  t.after(() => agentTransfers.close());
  const received = [];
  agentTransfers.subscribe((event) => received.push(event));

  const recipient = shadow.querySelector(".recipient");
  await until(() =>
    [...recipient.children].some((option) => option.value === agent.wallet.id),
  );
  recipient.value = agent.wallet.id;
  recipient.dispatch("change");
  shadow.querySelector("input").value = "hello agent";
  shadow.querySelector("form").dispatch("submit");

  await settle();
  await until(() =>
    received.some((event) => event.type === "text" && event.text === "hello agent"),
  );
  await until(() =>
    shadow.querySelector(".log").textContent.includes("Signed receipt"),
  );
  assert.match(
    shadow.querySelector(".log").textContent,
    /Signed receipt/u,
  );
});

test("ai_auth_events surfaces peer chat and a receipt for the agent's own message", async (t) => {
  const { human, agent, settle } = await pair(t);
  const { transfers } = await mountWheel(t, human, agent);
  const listeners = new Set();
  agent.subscribe(({ direction, envelope }) => {
    if (direction === "in") for (const fn of listeners) fn({ direction, envelope });
  });
  const bridge = createAgentBridge({
    runtime: runtimeForRoom(agent, listeners),
    clientFactory: () => ({}),
  });

  const sent = await bridge.send({ text: "ping", to: human.wallet.id });
  await settle();
  await until(() =>
    bridge
      .events({})
      .events.some(
        (event) =>
          event.type === RECEIPT_TYPE && event.messageId === sent.messageId,
      ),
  );
  await transfers.sendText("reply from human", { target: agent.wallet.id });
  await settle();
  await until(() =>
    bridge
      .events({})
      .events.some(
        (event) => event.type === "collab/text" && event.payload?.text === "reply from human",
      ),
  );
  const events = bridge.events({}).events;
  assert.ok(
    events.some(
      (event) =>
        event.type === RECEIPT_TYPE &&
        event.messageId === sent.messageId &&
        event.receiver === human.wallet.id,
    ),
  );
});
