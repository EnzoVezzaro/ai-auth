import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  createInstanceId,
  createPermissionRequest,
  identityFor,
  signEnvelope,
} from "../packages/p2p/index.js";
import {
  createSessionStore,
  recordFromConsent,
} from "../packages/p2p/session-store.js";
import { resumeAIAuthSession } from "../packages/p2p/embed.js";
import { memoryStorage } from "./helpers/app-source.mjs";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const OTHER_ORIGIN = "https://other.example";
const ROOM = "research";
const CAPS = ["messages.send", "presence.read"];

async function makeGrant() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const wallet = {
    id,
    name: "Agent",
    publicKey,
    privateKey: pair.privateKey,
    sign: (type, payload) => signEnvelope(wallet, type, payload),
  };
  const request = await createPermissionRequest(ORIGIN, CAPS, {
    room: ROOM,
    expiresInMs: 120_000,
    sessionTtlMs: 30 * 60_000,
    idleTimeoutMs: 10 * 60_000,
  });
  const consent = await approvePermissionRequest(wallet, request, CAPS, {
    agent: {
      instanceId: createInstanceId(),
      agentType: "coding-agent",
      runtime: { name: "node", version: "22" },
      provider: "acme",
      model: "x",
    },
  });
  const instanceId = createInstanceId();
  return {
    record: recordFromConsent(consent, {
      origin: ORIGIN,
      room: ROOM,
      participant: {
        instanceId,
        sessionId: consent.body.payload.requestNonce,
      },
    }),
  };
}

function fakeBrowser() {
  const handlers = new Set();
  const node = (tag) => ({
    tag,
    style: {},
    setAttribute() {},
    append() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    showModal() {},
    close() {},
    ...(tag === "iframe" ? { contentWindow: { postMessage() {} } } : {}),
  });
  return {
    win: {
      document: { body: node("body"), createElement: node },
      addEventListener: (type, fn) => type === "message" && handlers.add(fn),
      removeEventListener: (type, fn) => handlers.delete(fn),
    },
    handlerCount: () => handlers.size,
  };
}

function options(browser, record) {
  return {
    walletUrl: "https://wallet.example/",
    origin: ORIGIN,
    room: ROOM,
    capabilities: CAPS,
    windowObject: browser.win,
    sessionStore: createSessionStore({ storage: memoryStorage() }),
    record,
    timeoutMs: 5_000,
    resumeTimeoutMs: 5_000,
  };
}

test("a supplied resume record from another origin is rejected", async () => {
  const { record } = await makeGrant();
  const browser = fakeBrowser();
  const foreign = { ...record, audience: OTHER_ORIGIN };
  const pending = resumeAIAuthSession(options(browser, foreign));
  const rejection = assert.rejects(pending, /origin|audience|record/u);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    browser.handlerCount(),
    0,
    "no wallet dialog is opened for a foreign record",
  );
  await rejection;
});

test("a supplied resume record for this origin is accepted", async () => {
  const { record } = await makeGrant();
  const browser = fakeBrowser();
  const pending = resumeAIAuthSession(options(browser, record));
  pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(browser.handlerCount() > 0, "the wallet dialog is opened");
  pending.catch(() => {});
});
