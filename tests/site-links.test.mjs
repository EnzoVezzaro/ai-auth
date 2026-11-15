import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  LINK_POLICY,
  approveLink,
  createLinkChallenge,
  createLinkNonceStore,
  createRevokedLinkSet,
  identityFor,
  listLinks,
  signEnvelope,
  unlink,
  verifyLink,
  verifyLinkRevocation,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://body4ai.example";
const RESOURCE = "body4ai:workspace/42";
const CAPS = ["catalog.read", "tools.invoke"];

async function makeWallet(name = "Agent") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const wallet = { id, name, publicKey, privateKey: pair.privateKey };
  return { ...wallet, sign: (t, p) => signEnvelope(wallet, t, p) };
}

function setup(overrides = {}) {
  const nonceStore = createLinkNonceStore();
  const challenge = createLinkChallenge({
    origin: ORIGIN,
    resource: RESOURCE,
    capabilities: CAPS,
    nonceStore,
    ...overrides,
  });
  return { nonceStore, challenge };
}

const verifyOptions = (nonceStore, extra = {}) => ({
  expectedOrigin: ORIGIN,
  expectedResource: RESOURCE,
  expectedCapabilities: CAPS,
  nonceStore,
  ...extra,
});

async function linked(capabilities = CAPS) {
  const wallet = await makeWallet();
  const { nonceStore, challenge } = setup();
  const proof = await approveLink(wallet, challenge, { capabilities });
  return { wallet, nonceStore, challenge, proof };
}

const clone = (value) => structuredClone(value);

// re-sign a modified payload with an attacker key, bypassing wallet checks
async function resign(wallet, payload) {
  return signEnvelope(wallet, "ai-auth-link", payload);
}

test("link persists across storage reopen and lists the approved scopes only", async () => {
  const { wallet, nonceStore, proof } = await linked(["catalog.read"]);
  const result = await verifyLink(proof, verifyOptions(nonceStore));
  assert.equal(result.valid, true);
  assert.deepEqual(result.link.capabilities, ["catalog.read"]);
  const before = await listLinks(wallet);
  // "reopen": a brand-new module-level call opens the database again
  const after = await listLinks({ id: wallet.id });
  assert.equal(after.length, 1);
  assert.equal(after[0].linkId, before[0].linkId);
  assert.deepEqual(after[0].capabilities, ["catalog.read"]);
  assert.equal(after[0].origin, ORIGIN);
});

test("links are scoped to their wallet", async () => {
  const { wallet } = await linked();
  const other = await makeWallet("Other");
  assert.equal((await listLinks(other)).length, 0);
  const [link] = await listLinks(wallet);
  await assert.rejects(unlink(other, link.linkId), /No such link/);
});

test("approval cannot exceed the challenge or use wildcards", async () => {
  const wallet = await makeWallet();
  const { challenge } = setup();
  await assert.rejects(
    approveLink(wallet, challenge, { capabilities: ["files.write"] }),
    /did not request/,
  );
  await assert.rejects(
    approveLink(wallet, challenge, { capabilities: ["*"] }),
    /wildcards/,
  );
  await assert.rejects(approveLink(wallet, challenge, { capabilities: [] }));
  await assert.rejects(
    approveLink(wallet, challenge, {
      capabilities: CAPS,
      linkTtlSeconds: LINK_POLICY.maxLinkSeconds + 1,
    }),
    /policy/,
  );
});

test("wallet rejects expired or malformed challenges", async () => {
  const wallet = await makeWallet();
  const { challenge } = setup({ now: Date.now() - 10 * 60_000 });
  await assert.rejects(
    approveLink(wallet, challenge, { capabilities: CAPS }),
    /invalid or expired/,
  );
  const fresh = setup().challenge;
  await assert.rejects(
    approveLink(
      wallet,
      { ...fresh, origin: "https://evil.example/x" },
      { capabilities: CAPS },
    ),
  );
  assert.throws(
    () =>
      createLinkChallenge({
        origin: ORIGIN,
        resource: RESOURCE,
        capabilities: CAPS,
        ttlSeconds: 99999,
      }),
    /policy/,
  );
});

test("unlink removes the record and returns a verifiable revocation", async () => {
  const { wallet, proof } = await linked();
  const [link] = await listLinks(wallet);
  const event = await unlink(wallet, link.linkId);
  assert.equal((await listLinks(wallet)).length, 0);
  assert.equal(event.body.payload.type, "ai-auth-link-revocation");
  const result = await verifyLinkRevocation(event, { expectedOrigin: ORIGIN });
  assert.equal(result.valid, true);
  assert.equal(result.revocation.linkId, proof.body.payload.linkId);
  const wrong = await verifyLinkRevocation(event, {
    expectedOrigin: "https://evil.example",
  });
  assert.equal(wrong.reason, "origin-mismatch");
});

