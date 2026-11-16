import { canonicalize, identityFor } from "./index.js";
import {
  isObject,
  publicJwk,
  randomId,
  signDomain,
  verifyDomain,
} from "./codec.js";

export const REVOCATION_TYPE = "ai-auth-revocation";
export const REVOCATION_VERSION = 1;
export const REVOCATION_KINDS = Object.freeze(["membership", "link", "wallet"]);
export const REVOCATION_GOSSIP_EVENT = "revocation/gossip";
export const REVOCATION_SYNC_REQUEST_EVENT = "revocation/sync-request";
export const REVOCATION_SYNC_EVENT = "revocation/sync";
export const EPOCH_TYPE = "ai-auth-epoch";
export const EPOCH_VERSION = 1;

const DOMAIN = "ai-auth-revocation/v1\n";
const CLOCK_SKEW_MS = 30_000;
const MAX_SEEN = 4096;
const KEYS = [
  "type",
  "v",
  "id",
  "kind",
  "target",
  "origin",
  "room",
  "issuer",
  "issuedAt",
];
const TARGET_PATTERNS = {
  membership: /^[A-Za-z0-9_-]{16,64}$/u,
  link: /^link:[0-9a-f]{64}$/u,
  wallet: /^agent:[A-Za-z0-9_-]{20,64}$/u,
};

const fail = (reason) => Object.freeze({ ok: false, reason });
const bodyOf = (r) =>
  canonicalize(Object.fromEntries(KEYS.map((k) => [k, r[k]])));

/**
 * Sign a revocation of one membership id, link id, or wallet id. The signer
 * must be a key the verifying side trusts (a site/host issuer), except that a
 * wallet may always revoke itself (`kind: "wallet"`, target = its own id).
 */
export async function createRevocation(
  signerWallet,
  { kind, target, origin, room, now = Date.now() } = {},
) {
  if (!signerWallet?.privateKey || !signerWallet.publicKey)
    throw new TypeError("A signer wallet with a signing key is required");
  if (!REVOCATION_KINDS.includes(kind))
    throw new TypeError("Unknown revocation kind");
  if (typeof target !== "string" || !TARGET_PATTERNS[kind].test(target))
    throw new TypeError("Invalid revocation target for this kind");
  if (typeof origin !== "string" || !origin || origin.length > 200)
    throw new TypeError("An exact origin is required");
  if (typeof room !== "string" || !room || room.length > 100)
    throw new TypeError("A room name is required");
  if (!Number.isFinite(now)) throw new TypeError("Invalid timestamp");
  const fields = {
    type: REVOCATION_TYPE,
    v: REVOCATION_VERSION,
    id: randomId(),
    kind,
    target,
    origin,
    room,
    issuer: publicJwk(signerWallet.publicKey),
    issuedAt: now,
  };
  const signature = await signDomain(
    signerWallet.privateKey,
    DOMAIN,
    bodyOf(fields),
  );
  return Object.freeze({ ...fields, signature });
}

function shapeError(r) {
  if (!isObject(r) || r.type !== REVOCATION_TYPE || r.v !== REVOCATION_VERSION)
    return "malformed";
  const keys = Object.keys(r);
  if (keys.length !== KEYS.length + 1 || !KEYS.every((k) => k in r))
    return "malformed";
  if (
    typeof r.id !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/u.test(r.id) ||
    typeof r.signature !== "string" ||
    !REVOCATION_KINDS.includes(r.kind) ||
    typeof r.target !== "string" ||
    !TARGET_PATTERNS[r.kind].test(r.target) ||
    typeof r.origin !== "string" ||
    typeof r.room !== "string" ||
    !isObject(r.issuer) ||
    !Number.isFinite(r.issuedAt)
  )
    return "malformed";
  return null;
}

async function issuerTrusted(record, issuerId, issuers) {
  if (record.kind === "wallet" && record.target === issuerId) return true;
  if (!Array.isArray(issuers)) return false;
  for (const entry of issuers) {
    try {
      const id =
        typeof entry === "string" ? entry : await identityFor(publicJwk(entry));
      if (id === issuerId) return true;
    } catch {
      /* an unusable trust entry never widens trust */
    }
  }
  return false;
}

/** Locally verify a revocation record. Fails closed on any missing input. */
export async function verifyRevocation(
  record,
  { trustPolicy, expectedOrigin, expectedRoom, now } = {},
) {
  const at = typeof now === "function" ? now() : (now ?? Date.now());
  const bad = shapeError(record);
  if (bad) return fail(bad);
  if (!expectedOrigin || !expectedRoom) return fail("expectations-required");
  if (record.origin !== expectedOrigin) return fail("wrong-origin");
  if (record.room !== expectedRoom) return fail("wrong-room");
  if (record.issuedAt > at + CLOCK_SKEW_MS) return fail("not-yet-valid");
  let issuerId;
  try {
    issuerId = await identityFor(publicJwk(record.issuer));
  } catch {
    return fail("malformed");
  }
  if (!(await issuerTrusted(record, issuerId, trustPolicy?.issuers)))
    return fail("untrusted-issuer");
  if (
    !(await verifyDomain(
      record.issuer,
      record.signature,
      DOMAIN,
      bodyOf(record),
    ))
  )
    return fail("bad-signature");
  return Object.freeze({ ok: true, record, issuerId });
}

