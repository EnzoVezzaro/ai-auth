import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  NonceGuard,
  createParticipationPolicy,
  createRevocation,
  issueExecutionGrant,
  issueMembership,
  randomNonce,
  approvePermissionRequest,
  createInstanceId,
  createPermissionRequest,
  identityFor,
  signEnvelope,
  verifyPermissionConsent,
} from "../packages/p2p/index.js";
import { connectAIAuthModal } from "../packages/p2p/embed.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const WALLET_ORIGIN = "https://wallet.example";
const ROOM = "research";
const CAPS = ["messages.send", "content.share", "presence.read"];
const settle = () => new Promise((r) => setTimeout(r, 15));

async function makeWallet(name = "Agent") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const identity = { id, name, publicKey, privateKey: pair.privateKey };
  return { ...identity, sign: (t, p) => signEnvelope(identity, t, p) };
}

const AGENT = (extra = {}) => ({
  instanceId: createInstanceId(),
  agentType: "coding-agent",
  runtime: { name: "node", version: "22" },
  provider: "acme",
  model: "model-x",
  ...extra,
});

// A fake browser window/document plus a fake wallet iframe. The test plays the
// wallet by delivering `message` events whose source is the iframe window.
function fakeBrowser() {
  const handlers = new Set();
  const sentToWallet = [];
  const popup = { postMessage: (data) => sentToWallet.push(data) };
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
    ...(tag === "iframe" ? { contentWindow: popup } : {}),
  });
  const win = {
    document: { body: node("body"), createElement: node },
    addEventListener: (type, fn) => type === "message" && handlers.add(fn),
    removeEventListener: (type, fn) => handlers.delete(fn),
  };
  const fromWallet = async (data, origin = WALLET_ORIGIN) => {
    for (const fn of [...handlers]) await fn({ source: popup, origin, data });
    await settle();
  };
  return { win, sentToWallet, fromWallet, handlerCount: () => handlers.size };
}

async function connect(
  t,
  { agent, features, walletOverride, caps = CAPS, participation } = {},
) {
  const b = fakeBrowser();
  const wallet = walletOverride ?? (await makeWallet());
  const pending = connectAIAuthModal({
    walletUrl: `${WALLET_ORIGIN}/`,
    capabilities: caps,
    room: ROOM,
    origin: ORIGIN,
    windowObject: b.win,
    ...(participation ? { participation } : {}),
    timeoutMs: 5_000,
  });
  pending.catch(() => {});
  await settle();
  await b.fromWallet({ type: "ai-auth/connect-ready" });
  const request = b.sentToWallet.find(
    (m) => m.type === "ai-auth/connect-request",
  ).request;
  return { b, wallet, request, pending, features, agent };
}

async function finish(t, ctx, consent, wallet = ctx.wallet) {
  await ctx.b.fromWallet({
    type: "ai-auth/connect-consent",
    requestNonce: ctx.request.nonce,
    consent,
    wallet: { id: wallet.id, name: wallet.name },
  });
  const connection = await ctx.pending;
  t.after(() => connection.close());
  return connection;
}

async function connected(t, options = {}) {
  const ctx = await connect(t, options);
  const consent = await approvePermissionRequest(
    ctx.wallet,
    ctx.request,
    options.caps ?? CAPS,
    options.agent === false ? {} : { agent: options.agent ?? AGENT() },
  );
  const connection = await finish(t, ctx, consent);
  if (options.features !== null)
    await ctx.b.fromWallet({
      type: "ai-auth/room-ready",
      requestNonce: ctx.request.nonce,
      walletId: ctx.wallet.id,
      session: "wallet-session-1",
      ...(options.features === undefined
        ? { features: { targets: true, receipts: true } }
        : { features: options.features }),
    });
  return { ...ctx, connection };
}

// ---- agent descriptor in the consent ---------------------------------------

test("a signed agent descriptor in the consent yields a verified participant with claims", async (t) => {
  const { connection, wallet } = await connected(t);
  assert.equal(connection.participant.identity.id, wallet.id);
  assert.equal(connection.participant.claims.provider, "acme");
  assert.equal(connection.participant.claimsAttested, false);
  const events = [];
  connection.onLifecycle((e) => events.push(e));
  assert.equal(events[0].participant.claims.model, "model-x");
  assert.deepEqual(events[0].diagnostics, []);
});

test("a consent without a descriptor still connects (0.4.x wallets) with no participant", async (t) => {
  const { connection } = await connected(t, { agent: false });
  assert.equal(connection.participant, null);
});

