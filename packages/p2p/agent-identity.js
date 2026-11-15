import { canonicalize, identityFor } from "./index.js";
import {
  isObject,
  publicJwk,
  randomId,
  signDomain,
  verifyDomain,
} from "./codec.js";

export const AGENT_DESCRIPTOR_TYPE = "ai-auth-agent-descriptor";
export const AGENT_DESCRIPTOR_VERSION = 1;
export const INSTANCE_BINDING_TYPE = "ai-auth-instance-binding";
export const AGENT_PROTOCOL_VERSION = 1;
export const MAX_DESCRIPTOR_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_DESCRIPTOR_TTL_MS = 2 * 60 * 1000;

const DESCRIPTOR_DOMAIN = "ai-auth-agent-descriptor/v1\n";
const BINDING_DOMAIN = "ai-auth-instance-binding/v1\n";
const CLOCK_SKEW_MS = 30_000;
const MAX_TRACKED = 1024;
const INSTANCE_PATTERN = /^inst:[A-Za-z0-9_-]{22}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const SHORT_TEXT = /^[\x20-\x7E]{1,64}$/u;
const CAPABILITY = /^[a-z*][a-z0-9._*-]{0,63}$/u;
const KEYS = [
  "type",
  "v",
  "protocolVersion",
  "walletId",
  "publicKey",
  "instanceId",
  "agentType",
  "runtime",
  "provider",
  "model",
  "sessionId",
  "origin",
  "room",
  "capabilities",
  "nonce",
  "issuedAt",
  "expiresAt",
];
const BINDING_KEYS = [
  "type",
  "v",
  "instanceId",
  "walletId",
  "publicKey",
  "issuedAt",
];

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
const fail = (reason) => Object.freeze({ ok: false, reason });
const text = (v) => typeof v === "string" && SHORT_TEXT.test(v);
const optText = (v) => v === null || text(v);

/** A random 128-bit instance id. One instance, one identity. */
export function createInstanceId() {
  return `inst:${randomId(16)}`;
}

function requireWallet(wallet) {
  if (!wallet?.privateKey || !wallet.publicKey)
    throw new TypeError("A wallet with a signing key is required");
}

/** Signed statement that this wallet owns this instance id. */
export async function bindInstance(
  wallet,
  instanceId,
  { now = Date.now() } = {},
) {
  requireWallet(wallet);
  if (typeof instanceId !== "string" || !INSTANCE_PATTERN.test(instanceId))
    throw new TypeError("Invalid instance id");
  const fields = {
    type: INSTANCE_BINDING_TYPE,
    v: 1,
    instanceId,
    walletId: await identityFor(publicJwk(wallet.publicKey)),
    publicKey: publicJwk(wallet.publicKey),
    issuedAt: now,
  };
  const signature = await signDomain(
    wallet.privateKey,
    BINDING_DOMAIN,
    canonicalize(fields),
  );
  return Object.freeze({ ...fields, signature });
}

export async function verifyInstanceBinding(binding) {
  const ok =
    isObject(binding) &&
    binding.type === INSTANCE_BINDING_TYPE &&
    binding.v === 1 &&
    Object.keys(binding).length === BINDING_KEYS.length + 1 &&
    BINDING_KEYS.every((k) => k in binding) &&
    INSTANCE_PATTERN.test(binding.instanceId) &&
    isObject(binding.publicKey) &&
    Number.isFinite(binding.issuedAt);
  if (!ok) return fail("malformed");
  try {
    if ((await identityFor(publicJwk(binding.publicKey))) !== binding.walletId)
      return fail("wallet-mismatch");
  } catch {
    return fail("malformed");
  }
  const valid = await verifyDomain(
    binding.publicKey,
    binding.signature,
    BINDING_DOMAIN,
    canonicalize(pick(binding, BINDING_KEYS)),
  );
  return valid
    ? Object.freeze({
        ok: true,
        walletId: binding.walletId,
        instanceId: binding.instanceId,
      })
    : fail("bad-signature");
}

