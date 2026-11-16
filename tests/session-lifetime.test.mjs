import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  NonceGuard,
  SessionLease,
  approvePermissionRequest,
  createPermissionRequest,
  identityFor,
  signEnvelope,
  verifyPermissionConsent,
  verifyPermissionRequest,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const MINUTE = 60_000;

async function makeWallet() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const identity = { id, publicKey, privateKey: pair.privateKey };
  return {
    ...identity,
    sign: (type, payload) => signEnvelope(identity, type, payload),
  };
}

async function handshake(options = {}, capabilities = ["presence.read"]) {
  const wallet = await makeWallet();
  const request = await createPermissionRequest(ORIGIN, capabilities, options);
  return { wallet, request };
}

const verify = (consent, request, wallet, extra = {}) =>
  verifyPermissionConsent(consent, request, {
    expectedOrigin: ORIGIN,
    expectedWallet: wallet.id,
    nonceGuard: new NonceGuard(),
    ...extra,
  });

test("handshake challenge stays 1-120s while the session grant is bounded separately", async () => {
  await assert.rejects(
    createPermissionRequest(ORIGIN, ["presence.read"], { expiresInMs: 999 }),
    /between 1 and 120 seconds/u,
  );
  await assert.rejects(
    createPermissionRequest(ORIGIN, ["presence.read"], {
      expiresInMs: 121_000,
    }),
    /between 1 and 120 seconds/u,
  );
  const { wallet, request } = await handshake({ expiresInMs: 60_000 });
  assert.equal(request.version, 2);
  const consent = await approvePermissionRequest(
    wallet,
    request,
    request.capabilities,
  );
  const payload = consent.body.payload;
  assert.equal(payload.version, 2);
  assert.equal(payload.challengeExpiresAt, request.expiresAt);
  // A site that names no limit gets Never: no fixed end and no idle end.
  assert.equal(payload.sessionTtlMs, null);
  assert.equal(payload.idleTimeoutMs, null);
  assert.equal(payload.expiresAt, null);
  assert.equal(await verify(consent, request, wallet), true);
});

test("a site that names no limit gets a Never grant that does not expire", async () => {
  const { wallet, request } = await handshake();
  const consent = await approvePermissionRequest(
    wallet,
    request,
    request.capabilities,
  );
  const payload = consent.body.payload;
  let clock = payload.issuedAt;
  const lease = new SessionLease(payload, { now: () => clock });
  for (const hours of [1, 24, 24 * 30]) {
    clock = payload.issuedAt + hours * 60 * MINUTE;
    assert.equal(lease.status(), "active", `active after ${hours} hours`);
  }
  assert.equal(lease.deadline, null);
  assert.equal(lease.touch(), true);
  // Only the visitor ends a Never grant, through revocation.
  lease.revoke();
  assert.equal(lease.status(), "revoked");
});

test("a 15 minute collaboration stays authorized and then expires", async () => {
  const { wallet, request } = await handshake({ sessionTtlMs: 15 * MINUTE });
  const consent = await approvePermissionRequest(
    wallet,
    request,
    request.capabilities,
    { sessionTtlMs: 15 * MINUTE },
  );
  const payload = consent.body.payload;
  assert.equal(payload.expiresAt, payload.issuedAt + 15 * MINUTE);
  // Idle defaults to 10 minutes, capped by the 15 minute lifetime.
  assert.equal(payload.idleTimeoutMs, 10 * MINUTE);
  let clock = payload.issuedAt;
  const lease = new SessionLease(payload, { now: () => clock });
  for (let minute = 1; minute <= 14; minute += 1) {
    clock = payload.issuedAt + minute * MINUTE;
    assert.equal(lease.touch(), true, `active at minute ${minute}`);
  }
  clock = payload.expiresAt - 1;
  assert.equal(lease.status(), "active");
  clock = payload.expiresAt;
  assert.equal(lease.status(), "expired");
  assert.equal(lease.touch(), false);
});

