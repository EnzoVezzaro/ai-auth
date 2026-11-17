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
import { canResumeSession } from "../packages/p2p/resume-verification.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const ROOM = "research";
const CAPS = ["messages.send", "presence.read"];
const MINUTE = 60_000;

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

async function grant(wallet) {
  const request = await createPermissionRequest(ORIGIN, CAPS, {
    room: ROOM,
    expiresInMs: 120_000,
    sessionTtlMs: 30 * MINUTE,
    idleTimeoutMs: 10 * MINUTE,
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
  return consent;
}

function expectations(consent, overrides = {}) {
  return {
    audience: ORIGIN,
    sessionId: consent.body.payload.requestNonce,
    room: ROOM,
    walletId: consent.body.issuer,
    ...overrides,
  };
}

test("the wallet confirms a genuine, current session", async () => {
  const consent = await grant(await makeWallet());
  assert.equal(await canResumeSession(consent, expectations(consent)), true);
});

test("the wallet refuses a wrong origin, room, session or wallet", async () => {
  const consent = await grant(await makeWallet());
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, { audience: "https://evil.example" }),
    ),
    false,
  );
  assert.equal(
    await canResumeSession(consent, expectations(consent, { room: "other" })),
    false,
  );
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, { sessionId: "other" }),
    ),
    false,
  );
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, { walletId: "agent:other" }),
    ),
    false,
  );
});

test("the wallet refuses an ended, expired or idle-timed-out session", async () => {
  const wallet = await makeWallet();
  const consent = await grant(wallet);
  const id = consent.body.payload.requestNonce;
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, { endedIds: new Set([id]) }),
    ),
    false,
  );
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, { now: consent.body.payload.expiresAt + 1 }),
    ),
    false,
  );
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, {
        lastActivity: consent.body.payload.issuedAt - 11 * MINUTE,
      }),
    ),
    false,
  );
});

test("the wallet rejects a lastActivity in the future", async () => {
  const consent = await grant(await makeWallet());
  const now = consent.body.payload.issuedAt + MINUTE;
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, { now, lastActivity: now + 60_000 }),
    ),
    false,
    "a site cannot claim activity that has not happened yet",
  );
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, { now, lastActivity: now + 10_000 }),
    ),
    true,
    "small clock skew is tolerated",
  );
});

test("a forged recent lastActivity cannot revive an idle-expired session", async () => {
  const consent = await grant(await makeWallet());
  const now = consent.body.payload.issuedAt + 20 * MINUTE;
  const forged = now + 60_000;
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, { now, lastActivity: forged }),
    ),
    false,
    "the wallet clock says idle and the future activity claim is rejected",
  );
  assert.equal(
    await canResumeSession(
      consent,
      expectations(consent, {
        now,
        lastActivity: consent.body.payload.issuedAt - 1,
      }),
    ),
    false,
    "activity before the grant was issued is impossible",
  );
});

test("a signed consent with the wrong version is refused on resume", async () => {
  const wallet = await makeWallet();
  const consent = await grant(wallet);
  const wrongVersion = await wallet.sign("connect/consent", {
    ...consent.body.payload,
    version: 3,
  });
  assert.equal(
    await canResumeSession(wrongVersion, expectations(consent)),
    false,
    "resume applies the same consent version check as a fresh connect",
  );
});

test("a signed consent with a tampered agent descriptor is refused", async () => {
  const wallet = await makeWallet();
  const consent = await grant(wallet);
  const tampered = structuredClone(consent.body.payload);
  tampered.agentDescriptor.model = "evil-model";
  const reSigned = await wallet.sign("connect/consent", tampered);
  assert.equal(
    await canResumeSession(reSigned, expectations(consent)),
    false,
    "the descriptor is re-verified against its signed fields",
  );
});

test("the wallet refuses a tampered consent even with matching fields", async () => {
  const consent = await grant(await makeWallet());
  const tampered = structuredClone(consent);
  tampered.body.payload.capabilities.push("tools.invoke");
  assert.equal(await canResumeSession(tampered, expectations(consent)), false);
});
