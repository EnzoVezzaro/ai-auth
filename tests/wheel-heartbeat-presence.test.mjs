import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { signEnvelope } from "../packages/p2p/index.js";
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
  const issuer = await import("../packages/p2p/index.js").then((m) =>
    m.identityFor(publicKey),
  );
  return { id: issuer, name, publicKey, privateKey: keys.privateKey };
}

// Extract the real room subscriber from the wallet app so this test exercises
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
  const expression = source.slice(open, end + 1);
  const sandbox = vm.createContext({ console, ...context });
  return vm.runInContext(`(${expression})`, sandbox);
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

test("a verified peer heartbeating every 8s stays online in the wheel after 30s", async () => {
  const realNow = Date.now;
  const base = realNow();
  let now = base;
  Date.now = () => now;
  let dispose;
  try {
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
    const connection = { subscribe: () => () => {}, sendText() {} };
    const network = {
      connectionState: {
        status: "direct-peer-connected",
        directPeerCount: 1,
        peers: [{ peerId: "transport-peer" }],
      },
    };
    dispose = mountCollaborationWheel(connection, {
      target: doc.body,
      room,
      network,
    });
    const host = doc.body.children.find(
      (node) => node.dataset.aiAuthCollaborationWheel === "true",
    );
    const shadow = host.shadowRoot;
    const peersText = () =>
      [...shadow.querySelectorAll(".peers li")]
        .map((node) => node.textContent)
        .join(" | ");

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

    await deliver("peer/hello");
    assert.match(peersText(), /online \(verified key\)/u);
    for (let index = 0; index < 3; index += 1) {
      now += 8_000;
      await deliver("peer/heartbeat");
    }
    now += 6_000; // 30 s after the hello, with no other events
    room.poke();
    await flush();
    assert.match(
      peersText(),
      /online \(verified key\)/u,
      `a fresh heartbeat must keep the peer online; wheel shows: ${peersText()}`,
    );
  } finally {
    dispose?.();
    Date.now = realNow;
  }
});