test("a numeric site cap bounds the grant; only an uncapped site may choose Never", async () => {
  await assert.rejects(
    createPermissionRequest(ORIGIN, ["presence.read"], {
      sessionTtlMs: MAX_SESSION_TTL_MS + 1,
    }),
    RangeError,
  );
  await assert.rejects(
    createPermissionRequest(ORIGIN, ["presence.read"], { sessionTtlMs: 10 }),
    RangeError,
  );
  const { wallet, request } = await handshake();
  const forged = { ...request, sessionTtlMs: MAX_SESSION_TTL_MS * 24 };
  assert.equal(
    await verifyPermissionRequest(forged, { expectedOrigin: ORIGIN }),
    false,
  );
  await assert.rejects(
    approvePermissionRequest(wallet, forged, forged.capabilities),
    /invalid or expired/u,
  );

  // A site capped at 30 minutes: Never and longer lengths are refused.
  const capped = await createPermissionRequest(ORIGIN, ["presence.read"], {
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  });
  await assert.rejects(
    approvePermissionRequest(wallet, capped, capped.capabilities, {
      sessionTtlMs: null,
    }),
    /exceeds the allowed grant/u,
  );
  await assert.rejects(
    approvePermissionRequest(wallet, capped, capped.capabilities, {
      sessionTtlMs: DEFAULT_SESSION_TTL_MS + 1,
    }),
    /exceeds the allowed grant/u,
  );
  const shorter = await approvePermissionRequest(
    wallet,
    capped,
    capped.capabilities,
    { sessionTtlMs: 5 * MINUTE },
  );
  assert.equal(shorter.body.payload.sessionTtlMs, 5 * MINUTE);
  // A signed Never grant cannot be presented against the capped request.
  const neverForCapped = await wallet.sign("connect/consent", {
    version: 2,
    audience: ORIGIN,
    requestNonce: capped.nonce,
    capabilities: capped.capabilities,
    room: "default",
    issuedAt: Date.now(),
    challengeExpiresAt: capped.expiresAt,
    expiresAt: null,
    sessionTtlMs: null,
    idleTimeoutMs: null,
  });
  assert.equal(await verify(neverForCapped, capped, wallet), false);

  // An uncapped request accepts Never; a numeric hint up to the cap still works.
  const open = await createPermissionRequest(ORIGIN, ["presence.read"]);
  const forever = await approvePermissionRequest(
    wallet,
    open,
    open.capabilities,
    { sessionTtlMs: null },
  );
  assert.equal(forever.body.payload.expiresAt, null);
  assert.equal(await verify(forever, open, wallet), true);
  const hinted = await createPermissionRequest(ORIGIN, ["presence.read"], {
    sessionTtlMs: MAX_SESSION_TTL_MS,
  });
  const long = await approvePermissionRequest(
    wallet,
    hinted,
    hinted.capabilities,
  );
  assert.equal(long.body.payload.sessionTtlMs, MAX_SESSION_TTL_MS);
  await assert.rejects(
    approvePermissionRequest(wallet, hinted, hinted.capabilities, {
      sessionTtlMs: MAX_SESSION_TTL_MS + 1,
    }),
    RangeError,
  );
});