const EPOCH_DOMAIN = "ai-auth-epoch/v1\n";
const EPOCH_KEYS = [
  "type",
  "v",
  "id",
  "epoch",
  "origin",
  "room",
  "issuer",
  "issuedAt",
];
const epochBody = (r) =>
  canonicalize(Object.fromEntries(EPOCH_KEYS.map((k) => [k, r[k]])));

/** Sign an announcement that the site/room authorization epoch is now `epoch`. */
export async function createEpochRecord(
  signerWallet,
  { epoch, origin, room, now = Date.now() } = {},
) {
  if (!signerWallet?.privateKey || !signerWallet.publicKey)
    throw new TypeError("A signer wallet with a signing key is required");
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    throw new TypeError("epoch must be a non-negative integer");
  if (typeof origin !== "string" || !origin || origin.length > 200)
    throw new TypeError("An exact origin is required");
  if (typeof room !== "string" || !room || room.length > 100)
    throw new TypeError("A room name is required");
  const fields = {
    type: EPOCH_TYPE,
    v: EPOCH_VERSION,
    id: randomId(),
    epoch,
    origin,
    room,
    issuer: publicJwk(signerWallet.publicKey),
    issuedAt: now,
  };
  const signature = await signDomain(
    signerWallet.privateKey,
    EPOCH_DOMAIN,
    epochBody(fields),
  );
  return Object.freeze({ ...fields, signature });
}

/** Verify an epoch announcement. Only a trusted issuer may announce an epoch. */
export async function verifyEpochRecord(
  record,
  { trustPolicy, expectedOrigin, expectedRoom, now } = {},
) {
  const at = typeof now === "function" ? now() : (now ?? Date.now());
  const r = record;
  if (
    !isObject(r) ||
    r.type !== EPOCH_TYPE ||
    r.v !== EPOCH_VERSION ||
    Object.keys(r).length !== EPOCH_KEYS.length + 1 ||
    !EPOCH_KEYS.every((k) => k in r) ||
    typeof r.signature !== "string" ||
    typeof r.id !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/u.test(r.id) ||
    !Number.isSafeInteger(r.epoch) ||
    r.epoch < 0 ||
    typeof r.origin !== "string" ||
    typeof r.room !== "string" ||
    !isObject(r.issuer) ||
    !Number.isFinite(r.issuedAt)
  )
    return fail("malformed");
  if (!expectedOrigin || !expectedRoom) return fail("expectations-required");
  if (r.origin !== expectedOrigin) return fail("wrong-origin");
  if (r.room !== expectedRoom) return fail("wrong-room");
  if (r.issuedAt > at + CLOCK_SKEW_MS) return fail("not-yet-valid");
  let issuerId;
  try {
    issuerId = await identityFor(publicJwk(r.issuer));
  } catch {
    return fail("malformed");
  }
  if (
    !(await issuerTrusted(
      { kind: "epoch", target: "" },
      issuerId,
      trustPolicy?.issuers,
    ))
  )
    return fail("untrusted-issuer");
  if (!(await verifyDomain(r.issuer, r.signature, EPOCH_DOMAIN, epochBody(r))))
    return fail("bad-signature");
  return Object.freeze({ ok: true, record: r, issuerId });
}

const SYNC_PEER_INTERVAL_MS = 60_000;
const MAX_SYNC_PEERS = 256;
const MAX_SYNC_ITEMS = 32;
const MAX_SYNC_CHARS = 48_000;

/**
 * Propagate revocations, link revocations and epoch announcements over a
 * room's existing publish/subscribe API (`room.send` / `room.subscribe`).
 * Inbound records are verified and applied to the local policy; each id is
 * processed once, so replays and relay loops are no-ops. Invalid records are
 * never relayed.
 *
 * Catch-up: on first sight of a peer (and on `requestSync()`), peers exchange
 * the latest epoch announcement and at most `CATCHUP_MAX_RECORDS` recent
 * records no older than the policy's catch-up age. Every item is verified and
 * deduplicated like live gossip. A peer offline longer than that age does not
 * converge through gossip; see docs/SECURITY.md.
 */