function checkInputs(o) {
  if (!INSTANCE_PATTERN.test(o.instanceId ?? "")) return "instanceId";
  if (!text(o.agentType)) return "agentType";
  if (
    !isObject(o.runtime) ||
    !text(o.runtime.name) ||
    !optText(o.runtime.version ?? null)
  )
    return "runtime";
  if (!optText(o.provider ?? null) || !optText(o.model ?? null))
    return "provider/model";
  if (
    typeof o.sessionId !== "string" ||
    o.sessionId.length < 8 ||
    o.sessionId.length > 128
  )
    return "sessionId";
  if (typeof o.origin !== "string" || !o.origin || o.origin.length > 200)
    return "origin";
  if (typeof o.room !== "string" || !o.room || o.room.length > 100)
    return "room";
  const caps = o.capabilities ?? [];
  if (
    !Array.isArray(caps) ||
    caps.length > 32 ||
    new Set(caps).size !== caps.length
  )
    return "capabilities";
  if (!caps.every((c) => typeof c === "string" && CAPABILITY.test(c)))
    return "capabilities";
  if (typeof o.nonce !== "string" || !NONCE_PATTERN.test(o.nonce))
    return "nonce";
  return null;
}

/**
 * Create a signed, self-describing agent descriptor. `provider`, `model` and
 * `runtime` are the agent's own claims, not attestations.
 */
export async function createAgentDescriptor(wallet, options = {}) {
  requireWallet(wallet);
  const { now = Date.now(), ttlMs = DEFAULT_DESCRIPTOR_TTL_MS } = options;
  const bad = checkInputs(options);
  if (bad) throw new TypeError(`Invalid descriptor field: ${bad}`);
  const expiresAt = options.expiresAt ?? now + ttlMs;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > MAX_DESCRIPTOR_TTL_MS
  )
    throw new TypeError("Descriptor lifetime is out of bounds");
  const fields = {
    type: AGENT_DESCRIPTOR_TYPE,
    v: AGENT_DESCRIPTOR_VERSION,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    walletId: await identityFor(publicJwk(wallet.publicKey)),
    publicKey: publicJwk(wallet.publicKey),
    instanceId: options.instanceId,
    agentType: options.agentType,
    runtime: {
      name: options.runtime.name,
      version: options.runtime.version ?? null,
    },
    provider: options.provider ?? null,
    model: options.model ?? null,
    sessionId: options.sessionId,
    origin: options.origin,
    room: options.room,
    capabilities: [...(options.capabilities ?? [])],
    nonce: options.nonce,
    issuedAt: now,
    expiresAt,
  };
  const signature = await signDomain(
    wallet.privateKey,
    DESCRIPTOR_DOMAIN,
    canonicalize(fields),
  );
  return Object.freeze({ ...fields, signature });
}

function shapeError(d, now) {
  if (
    !isObject(d) ||
    d.type !== AGENT_DESCRIPTOR_TYPE ||
    d.v !== AGENT_DESCRIPTOR_VERSION
  )
    return "malformed";
  if (d.protocolVersion !== AGENT_PROTOCOL_VERSION)
    return "unsupported-version";
  const keys = Object.keys(d);
  if (
    keys.length !== KEYS.length + 1 ||
    !KEYS.every((k) => k in d) ||
    typeof d.signature !== "string"
  )
    return "malformed";
  if (typeof d.walletId !== "string" || !isObject(d.publicKey))
    return "malformed";
  if (!Number.isFinite(d.issuedAt) || !Number.isFinite(d.expiresAt))
    return "malformed";
  if (checkInputs(d)) return "malformed";
  if (
    d.expiresAt <= d.issuedAt ||
    d.expiresAt - d.issuedAt > MAX_DESCRIPTOR_TTL_MS
  )
    return "lifetime-out-of-bounds";
  if (d.issuedAt > now + CLOCK_SKEW_MS) return "not-yet-valid";
  if (d.expiresAt <= now) return "expired";
  return null;
}