test("a request from an SDK that predates Never keeps the 30 minute default", async () => {
  const wallet = await makeWallet();
  const modern = await createPermissionRequest(ORIGIN, ["presence.read"]);
  const { sessionPolicy, ...legacy } = modern;
  void sessionPolicy;
  assert.equal(
    await verifyPermissionRequest(legacy, { expectedOrigin: ORIGIN }),
    true,
  );
  await assert.rejects(
    approvePermissionRequest(wallet, legacy, legacy.capabilities, {
      sessionTtlMs: null,
    }),
    /exceeds the allowed grant/u,
  );
  const consent = await approvePermissionRequest(
    wallet,
    legacy,
    legacy.capabilities,
  );
  assert.equal(consent.body.payload.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
  assert.equal(await verify(consent, legacy, wallet), true);
  // A Never consent must not verify against a request that did not allow Never.
  const never = await wallet.sign("connect/consent", {
    version: 2,
    audience: ORIGIN,
    requestNonce: legacy.nonce,
    capabilities: legacy.capabilities,
    room: "default",
    issuedAt: Date.now(),
    challengeExpiresAt: legacy.expiresAt,
    expiresAt: null,
    sessionTtlMs: null,
    idleTimeoutMs: null,
  });
  assert.equal(await verify(never, legacy, wallet), false);
});

test("verifier rejects a signed consent that outlives the cap or the request's own hint", async () => {
  const { wallet, request } = await handshake({ sessionTtlMs: 5 * MINUTE });
  const base = (
    await approvePermissionRequest(wallet, request, ["presence.read"])
  ).body.payload;
  const sign = (overrides) =>
    wallet.sign("connect/consent", { ...base, ...overrides });
  const tooLong = base.issuedAt + 10 * MINUTE;
  const cases = [
    { expiresAt: tooLong, sessionTtlMs: 10 * MINUTE },
    {
      expiresAt: base.issuedAt + 2 * MAX_SESSION_TTL_MS,
      sessionTtlMs: 2 * MAX_SESSION_TTL_MS,
    },
    { sessionTtlMs: base.sessionTtlMs - 1 },
    { idleTimeoutMs: base.sessionTtlMs + 1 },
    {
      issuedAt: request.expiresAt + 1,
      expiresAt: request.expiresAt + 1 + base.sessionTtlMs,
    },
    { version: 3 },
  ];
  for (const overrides of cases)
    assert.equal(
      await verify(await sign(overrides), request, wallet),
      false,
      JSON.stringify(overrides),
    );
  assert.equal(await verify(await sign({}), request, wallet), true);
});

test("replayed consent and stale challenges stay rejected", async () => {
  const { wallet, request } = await handshake({ expiresInMs: 5_000 });
  const consent = await approvePermissionRequest(wallet, request, [
    "presence.read",
  ]);
  const guard = new NonceGuard();
  assert.equal(
    await verify(consent, request, wallet, { nonceGuard: guard }),
    true,
  );
  assert.equal(
    await verify(consent, request, wallet, { nonceGuard: guard }),
    false,
  );
  // A fresh guard still rejects a consent presented after its challenge died.
  assert.equal(
    await verify(consent, request, wallet, { now: request.expiresAt + 1 }),
    false,
  );
  await assert.rejects(
    approvePermissionRequest(wallet, request, ["presence.read"], {
      now: request.expiresAt + 1,
    }),
    /invalid or expired/u,
  );
});

test("legacy handshake-bound consent still verifies but cannot outlive the challenge", async () => {
  const wallet = await makeWallet();
  const request = await createPermissionRequest(ORIGIN, ["presence.read"]);
  const legacy = (expiresAt) =>
    wallet.sign("connect/consent", {
      audience: ORIGIN,
      requestNonce: request.nonce,
      capabilities: ["presence.read"],
      expiresAt,
      room: "default",
    });
  assert.equal(
    await verify(await legacy(request.expiresAt), request, wallet),
    true,
  );
  assert.equal(
    await verify(await legacy(request.expiresAt + 1), request, wallet),
    false,
  );
});

test("idle timeout counts only authorized activity and ends the lease", async () => {
  const { wallet, request } = await handshake({
    sessionTtlMs: 30 * MINUTE,
    idleTimeoutMs: 5 * MINUTE,
  });
  const consent = await approvePermissionRequest(wallet, request, [
    "presence.read",
  ]);
  assert.equal(consent.body.payload.idleTimeoutMs, 5 * MINUTE);
  let clock = consent.body.payload.issuedAt;
  const lease = new SessionLease(consent.body.payload, { now: () => clock });
  clock += 4 * MINUTE;
  assert.equal(lease.touch(), true);
  clock += 4 * MINUTE;
  assert.equal(lease.status(), "active");
  assert.equal(lease.deadline, lease.lastActivityAt + 5 * MINUTE);
  clock += 2 * MINUTE;
  assert.equal(lease.status(), "idle");
  assert.equal(lease.touch(), false);
  assert.equal(lease.renew(consent.body.payload), false);
});

test("renewal needs explicit wallet re-consent and cannot widen scopes", async () => {
  const caps = ["messages.send", "presence.read"];
  const { wallet, request } = await handshake({}, caps);
  const first = await approvePermissionRequest(wallet, request, caps);
  const renewal = await createPermissionRequest(ORIGIN, ["presence.read"], {
    renews: first.body.payload.requestNonce,
  });
  const renewed = await approvePermissionRequest(
    wallet,
    renewal,
    ["presence.read"],
    { previousConsent: first },
  );
  assert.equal(
    renewed.body.payload.renewsNonce,
    first.body.payload.requestNonce,
  );
  assert.equal(
    await verify(renewed, renewal, wallet, { previousConsent: first }),
    true,
  );
  // Renewal without the active consent is not a renewal.
  assert.equal(await verify(renewed, renewal, wallet), false);
  await assert.rejects(
    approvePermissionRequest(wallet, renewal, ["presence.read"]),
    /does not match the active consent/u,
  );
  // A renewal request asking for more than the original grant is refused.
  const wider = await createPermissionRequest(ORIGIN, ["tools.invoke"], {
    renews: first.body.payload.requestNonce,
  });
  await assert.rejects(
    approvePermissionRequest(wallet, wider, ["tools.invoke"], {
      previousConsent: first,
    }),
    /cannot widen/u,
  );
  const forgedWide = await wallet.sign("connect/consent", {
    ...renewed.body.payload,
    requestNonce: wider.nonce,
    renewsNonce: first.body.payload.requestNonce,
    capabilities: ["tools.invoke"],
    challengeExpiresAt: wider.expiresAt,
  });
  assert.equal(
    await verify(forgedWide, wider, wallet, { previousConsent: first }),
    false,
  );
  // A renewal consent for a different wallet identity is refused.
  const other = await makeWallet();
  assert.equal(
    await verify(renewed, renewal, other, { previousConsent: first }),
    false,
  );
});

test("lease renewal extends an active session and never revives a dead one", async () => {
  const { wallet, request } = await handshake({ sessionTtlMs: 10 * MINUTE });
  const first = await approvePermissionRequest(wallet, request, [
    "presence.read",
  ]);
  let clock = first.body.payload.issuedAt;
  const lease = new SessionLease(first.body.payload, { now: () => clock });
  clock += 9 * MINUTE;
  const renewal = await createPermissionRequest(ORIGIN, ["presence.read"], {
    renews: first.body.payload.requestNonce,
    sessionTtlMs: 20 * MINUTE,
  });
  const renewed = await approvePermissionRequest(
    wallet,
    renewal,
    ["presence.read"],
    { previousConsent: first },
  );
  assert.equal(lease.renew(renewed.body.payload), true);
  assert.equal(lease.expiresAt, renewed.body.payload.expiresAt);
  clock = first.body.payload.expiresAt + 1;
  assert.equal(lease.status(), "active");
  assert.equal(
    lease.renew({ ...renewed.body.payload, capabilities: ["tools.invoke"] }),
    false,
  );
  clock = renewed.body.payload.expiresAt;
  assert.equal(lease.status(), "expired");
  assert.equal(lease.renew(renewed.body.payload), false);
  lease.revoke();
  assert.equal(lease.status(), "revoked");
});

const legacyVerifier = () => import("./fixtures/connect-0.4.1.mjs");

function legacyRequest(request) {
  return { ...request, version: 1 };
}

test("a version 1 request gets the legacy consent the 0.4.1 verifier accepts", async () => {
  const old = await legacyVerifier();
  const wallet = await makeWallet();
  const modern = await createPermissionRequest(ORIGIN, ["presence.read"]);
  const { sessionTtlMs, idleTimeoutMs, renews, sessionPolicy, ...base } =
    modern;
  void sessionTtlMs;
  void idleTimeoutMs;
  void renews;
  void sessionPolicy;
  const request = legacyRequest(base);
  const consent = await approvePermissionRequest(wallet, request, [
    "presence.read",
  ]);
  assert.deepEqual(Object.keys(consent.body.payload).sort(), [
    "audience",
    "capabilities",
    "expiresAt",
    "requestNonce",
    "room",
  ]);
  assert.equal(consent.body.payload.expiresAt, request.expiresAt);
  // Session options are ignored for legacy requests.
  const ignored = await approvePermissionRequest(
    wallet,
    request,
    ["presence.read"],
    { sessionTtlMs: 5 * MINUTE },
  );
  assert.equal(ignored.body.payload.expiresAt, request.expiresAt);
  assert.equal(
    await old.verifyPermissionConsent(consent, request, {
      expectedOrigin: ORIGIN,
      expectedWallet: wallet.id,
      nonceGuard: new old.NonceGuard(),
    }),
    true,
  );
  assert.equal(await verify(consent, request, wallet), true);
});

test("version 2 requests still get version 2 consent and v1 requests cannot carry session hints", async () => {
  const { wallet, request } = await handshake();
  const consent = await approvePermissionRequest(wallet, request, [
    "presence.read",
  ]);
  assert.equal(consent.body.payload.version, 2);
  const smuggled = { ...request, version: 1, sessionTtlMs: 5 * MINUTE };
  assert.equal(
    await verifyPermissionRequest(smuggled, { expectedOrigin: ORIGIN }),
    false,
  );
  await assert.rejects(
    approvePermissionRequest(wallet, smuggled, ["presence.read"]),
    /invalid or expired/u,
  );
});
