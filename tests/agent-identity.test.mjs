import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  bindInstance,
  createAgentDescriptor,
  createCloneDetector,
  createInstanceId,
  identityFor,
  verifyAgentDescriptor,
  verifyInstanceBinding,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const ROOM = "research";
const NONCE = "nonce-0123456789abcdef";
const NOW = 1_800_000_000_000;

async function makeWallet() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    id: await identityFor(publicKey),
    publicKey,
    privateKey: keys.privateKey,
  };
}

const base = (instanceId, extra = {}) => ({
  instanceId,
  agentType: "coding-agent",
  runtime: { name: "node", version: "22" },
  provider: "acme",
  model: "model-x",
  sessionId: "session-12345678",
  origin: ORIGIN,
  room: ROOM,
  capabilities: ["messages.send"],
  nonce: NONCE,
  now: NOW,
  ...extra,
});
const expectations = (extra = {}) => ({
  expectedOrigin: ORIGIN,
  expectedRoom: ROOM,
  expectedNonce: NONCE,
  now: NOW + 1000,
  ...extra,
});

test("a valid descriptor verifies and labels provider/model as claims", async () => {
  const wallet = await makeWallet();
  const d = await createAgentDescriptor(wallet, base(createInstanceId()));
  assert.equal(d.type, "ai-auth-agent-descriptor");
  assert.equal(d.v, 1);
  assert.equal(d.walletId, wallet.id);
  const r = await verifyAgentDescriptor(d, expectations());
  assert.equal(r.ok, true);
  assert.equal(r.walletId, wallet.id);
  assert.equal(r.claims.provider, "acme");
});

test("a forged descriptor (signed by another key) is rejected", async () => {
  const wallet = await makeWallet();
  const attacker = await makeWallet();
  const d = await createAgentDescriptor(wallet, base(createInstanceId()));
  const forged = await createAgentDescriptor(attacker, base(d.instanceId));
  // Present the attacker's signature under the victim's identity.
  const swapped = { ...d, signature: forged.signature };
  assert.equal(
    (await verifyAgentDescriptor(swapped, expectations())).reason,
    "bad-signature",
  );
  // Present the victim's id with the attacker's key.
  const spoof = { ...forged, walletId: wallet.id };
  assert.equal(
    (await verifyAgentDescriptor(spoof, expectations())).reason,
    "wallet-mismatch",
  );
});

test("wrong origin, room, nonce, and missing expectations are rejected", async () => {
  const wallet = await makeWallet();
  const d = await createAgentDescriptor(wallet, base(createInstanceId()));
  const why = async (opts) =>
    (await verifyAgentDescriptor(d, expectations(opts))).reason;
  assert.equal(
    await why({ expectedOrigin: "https://evil.example" }),
    "wrong-origin",
  );
  assert.equal(await why({ expectedRoom: "other" }), "wrong-room");
  assert.equal(
    await why({ expectedNonce: "nonce-other-0123456789" }),
    "wrong-nonce",
  );
  assert.equal(
    await why({ expectedNonce: undefined }),
    "expectations-required",
  );
  assert.equal(
    await why({ expectedOrigin: undefined }),
    "expectations-required",
  );
});

test("expired and not-yet-valid descriptors are rejected", async () => {
  const wallet = await makeWallet();
  const d = await createAgentDescriptor(
    wallet,
    base(createInstanceId(), { ttlMs: 60_000 }),
  );
  assert.equal(
    (await verifyAgentDescriptor(d, expectations({ now: NOW + 61_000 })))
      .reason,
    "expired",
  );
  assert.equal(
    (await verifyAgentDescriptor(d, expectations({ now: NOW - 120_000 })))
      .reason,
    "not-yet-valid",
  );
  await assert.rejects(
    createAgentDescriptor(
      wallet,
      base(createInstanceId(), { ttlMs: 24 * 3600_000 }),
    ),
    /lifetime/u,
  );
});