test("revoked link fails verifyLink via the site revoked set", async () => {
  const { wallet, nonceStore, proof } = await linked();
  const [link] = await listLinks(wallet);
  const revokedLinks = createRevokedLinkSet();
  const event = await unlink(wallet, link.linkId);
  assert.equal(
    (await revokedLinks.add(event, { expectedOrigin: ORIGIN })).valid,
    true,
  );
  const result = await verifyLink(
    proof,
    verifyOptions(nonceStore, { revokedLinks }),
  );
  assert.deepEqual(result, { valid: false, reason: "revoked" });
});

test("revocation signed by another wallet or tampered is not accepted", async () => {
  const { wallet } = await linked();
  const [link] = await listLinks(wallet);
  const attacker = await makeWallet("Attacker");
  const event = await unlink(wallet, link.linkId);
  const forged = clone(event);
  forged.body.payload.revokedAt += 1;
  assert.equal(
    (await verifyLinkRevocation(forged, { expectedOrigin: ORIGIN })).valid,
    false,
  );
  const reissued = await attacker.sign(
    "ai-auth-link-revocation",
    event.body.payload,
  );
  assert.equal(
    (await verifyLinkRevocation(reissued, { expectedOrigin: ORIGIN })).valid,
    false,
  );
  const revokedLinks = createRevokedLinkSet();
  assert.equal(
    (await revokedLinks.add(forged, { expectedOrigin: ORIGIN })).valid,
    false,
  );
  assert.equal(revokedLinks.list().length, 0);
});

test("malicious origin and changed site or resource are rejected", async () => {
  const { nonceStore, proof } = await linked();
  const a = await verifyLink(
    proof,
    verifyOptions(nonceStore, { expectedOrigin: "https://evil.example" }),
  );
  assert.equal(a.reason, "origin-mismatch");
  const b = await verifyLink(
    proof,
    verifyOptions(nonceStore, { expectedResource: "body4ai:workspace/43" }),
  );
  assert.equal(b.reason, "resource-mismatch");
  // nothing was consumed by rejected attempts
  assert.equal(
    (await verifyLink(proof, verifyOptions(nonceStore))).valid,
    true,
  );
});

test("reused nonce and unissued nonce are rejected", async () => {
  const { nonceStore, proof, wallet } = await linked();
  assert.equal(
    (await verifyLink(proof, verifyOptions(nonceStore))).valid,
    true,
  );
  assert.equal(
    (await verifyLink(proof, verifyOptions(nonceStore))).reason,
    "nonce-rejected",
  );
  const rogue = createLinkChallenge({
    origin: ORIGIN,
    resource: RESOURCE,
    capabilities: CAPS,
  });
  const rogueProof = await approveLink(wallet, rogue, { capabilities: CAPS });
  assert.equal(
    (await verifyLink(rogueProof, verifyOptions(nonceStore))).reason,
    "nonce-rejected",
  );
});

test("forged wallet id or key substitution fails", async () => {
  const { nonceStore, proof } = await linked();
  const attacker = await makeWallet("Attacker");
  const victimId = proof.body.payload.walletId;
  const claimed = { ...clone(proof.body.payload), walletId: attacker.id };
  const a = await verifyLink(
    await resign(attacker, { ...claimed, walletId: victimId }),
    verifyOptions(nonceStore),
  );
  assert.equal(a.reason, "identity-mismatch");
  const swapped = clone(proof);
  swapped.body.payload.walletId = attacker.id;
  assert.equal(
    (await verifyLink(swapped, verifyOptions(nonceStore))).valid,
    false,
  );
});

test("tampered, extra and reordered fields fail", async () => {
  const { wallet, nonceStore, proof } = await linked();
  const tampered = clone(proof);
  tampered.body.payload.resource = RESOURCE;
  tampered.body.payload.expiresAt += 1000;
  assert.equal(
    (await verifyLink(tampered, verifyOptions(nonceStore))).reason,
    "bad-signature",
  );
  const extra = await resign(wallet, { ...proof.body.payload, admin: true });
  assert.equal(
    (await verifyLink(extra, verifyOptions(nonceStore))).reason,
    "malformed",
  );
  const unsorted = await resign(wallet, {
    ...proof.body.payload,
    capabilities: [...CAPS].reverse(),
  });
  assert.equal(
    (await verifyLink(unsorted, verifyOptions(nonceStore))).reason,
    "malformed",
  );
  const swappedId = clone(proof);
  swappedId.body.payload.linkId = `link:${"0".repeat(64)}`;
  assert.equal(
    (await verifyLink(swappedId, verifyOptions(nonceStore))).valid,
    false,
  );
});