export function createRevocationGossip(
  room,
  {
    policy = room?.policy,
    revokedLinks,
    onApplied,
    now = () => Date.now(),
  } = {},
) {
  if (typeof room?.send !== "function" || typeof room?.subscribe !== "function")
    throw new TypeError("A room with send() and subscribe() is required");
  if (typeof policy?.applyRevocation !== "function")
    throw new TypeError(
      "A participation policy with applyRevocation() is required",
    );
  const seen = new Set();
  const syncedAt = new Map();
  const diagnostics = [];
  let closed = false;
  const note = (id, reason) => {
    if (diagnostics.length < 64)
      diagnostics.push(Object.freeze({ id, reason }));
  };
  const send = (type, payload, to) =>
    room.send(type, payload, to ? { to } : undefined).catch(() => {});
  const ITEM = {
    revocation: [(i) => i?.id, (r) => policy.applyRevocation(r)],
    epoch: [
      (i) => i?.id,
      (r) => policy.applyEpoch?.(r) ?? { ok: false, reason: "unsupported" },
    ],
    linkRevocation: [
      (i) =>
        typeof i?.body?.payload?.linkId === "string"
          ? `link-event:${i.body.payload.linkId}:${i.body.payload.nonce}`
          : null,
      async (event) => {
        const result = await (policy.applyLinkRevocation?.(event) ?? {
          ok: false,
          reason: "unsupported",
        });
        if (result.ok && revokedLinks?.add)
          await revokedLinks.add(event, {
            expectedOrigin: policy.origin,
            now: now(),
          });
        return result;
      },
    ],
  };
  async function handleItem(kind, record, relay, to) {
    const [keyOf, apply] = ITEM[kind];
    const key = keyOf(record);
    if (closed || typeof key !== "string" || seen.has(key))
      return { ok: true, applied: false };
    if (seen.size >= MAX_SEEN)
      return { ok: false, reason: "gossip-store-full" };
    // Claim the id before the async verify so concurrent copies are dropped.
    seen.add(key);
    const result = await apply(record);
    if (!result.ok) {
      seen.delete(key);
      note(key, result.reason);
      return result;
    }
    if (result.applied) onApplied?.(record);
    if (relay && !closed)
      await send(REVOCATION_GOSSIP_EVENT, { [kind]: record }, to);
    return result;
  }
  const handle = (record, relay) => handleItem("revocation", record, relay);
  function snapshotPayload() {
    const recent = policy.recentRecords?.() ?? {
      epoch: null,
      revocations: [],
      linkRevocations: [],
    };
    const out = { epoch: recent.epoch, revocations: [], linkRevocations: [] };
    let size = recent.epoch ? JSON.stringify(recent.epoch).length : 0;
    for (const key of ["revocations", "linkRevocations"])
      for (const item of recent[key]) {
        size += JSON.stringify(item).length;
        if (size > MAX_SYNC_CHARS) return out;
        out[key].push(item);
      }
    return out;
  }
  async function handleSync(payload) {
    const lists = [
      ["epoch", payload?.epoch ? [payload.epoch] : []],
      ["revocation", payload?.revocations],
      ["linkRevocation", payload?.linkRevocations],
    ];
    for (const [kind, items] of lists) {
      if (!Array.isArray(items)) continue;
      for (const item of items.slice(0, MAX_SYNC_ITEMS))
        await handleItem(kind, item, false);
    }
  }
  const dueForSync = (peer) => {
    const t = now();
    if (syncedAt.size >= MAX_SYNC_PEERS && !syncedAt.has(peer)) return false;
    if (t - (syncedAt.get(peer) ?? -Infinity) < SYNC_PEER_INTERVAL_MS)
      return false;
    syncedAt.set(peer, t);
    return true;
  };
  async function handleEvent(body) {
    const peer = body.issuer;
    if (body.type === REVOCATION_GOSSIP_EVENT) {
      const p = body.payload ?? {};
      for (const kind of Object.keys(ITEM))
        if (p[kind] !== undefined) await handleItem(kind, p[kind], true);
    } else if (body.type === REVOCATION_SYNC_EVENT) {
      await handleSync(body.payload);
    } else if (body.type === REVOCATION_SYNC_REQUEST_EVENT) {
      if (dueForSync(peer))
        await send(REVOCATION_SYNC_EVENT, snapshotPayload(), peer);
    } else if (body.type === "peer/hello" || body.type === "peer/heartbeat") {
      if (!dueForSync(peer)) return;
      if (room.privateMode) await send(REVOCATION_SYNC_REQUEST_EVENT, {}, peer);
      else await send(REVOCATION_SYNC_EVENT, snapshotPayload(), peer);
    }
  }
  const unsubscribe = room.subscribe((event) => {
    const body = event?.direction === "in" ? event.envelope?.body : null;
    if (typeof body?.type !== "string") return;
    void handleEvent(body).catch(() => {});
  });
  return Object.freeze({
    /** Apply a locally created revocation record, then broadcast it. */
    publish: (record) => handle(record, true),
    /** Apply a wallet-signed link revocation event, then broadcast it. */
    publishLinkRevocation: (event) => handleItem("linkRevocation", event, true),
    /** Apply a signed epoch announcement, then broadcast it. */
    publishEpoch: (record) => handleItem("epoch", record, true),
    /** Ask connected peers for their latest epoch and recent revocations. */
    requestSync: () => send(REVOCATION_SYNC_REQUEST_EVENT, {}),
    diagnostics: () => Object.freeze([...diagnostics]),
    close() {
      closed = true;
      unsubscribe();
    },
  });
}
