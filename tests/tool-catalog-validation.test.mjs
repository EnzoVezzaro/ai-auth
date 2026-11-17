import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  connectAIAuthModal,
  identityFor,
  signEnvelope,
} from "../packages/p2p/index.js";
import {
  TOOL_NAME_PATTERN,
  filterCatalogTools,
} from "../packages/p2p/webmcp.js";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const WALLET_ORIGIN = "https://wallet.example";
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

async function makeWallet() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const identity = { id, name: "Wallet", publicKey, privateKey: pair.privateKey };
  return { ...identity, sign: (type, payload) => signEnvelope(identity, type, payload) };
}

// Real connectAIAuthModal flow: the wallet side of the publish path.
async function connected(t) {
  const handlers = new Set();
  const sent = [];
  const popup = { postMessage: (data) => sent.push(data) };
  const node = (tag) => ({
    style: {},
    setAttribute() {},
    append() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    showModal() {},
    close() {},
    ...(tag === "iframe" ? { contentWindow: popup } : {}),
  });
  const win = {
    document: { body: node("body"), createElement: node },
    addEventListener: (type, fn) => type === "message" && handlers.add(fn),
    removeEventListener: (type, fn) => handlers.delete(fn),
  };
  const wallet = await makeWallet();
  const caps = ["tools.invoke"];
  const pending = connectAIAuthModal({
    walletUrl: `${WALLET_ORIGIN}/`,
    capabilities: caps,
    room: "research",
    origin: ORIGIN,
    windowObject: win,
    timeoutMs: 5_000,
  });
  pending.catch(() => {});
  await settle();
  const fromWallet = async (data) => {
    for (const fn of [...handlers])
      await fn({ source: popup, origin: WALLET_ORIGIN, data });
  };
  await fromWallet({ type: "ai-auth/connect-ready" });
  const request = sent.find((m) => m.type === "ai-auth/connect-request").request;
  const consent = await approvePermissionRequest(wallet, request, caps);
  await fromWallet({
    type: "ai-auth/connect-consent",
    requestNonce: request.nonce,
    consent,
    wallet: { id: wallet.id, name: wallet.name },
  });
  const connection = await pending;
  t.after(() => connection.close());
  return { connection, sent };
}

// Runs the wallet's real site-event handler with controlled state.
async function walletHandler() {
  const sent = [];
  const debugCalls = [];
  const source = await appSource();
  const env = {
    state: {
      consent: { body: { payload: { capabilities: ["tools.invoke"] } } },
      wallet: { id: "agent:wallet", name: "Wallet" },
      room: {
        session: "wallet-session",
        send: async (...args) => {
          sent.push(args);
        },
      },
      externalRequest: { nonce: "n".repeat(24) },
    },
    debug: (...args) => debugCalls.push(args),
    externalSessionActive: () => true,
    TOOL_NAME_PATTERN,
    filterCatalogTools,
    TextEncoder,
  };
  const sandbox = runFragment(
    `${extractFunction(source, "handleExternalSiteEvent")}\n` +
      "globalThis.run = handleExternalSiteEvent;",
    env,
  );
  return { run: sandbox.run, sent, debugCalls };
}

test("CT-02: the publish path accepts a mixed-case name the SDK allows", async (t) => {
  const { connection, sent } = await connected(t);
  assert.doesNotThrow(() =>
    connection.publishAction({
      name: "MyTool",
      state: "started",
      summary: "Started MyTool",
    }),
  );
  await settle();
  const published = sent.find((m) => m.type === "ai-auth/site-action");
  assert.ok(published, "the action event is shared with the wallet");
  assert.equal(published.action.name, "MyTool");
});

test("CT-02: the wallet forwards an SDK-valid mixed-case action name", async () => {
  const { run, sent } = await walletHandler();
  await run({
    type: "ai-auth/site-action",
    action: { name: "MyTool", state: "started", summary: "go" },
  });
  assert.equal(sent.length, 1, "the signed action reaches the room");
  assert.equal(sent[0][1].name, "MyTool");
});

test("CT-03: one invalid tool is skipped, not the whole catalog", async () => {
  const { run, sent, debugCalls } = await walletHandler();
  await run({
    type: "ai-auth/site-agent-event",
    event: {
      kind: "tool-catalog",
      tools: [
        { name: "good.one", description: "ok", inputSchema: { type: "object" } },
        { name: "bad name", description: "ok", inputSchema: { type: "object" } },
        { name: "bool.schema", description: "ok", inputSchema: true },
        { name: "no.props", description: "ok", inputSchema: { type: "object" } },
      ],
    },
  });
  assert.equal(sent.length, 1, "the remaining tools are still published");
  assert.deepEqual(
    sent[0][1].tools.map((tool) => tool.name),
    ["good.one", "bool.schema", "no.props"],
  );
  const skipped = debugCalls.filter((call) => call[0] === "wallet-skipped-tool");
  assert.deepEqual(
    skipped.map((call) => call[1]),
    ["bad name"],
    "the skipped tool is reported",
  );
});
