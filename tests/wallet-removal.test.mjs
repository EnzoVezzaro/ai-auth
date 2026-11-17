import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import {
  approvePermissionRequest,
  createInstanceId,
  createPermissionRequest,
  forgetWallet,
  identityFor,
  signEnvelope,
} from "../packages/p2p/index.js";
import {
  createGrantStore,
  indexedDbGrantAdapter,
} from "../packages/p2p/grant-store.js";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const source = await appSource();

async function makeWallet() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const wallet = { id, name: "Agent", publicKey, privateKey: pair.privateKey };
  return {
    ...wallet,
    sign: (type, payload) => signEnvelope(wallet, type, payload),
  };
}

async function saveGrant() {
  const wallet = await makeWallet();
  const request = await createPermissionRequest(ORIGIN, ["messages.send"], {
    room: "research",
    sessionTtlMs: 30 * 60_000,
  });
  const consent = await approvePermissionRequest(
    wallet,
    request,
    ["messages.send"],
    {
      agent: {
        instanceId: createInstanceId(),
        agentType: "coding-agent",
        runtime: { name: "node", version: "22" },
        provider: "acme",
        model: "x",
      },
    },
  );
  const store = createGrantStore({ adapter: indexedDbGrantAdapter() });
  await store.save(consent, { audience: ORIGIN, room: "research" });
  return { wallet, nonce: consent.body.payload.requestNonce };
}

test("forgetWallet clears stored grant records with the wallet activity", async () => {
  globalThis.indexedDB = new IDBFactory();
  const { wallet, nonce } = await saveGrant();
  const before = createGrantStore({ adapter: indexedDbGrantAdapter() });
  assert.ok(await before.get(ORIGIN, nonce), "the grant exists before removal");

  await forgetWallet();

  const after = createGrantStore({ adapter: indexedDbGrantAdapter() });
  assert.equal(
    await after.get(ORIGIN, nonce),
    null,
    "removing the wallet also forgets its durable grants",
  );
});

test("the wallet page's Remove action closes the rtc connection too", async () => {
  const closed = [];
  const calls = [];
  const state = {
    wallet: { id: "agent:test" },
    room: { close: async () => closed.push("room") },
    rtc: { close: async () => closed.push("rtc") },
    activity: [{ type: "wallet/created" }],
    view: "wallet",
    error: "",
  };
  const nodes = new Map();
  const handlers = new Map();
  const node = (selector) => ({
    addEventListener: (type, fn) => {
      if (!handlers.has(selector)) handlers.set(selector, new Map());
      handlers.get(selector).set(type, fn);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const sandbox = runFragment(extractFunction(source, "bindView"), {
    console,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    $: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, node(selector));
      return nodes.get(selector);
    },
    rootViewButtons: () => {},
    window: { confirm: () => true },
    state,
    forgetWallet: async () => calls.push("forgetWallet"),
    render: () => calls.push("render"),
    toast: (message) => calls.push(message),
  });
  sandbox.bindView();

  const handler = handlers.get("#forget-wallet")?.get("click");
  assert.ok(handler, "the Remove wallet click handler is registered");
  await handler();

  assert.deepEqual(closed, ["room", "rtc"], "both the room and rtc are closed");
  assert.ok(calls.includes("forgetWallet"), "the wallet data is forgotten");
  assert.equal(state.activity.length, 0, "the activity list is cleared");
  assert.equal(state.room, null);
  assert.equal(state.rtc, null);
});