test("scope escalation beyond the challenge fails", async () => {
  const { wallet, nonceStore, challenge, proof } = await linked();
  const escalated = await resign(wallet, {
    ...proof.body.payload,
    capabilities: ["catalog.read", "files.write", "tools.invoke"],
  });
  const result = await verifyLink(escalated, verifyOptions(nonceStore));
  assert.equal(result.reason, "scope-escalation");
  assert.ok(challenge.capabilities.every((c) => CAPS.includes(c)));
});

test("overlong lifetime is rejected by policy", async () => {
  const { wallet, nonceStore, proof } = await linked();
  const payload = {
    ...proof.body.payload,
    expiresAt:
      proof.body.payload.createdAt + (LINK_POLICY.maxLinkSeconds + 1) * 1000,
  };
  const result = await verifyLink(
    await resign(wallet, payload),
    verifyOptions(nonceStore),
  );
  assert.equal(result.reason, "lifetime-out-of-policy");
});

test("clock-controlled expiry", async () => {
  const wallet = await makeWallet();
  const t0 = Date.now();
  const store1 = createLinkNonceStore();
  const store2 = createLinkNonceStore();
  const mk = async (store) => {
    const c = createLinkChallenge({
      origin: ORIGIN,
      resource: RESOURCE,
      capabilities: CAPS,
      nonceStore: store,
      now: t0,
    });
    return approveLink(wallet, c, {
      capabilities: CAPS,
      linkTtlSeconds: 3600,
      now: t0,
    });
  };
  const p1 = await mk(store1);
  const p2 = await mk(store2);
  const justBefore = t0 + 3600 * 1000 - 1;
  // challenge is short-lived, so the site must consume it within its own TTL
  assert.equal(
    (await verifyLink(p1, verifyOptions(store1, { now: t0 + 1000 }))).valid,
    true,
  );
  assert.equal(
    (await verifyLink(p2, verifyOptions(store2, { now: justBefore }))).reason,
    "nonce-rejected",
  );
  const store3 = createLinkNonceStore();
  const c3 = createLinkChallenge({
    origin: ORIGIN,
    resource: RESOURCE,
    capabilities: CAPS,
    nonceStore: store3,
    now: t0,
    ttlSeconds: 600,
  });
  const p3 = await approveLink(wallet, c3, {
    capabilities: CAPS,
    linkTtlSeconds: 60,
    now: t0,
  });
  assert.equal(
    (await verifyLink(p3, verifyOptions(store3, { now: t0 + 60_000 }))).reason,
    "expired",
  );
  const store4 = createLinkNonceStore();
  const c4 = createLinkChallenge({
    origin: ORIGIN,
    resource: RESOURCE,
    capabilities: CAPS,
    nonceStore: store4,
    now: t0,
    ttlSeconds: 600,
  });
  const p4 = await approveLink(wallet, c4, {
    capabilities: CAPS,
    linkTtlSeconds: 60,
    now: t0,
  });
  assert.equal(
    (await verifyLink(p4, verifyOptions(store4, { now: t0 + 59_999 }))).valid,
    true,
  );
  const links = await listLinks(wallet, {
    now: t0 + 61_000,
    includeExpired: true,
  });
  assert.ok(links.some((l) => l.expired));
  assert.ok(
    !(await listLinks(wallet, { now: t0 + 3601_000 + 1 })).some(
      (l) => l.expiresAt <= t0 + 3601_000,
    ),
  );
});

test("subject binding is enforced when expected", async () => {
  const wallet = await makeWallet();
  const { nonceStore, challenge } = setup({ subject: "user_123" });
  const proof = await approveLink(wallet, challenge, { capabilities: CAPS });
  const bad = await verifyLink(
    proof,
    verifyOptions(nonceStore, { expectedSubject: "user_999" }),
  );
  assert.equal(bad.reason, "subject-mismatch");
  const ok = await verifyLink(
    proof,
    verifyOptions(nonceStore, { expectedSubject: "user_123" }),
  );
  assert.equal(ok.valid, true);
  assert.equal(ok.link.subject, "user_123");
});

test("verifier refuses to run without explicit expectations", async () => {
  const { proof } = await linked();
  const r = await verifyLink(proof, { expectedOrigin: ORIGIN });
  assert.equal(r.reason, "invalid-verifier-options");
});

test.after(() => {
  globalThis.indexedDB = new IDBFactory();
});