test("a descriptor for another wallet, nonce, or tampered claim rejects the connection", async (t) => {
  const evil = await makeWallet("Evil");
  const victim = await makeWallet("Victim");
  // 1. The consent is signed by `victim`, but the descriptor by `evil`.
  const ctx = await connect(t);
  const other = await approvePermissionRequest(evil, ctx.request, CAPS, {
    agent: AGENT(),
  });
  const swapped = await victim.sign("connect/consent", {
    ...other.body.payload,
  });
  await ctx.b.fromWallet({
    type: "ai-auth/connect-consent",
    consent: swapped,
    wallet: { id: victim.id, name: "Victim" },
  });
  await assert.rejects(ctx.pending, /could not be verified/u);
  assert.equal(ctx.b.handlerCount(), 0, "failed connection cleans up");

  // 2. A tampered claim breaks the descriptor signature.
  const ctx2 = await connect(t);
  const good = await approvePermissionRequest(ctx2.wallet, ctx2.request, CAPS, {
    agent: AGENT(),
  });
  const tampered = await ctx2.wallet.sign("connect/consent", {
    ...good.body.payload,
    agentDescriptor: { ...good.body.payload.agentDescriptor, model: "other" },
  });
  await ctx2.b.fromWallet({
    type: "ai-auth/connect-consent",
    consent: tampered,
    wallet: { id: ctx2.wallet.id, name: "x" },
  });
  await assert.rejects(ctx2.pending, /could not be verified/u);
});

test("verifyPermissionConsent rejects a descriptor on a legacy v1 consent and a wrong-room descriptor", async () => {
  const wallet = await makeWallet();
  const other = await createPermissionRequest(ORIGIN, CAPS, { room: "other" });
  const request = await createPermissionRequest(ORIGIN, CAPS, { room: ROOM });
  const wrongRoom = await approvePermissionRequest(wallet, other, CAPS, {
    agent: AGENT(),
  });
  const replayed = await wallet.sign("connect/consent", {
    ...wrongRoom.body.payload,
    requestNonce: request.nonce,
    room: ROOM,
    challengeExpiresAt: request.expiresAt,
  });
  const check = (consent) =>
    verifyPermissionConsent(consent, request, {
      expectedOrigin: ORIGIN,
      expectedWallet: wallet.id,
      nonceGuard: new NonceGuard(),
    });
  assert.equal(await check(replayed), false);
  const legacyBody = await wallet.sign("connect/consent", {
    audience: ORIGIN,
    requestNonce: request.nonce,
    capabilities: ["presence.read"],
    expiresAt: request.expiresAt,
    room: ROOM,
    agentDescriptor: (
      await approvePermissionRequest(wallet, request, CAPS, { agent: AGENT() })
    ).body.payload.agentDescriptor,
  });
  assert.equal(await check(legacyBody), false);
  // A plain, descriptor-free v2 consent keeps verifying.
  assert.equal(
    await check(await approvePermissionRequest(wallet, request, CAPS)),
    true,
  );
});

test("a fresh instance reports no clone diagnostics on the connected event", async (t) => {
  const { connection } = await connected(t);
  assert.equal(connection.participant.instanceId.startsWith("inst:"), true);
  const events = [];
  connection.onLifecycle((e) => events.push(e));
  assert.deepEqual(events[0].diagnostics, []);
});

// ---- postMessage proxy: targets and message ids -----------------------------

const MESSAGE_ID = "11111111-2222-4333-8444-555555555555";

test("sendText forwards a validated target and messageId to the wallet", async (t) => {
  const { b, connection } = await connected(t);
  const target = (await makeWallet()).id;
  const sending = connection.transfers.sendText("hello", {
    target,
    messageId: MESSAGE_ID,
  });
  await settle();
  const req = b.sentToWallet.findLast(
    (m) => m.type === "ai-auth/transfer-request",
  );
  assert.equal(req.method, "sendText");
  assert.deepEqual(req.args, ["hello", { messageId: MESSAGE_ID, target }]);
  await b.fromWallet({ type: "ai-auth/transfer-result", id: req.id });
  await sending;
});

test("sendElement and sendAttachment forward addressing; unknown options are dropped", async (t) => {
  const { b, connection } = await connected(t);
  const target = (await makeWallet()).id;
  const el = connection.transfers.sendElement(
    { tag: "p" },
    { target, evil: 1 },
  );
  await settle();
  const r1 = b.sentToWallet.findLast(
    (m) => m.type === "ai-auth/transfer-request",
  );
  assert.deepEqual(r1.args, [{ tag: "p" }, { target }]);
  await b.fromWallet({ type: "ai-auth/transfer-result", id: r1.id });
  await el;
  const blob = new Blob(["x"], { type: "image/png" });
  const att = connection.transfers.sendAttachment(blob, {
    kind: "screenshot",
    name: "s.png",
    messageId: MESSAGE_ID,
    extra: "dropped",
  });
  await settle();
  const r2 = b.sentToWallet.findLast(
    (m) => m.type === "ai-auth/transfer-request",
  );
  assert.deepEqual(r2.args[1], {
    messageId: MESSAGE_ID,
    kind: "screenshot",
    name: "s.png",
  });
  await b.fromWallet({ type: "ai-auth/transfer-result", id: r2.id });
  await att;
});