test("tampering with any claim breaks the signature", async () => {
  const wallet = await makeWallet();
  const d = await createAgentDescriptor(wallet, base(createInstanceId()));
  for (const patch of [
    { model: "model-y" },
    { provider: "other" },
    { capabilities: ["tools.invoke"] },
    { runtime: { name: "node", version: "23" } },
    { agentType: "admin" },
    { expiresAt: d.expiresAt + 1000 },
  ]) {
    const r = await verifyAgentDescriptor({ ...d, ...patch }, expectations());
    assert.equal(r.ok, false, JSON.stringify(patch));
  }
  assert.equal(
    (await verifyAgentDescriptor({ ...d, extra: 1 }, expectations())).reason,
    "malformed",
  );
  assert.equal(
    (await verifyAgentDescriptor(null, expectations())).reason,
    "malformed",
  );
  assert.equal(
    (await verifyAgentDescriptor({ ...d, protocolVersion: 2 }, expectations()))
      .reason,
    "unsupported-version",
  );
});

test("two instances get distinct 128-bit ids", () => {
  const ids = new Set(Array.from({ length: 50 }, createInstanceId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^inst:[A-Za-z0-9_-]{22}$/u);
});

test("an instance binding proves the wallet owns the instance id", async () => {
  const wallet = await makeWallet();
  const other = await makeWallet();
  const id = createInstanceId();
  const b = await bindInstance(wallet, id, { now: NOW });
  assert.deepEqual(await verifyInstanceBinding(b), {
    ok: true,
    walletId: wallet.id,
    instanceId: id,
  });
  const stolen = { ...b, walletId: other.id, publicKey: other.publicKey };
  assert.equal((await verifyInstanceBinding(stolen)).ok, false);
  assert.equal(
    (await verifyInstanceBinding({ ...b, instanceId: createInstanceId() })).ok,
    false,
  );
  await assert.rejects(bindInstance(wallet, "not-an-id"), /instance id/u);
});

async function observed(wallet, instanceId, sessionId, detector) {
  const d = await createAgentDescriptor(
    wallet,
    base(instanceId, { sessionId }),
  );
  const v = await verifyAgentDescriptor(d, expectations());
  assert.equal(v.ok, true);
  return detector.observe(v);
}

test("clone detection: one wallet, two instance ids", async () => {
  const wallet = await makeWallet();
  const det = createCloneDetector();
  assert.equal(
    (await observed(wallet, createInstanceId(), "session-aaaaaaaa", det))
      .length,
    0,
  );
  const found = await observed(
    wallet,
    createInstanceId(),
    "session-bbbbbbbb",
    det,
  );
  assert.equal(found[0].code, "clone-suspected");
  assert.equal(found[0].reason, "wallet-multiple-instances");
});

test("clone detection: one instance id, two live sessions", async () => {
  const wallet = await makeWallet();
  const id = createInstanceId();
  const det = createCloneDetector();
  assert.equal((await observed(wallet, id, "session-aaaaaaaa", det)).length, 0);
  // Re-presenting the same session is not a clone.
  assert.equal((await observed(wallet, id, "session-aaaaaaaa", det)).length, 0);
  const found = await observed(wallet, id, "session-bbbbbbbb", det);
  assert.equal(found[0].reason, "instance-multiple-sessions");
  assert.equal(det.diagnostics().length, 1);
});

test("clone detection: an instance id reappearing under another wallet", async () => {
  const a = await makeWallet();
  const b = await makeWallet();
  const id = createInstanceId();
  const det = createCloneDetector();
  await observed(a, id, "session-aaaaaaaa", det);
  const found = await observed(b, id, "session-bbbbbbbb", det);
  assert.ok(found.some((d) => d.reason === "instance-wallet-mismatch"));
});

test("a released session does not trigger a clone diagnostic on reuse", async () => {
  const wallet = await makeWallet();
  const id = createInstanceId();
  const det = createCloneDetector();
  await observed(wallet, id, "session-aaaaaaaa", det);
  det.release(id, "session-aaaaaaaa");
  assert.equal((await observed(wallet, id, "session-bbbbbbbb", det)).length, 0);
});