/**
 * Verify a descriptor. Fails closed: origin, room and nonce expectations are
 * required, and the nonce must be the verifier's own single-use challenge.
 */
export async function verifyAgentDescriptor(
  descriptor,
  { expectedOrigin, expectedRoom, expectedNonce, now } = {},
) {
  const at = typeof now === "function" ? now() : (now ?? Date.now());
  const bad = shapeError(descriptor, at);
  if (bad) return fail(bad);
  if (!expectedOrigin || !expectedRoom || !expectedNonce)
    return fail("expectations-required");
  if (descriptor.origin !== expectedOrigin) return fail("wrong-origin");
  if (descriptor.room !== expectedRoom) return fail("wrong-room");
  if (descriptor.nonce !== expectedNonce) return fail("wrong-nonce");
  try {
    if (
      (await identityFor(publicJwk(descriptor.publicKey))) !==
      descriptor.walletId
    )
      return fail("wallet-mismatch");
  } catch {
    return fail("malformed");
  }
  const valid = await verifyDomain(
    descriptor.publicKey,
    descriptor.signature,
    DESCRIPTOR_DOMAIN,
    canonicalize(pick(descriptor, KEYS)),
  );
  if (!valid) return fail("bad-signature");
  return Object.freeze({
    ok: true,
    walletId: descriptor.walletId,
    instanceId: descriptor.instanceId,
    sessionId: descriptor.sessionId,
    claims: Object.freeze({
      agentType: descriptor.agentType,
      runtime: Object.freeze({ ...descriptor.runtime }),
      provider: descriptor.provider,
      model: descriptor.model,
    }),
    expiresAt: descriptor.expiresAt,
  });
}

/**
 * Tracks verified descriptors and surfaces `clone-suspected` diagnostics when
 * one wallet presents several instance ids, one instance id is live in two
 * sessions, or an instance id appears under a different wallet. Detection is
 * advisory: it reports, it does not revoke.
 */
export function createCloneDetector({ now = () => Date.now() } = {}) {
  const walletInstances = new Map();
  const instanceWallet = new Map();
  const instanceSessions = new Map();
  const diagnostics = [];
  const flag = (reason, walletId, instanceId) => {
    const d = Object.freeze({
      code: "clone-suspected",
      reason,
      walletId,
      instanceId,
    });
    if (diagnostics.length < 256) diagnostics.push(d);
    return d;
  };
  const add = (map, key, value) => {
    if (!map.has(key) && map.size >= MAX_TRACKED) return null;
    const set = map.get(key) ?? new Map();
    map.set(key, set);
    set.set(value, now());
    return set;
  };
  return Object.freeze({
    /** Record a *verified* descriptor result; returns any new diagnostics. */
    observe({ walletId, instanceId, sessionId, expiresAt }) {
      const found = [];
      const owner = instanceWallet.get(instanceId);
      if (owner && owner !== walletId)
        found.push(flag("instance-wallet-mismatch", walletId, instanceId));
      else if (!owner && instanceWallet.size < MAX_TRACKED)
        instanceWallet.set(instanceId, walletId);
      const instances = add(walletInstances, walletId, instanceId);
      if (instances && instances.size > 1)
        found.push(flag("wallet-multiple-instances", walletId, instanceId));
      const sessions = instanceSessions.get(instanceId) ?? new Map();
      for (const [s, exp] of sessions) if (exp <= now()) sessions.delete(s);
      if (!sessions.has(sessionId) && sessions.size >= 1)
        found.push(flag("instance-multiple-sessions", walletId, instanceId));
      if (
        instanceSessions.has(instanceId) ||
        instanceSessions.size < MAX_TRACKED
      ) {
        sessions.set(sessionId, expiresAt);
        instanceSessions.set(instanceId, sessions);
      }
      return Object.freeze(found);
    },
    /** A session ended; its instance id may be reused by a later session. */
    release: (instanceId, sessionId) =>
      instanceSessions.get(instanceId)?.delete(sessionId),
    diagnostics: () => Object.freeze([...diagnostics]),
  });
}