test("malformed or unsupported targets are rejected, never sent as public", async (t) => {
  const { b, connection } = await connected(t);
  const before = b.sentToWallet.length;
  await assert.rejects(
    connection.transfers.sendText("x", { target: "bob" }),
    /target/u,
  );
  await assert.rejects(
    connection.transfers.sendText("x", { messageId: "../etc" }),
    /message id/u,
  );
  await assert.rejects(connection.transfers.sendText("x", "target"), /object/u);
  await assert.rejects(
    connection.transfers.sendAttachment(new Blob(["x"]), {
      kind: "k",
      name: "n".repeat(500),
    }),
    /name/u,
  );
  assert.equal(b.sentToWallet.length, before, "nothing reached the wallet");
  // A wallet that never reported support cannot be asked to target.
  const old = await connected(t, { features: null });
  assert.equal(old.connection.supportsTargets, false);
  const target = (await makeWallet()).id;
  await assert.rejects(
    old.connection.transfers.sendText("x", { target }),
    /cannot deliver targeted/u,
  );
});

test("capability flags follow what the wallet reports", async (t) => {
  const full = await connected(t);
  assert.equal(full.connection.supportsTargets, true);
  assert.equal(full.connection.supportsReceipts, true);
  const none = await connected(t, {
    features: { targets: "yes", receipts: 1 },
  });
  assert.equal(none.connection.supportsTargets, false);
  assert.equal(none.connection.supportsReceipts, false);
});

test("receipts are forwarded only in their bounded shape for this wallet", async (t) => {
  const { b, connection, wallet } = await connected(t);
  const got = [];
  connection.transfers.subscribe((e) => got.push(e));
  const receiver = (await makeWallet()).id;
  const receipt = {
    messageId: MESSAGE_ID,
    sender: wallet.id,
    receiver,
    receivedAt: Date.now(),
    nonce: "n".repeat(24),
  };
  const send = (r) =>
    b.fromWallet({
      type: "ai-auth/transfer-event",
      transfer: { type: "receipt", receipt: r },
    });
  await send({ ...receipt, injected: true });
  await send({ ...receipt, sender: receiver });
  await send({ ...receipt, messageId: "bad" });
  await send({ ...receipt, nonce: "n".repeat(500) });
  await send(null);
  assert.equal(got.length, 0);
  await send(receipt);
  assert.deepEqual(got, [{ type: "receipt", receipt }]);
  // Without reported receipt support, receipts are dropped.
  const old = await connected(t, {
    features: { targets: true, receipts: false },
  });
  const seen = [];
  old.connection.transfers.subscribe((e) => seen.push(e));
  await old.b.fromWallet({
    type: "ai-auth/transfer-event",
    transfer: {
      type: "receipt",
      receipt: { ...receipt, sender: old.wallet.id },
    },
  });
  assert.equal(seen.length, 0);
});

// ---- inbound envelope identity binding --------------------------------------

// A peer announces itself over the room before its other events arrive. The
// wallet forwards that signed announcement like any other collaboration event.
async function announcePeer(ctx, session = "peer-session-1") {
  const peer = await makeWallet("Peer");
  await ctx.b.fromWallet({
    type: "ai-auth/collaboration-event",
    envelope: await peer.sign("peer/hello", {
      label: "Peer",
      room: ROOM,
      origin: ORIGIN,
      session,
      nonce: randomNonce(),
      expiresAt: Date.now() + 60_000,
    }),
  });
  return { peer, session };
}

const textFrom = (signer, session) =>
  signer.sign("message/text", {
    text: "hello",
    room: ROOM,
    origin: ORIGIN,
    session,
    nonce: randomNonce(),
    expiresAt: Date.now() + 60_000,
  });

test("inbound events must come from the issuer bound to the peer's session", async (t) => {
  const ctx = await connected(t);
  const received = [];
  ctx.connection.onEvent((e) => received.push(e));
  const { peer, session } = await announcePeer(ctx);
  received.length = 0;

  await ctx.b.fromWallet({
    type: "ai-auth/collaboration-event",
    envelope: await textFrom(peer, session),
  });
  assert.equal(
    received.length,
    1,
    "an announced peer's signed event is accepted",
  );

  const forged = await makeWallet("Forged");
  await ctx.b.fromWallet({
    type: "ai-auth/collaboration-event",
    envelope: await textFrom(forged, "unannounced-session"),
  });
  assert.equal(received.length, 1, "a fabricated issuer is dropped");

  await ctx.b.fromWallet({
    type: "ai-auth/collaboration-event",
    envelope: await textFrom(peer, "stale-session"),
  });
  assert.equal(received.length, 1, "an old session of a known peer is dropped");

  await ctx.b.fromWallet({
    type: "ai-auth/collaboration-event",
    envelope: await textFrom(forged, session),
  });
  assert.equal(
    received.length,
    1,
    "another issuer cannot reuse a known session",
  );

  await ctx.b.fromWallet({
    type: "ai-auth/collaboration-event",
    envelope: await textFrom(forged, "wallet-session-1"),
  });
  assert.equal(
    received.length,
    1,
    "the wallet's live session stays bound to its verified identity",
  );
});

