import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { identityFor, signEnvelope } from "../packages/p2p/index.js";
import { mountCollaborationWheel } from "../packages/p2p/collaboration-wheel.js";
import { appSource } from "./helpers/app-source.mjs";
import { createStubDom } from "./dom-stub.mjs";

globalThis.crypto ??= webcrypto;
globalThis.Option ??= class {
  constructor(text, value) {
    this.textContent = text;
    this.value = value;
  }
};

const flush = async () => {
  for (let i = 0; i < 8; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

async function makeWallet(name) {
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

// Extract the real room subscriber from the wallet app so these tests exercise
// the same forwarding path the site uses, not a hand-written imitation of it.
async function walletRoomForwarder(context) {
  const source = await appSource();
  const marker = "state.room.subscribe(";
  const at = source.indexOf(marker);
  assert.ok(at >= 0, "the wallet app subscribes to its room");
  const open = at + marker.length - 1;
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if ("({[".includes(char)) depth += 1;
    else if (")}]".includes(char)) {
      depth -= 1;
      if (depth === 0 && char === ")") {
        end = index;
        break;
      }
    }
  }
  assert.ok(end > open, "the room subscriber is a complete expression");
  const sandbox = vm.createContext({ console, ...context });
  return vm.runInContext(`(${source.slice(open, end + 1)})`, sandbox);
}

// Mirrors the site's P2PRoom-like peer source: only signed presence envelopes
// that reach the site can refresh a peer's seenAt.
function createPeerSource(selfId) {
  const peers = new Map();
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener({ peers });
  };
  return {
    peers,
    wallet: { id: selfId },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // The wheel's own 5 s sweep asks the peer source again; a fake clock does
    // not advance real timers, so the test triggers that sweep explicitly.
    poke() {
      notify();
    },
    record(envelope) {
      const type = envelope?.body?.type;
      if (
        type !== "peer/hello" &&
        type !== "peer/heartbeat" &&
        type !== "peer/goodbye"
      )
        return false;
      const id = envelope.body.issuer;
      const session = envelope.body.payload?.session;
      if (typeof id !== "string" || !id) return false;
      if (typeof session !== "string" || !session) return false;
      const key = `${id}:${session}`;
      if (type === "peer/goodbye") {
        if (!peers.delete(key)) return false;
        notify();
        return true;
      }
      if (id === selfId) return false;
      const publicKey = envelope.proof?.publicKey;
      if (!publicKey || typeof publicKey !== "object") return false;
      peers.set(key, { id, publicKey, seenAt: Date.now() });
      notify();
      return true;
    },
  };
}

async function setupWheel() {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const visitor = await makeWallet("visitor");
  const agent = await makeWallet("agent");
  const session = "agent-session-0001";
  const origin = "https://site.example";
  const siteListeners = new Set();
  const externalHost = {
    postMessage(message) {
      if (message?.type === "ai-auth/collaboration-event")
        for (const listener of siteListeners) listener(message.envelope);
    },
  };
  const state = {
    view: "overview",
    wallet: visitor,
    messages: [],
    activity: [],
    room: { peers: new Map(), session, wallet: visitor },
    externalSource: externalHost,
    externalOrigin: origin,
    externalRequest: { audience: origin },
    lease: { touch() {} },
  };
  const forward = await walletRoomForwarder({
    state,
    externalHost,
    touchGrant() {},
    externalConnectMode: true,
    externalSessionActive: () => true,
    debug() {},
    toast() {},
    $: () => null,
    appendActivity: async () => {},
    readActivity: async () => [],
    render() {},
  });
  const room = createPeerSource(visitor.id);
  siteListeners.add((envelope) => room.record(envelope));

  const { doc } = createStubDom({});
  const sent = [];
  const connection = {
    supportsTargets: true,
    subscribe: () => () => {},
    sendText: async (text, options) => sent.push({ text, options }),
  };
  const network = {
    connectionState: {
      status: "direct-peer-connected",
      directPeerCount: 1,
      peers: [{ peerId: "transport-peer" }],
    },
  };
  const dispose = mountCollaborationWheel(connection, {
    target: doc.body,
    room,
    network,
  });
  const host = doc.body.children.find(
    (node) => node.dataset.aiAuthCollaborationWheel === "true",
  );
  const shadow = host.shadowRoot;
  const deliver = async (type) => {
    const envelope = await signEnvelope(agent, type, {
      label: "QA Agent",
      room: "default",
      origin,
      session,
      nonce: `${type}-${now}-${Math.random()}`,
      expiresAt: now + 100_000,
    });
    forward({ direction: "in", envelope });
    await flush();
  };
  const advance = async (ms) => {
    now += ms;
    room.poke();
    await flush();
  };
  return {
    agent,
    shadow,
    connection,
    sent,
    deliver,
    advance,
    close() {
      dispose();
      Date.now = realNow;
    },
  };
}

test("a verified peer heartbeating every 8s stays online in the wheel after 30s", async () => {
  const wheel = await setupWheel();
  try {
    const peersText = () =>
      [...wheel.shadow.querySelectorAll(".peers li")]
        .map((node) => node.textContent)
        .join(" | ");
    await wheel.deliver("peer/hello");
    assert.match(peersText(), /online \(verified key\)/u);
    for (let index = 0; index < 3; index += 1) {
      await wheel.advance(8_000);
      await wheel.deliver("peer/heartbeat");
    }
    await wheel.advance(6_000); // 30 s after the hello, no other events
    assert.match(
      peersText(),
      /online \(verified key\)/u,
      `a fresh heartbeat must keep the peer online; wheel shows: ${peersText()}`,
    );
  } finally {
    wheel.close();
  }
});

test("an addressed send to a freshly heartbeating peer is not blocked", async () => {
  const wheel = await setupWheel();
  try {
    await wheel.deliver("peer/hello");
    for (let index = 0; index < 3; index += 1) {
      await wheel.advance(8_000);
      await wheel.deliver("peer/heartbeat");
    }
    await wheel.advance(6_000); // 30 s: online only because heartbeats are fresh

    const recipient = wheel.shadow.querySelector(".recipient");
    assert.ok(
      recipient.children.some((option) => option.value === wheel.agent.id),
      "the verified peer is offered as an addressed recipient",
    );
    recipient.value = wheel.agent.id;
    recipient.dispatch("change");
    await flush();
    const hint = wheel.shadow.querySelector(".hint").textContent;
    assert.doesNotMatch(
      hint,
      /offline/u,
      `a fresh peer must not block an addressed send; hint: ${hint}`,
    );
    assert.equal(wheel.shadow.querySelector(".send").disabled, false);

    const input = wheel.shadow.querySelector("input");
    input.value = "Hello from the visitor";
    wheel.shadow.querySelector("form").dispatch("submit");
    await flush();
    assert.equal(wheel.sent.length, 1, "the addressed message is sent");
    assert.equal(wheel.sent[0].options.target, wheel.agent.id);
  } finally {
    wheel.close();
  }
});