// ---- protected tool execution: fail closed ---------------------------------

async function authorizedWorld(t) {
  const host = await makeWallet("Host");
  const remote = await makeWallet("Remote");
  const policy = createParticipationPolicy({
    mode: "restricted",
    trustPolicy: { issuers: [host.publicKey] },
    origin: ORIGIN,
    room: ROOM,
  });
  const membership = await issueMembership(host, {
    subject: remote.id,
    origin: ORIGIN,
    room: ROOM,
    scopes: ["presence.read", "tools.invoke"],
  });
  assert.equal((await policy.admit(remote.id, membership)).ok, true);
  const grant = await issueExecutionGrant(host, {
    subject: remote.id,
    origin: ORIGIN,
    room: ROOM,
    membershipId: membership.id,
    scopes: ["tools.invoke"],
  });
  assert.equal((await policy.admitGrant(remote.id, grant)).ok, true);
  const caps = ["tools.invoke", "presence.read"];
  const ctx = await connected(t, { caps, participation: { policy } });
  const requests = [];
  ctx.connection.onEvent((e) => requests.push(e));
  // The remote peer announces its room session before it invokes tools.
  await ctx.b.fromWallet({
    type: "ai-auth/collaboration-event",
    envelope: await remote.sign("peer/hello", {
      label: "Remote",
      room: ROOM,
      origin: ORIGIN,
      session: "remote-session-1",
      nonce: randomNonce(),
      expiresAt: Date.now() + 60_000,
    }),
  });
  requests.length = 0;
  let n = 0;
  const toolRequest = async (wallet = remote) => {
    const envelope = await signEnvelope(wallet, "agent/action", {
      kind: "tool-request",
      requestId: `request-${++n}-abcdefgh`,
      name: "page.echo",
      input: {},
      targetWallet: ctx.wallet.id,
      targetNonce: ctx.request.nonce,
      targetSession: "wallet-session-1",
      room: ROOM,
      origin: ORIGIN,
      session: "remote-session-1",
      nonce: randomNonce(),
      expiresAt: Date.now() + 60_000,
    });
    await ctx.b.fromWallet({
      type: "ai-auth/collaboration-event",
      envelope,
    });
  };
  return { ...ctx, host, remote, policy, requests, toolRequest };
}

test("an authorized identity's tool request reaches listeners", async (t) => {
  const w = await authorizedWorld(t);
  await w.toolRequest();
  assert.equal(w.requests.length, 1);
  assert.equal(
    w.connection.participation.authorizeProtected(w.remote.id).allow,
    true,
  );
});

test("a revoked identity cannot invoke after the revocation arrives", async (t) => {
  const w = await authorizedWorld(t);
  await w.toolRequest();
  assert.equal(w.requests.length, 1);
  const record = await createRevocation(w.host, {
    kind: "wallet",
    target: w.remote.id,
    origin: ORIGIN,
    room: ROOM,
  });
  assert.equal((await w.policy.applyRevocation(record)).applied, true);
  await w.toolRequest();
  await w.toolRequest();
  assert.equal(w.requests.length, 1, "no further request reaches a tool layer");
  assert.equal(
    w.connection.participation.authorizeProtected(w.remote.id).reason,
    "revoked",
  );
});

test("an unknown identity and a stale epoch are denied; a bad policy option is refused", async (t) => {
  const w = await authorizedWorld(t);
  const stranger = await makeWallet("Stranger");
  await w.toolRequest(stranger);
  assert.equal(w.requests.length, 0);
  w.policy.bumpEpoch();
  await w.toolRequest();
  assert.equal(w.requests.length, 0);
  assert.equal(
    w.connection.participation.authorizeProtected(w.remote.id).allow,
    false,
  );
  await assert.rejects(
    connectAIAuthModal({
      walletUrl: `${WALLET_ORIGIN}/`,
      capabilities: CAPS,
      origin: ORIGIN,
      participation: {},
    }),
    /participation policy/u,
  );
});

test("without a participation policy the connection reports none", async (t) => {
  const { connection } = await connected(t);
  assert.equal(connection.participation, null);
});
