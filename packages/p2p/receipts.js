// Signed delivery receipts and a bounded per-message delivery ledger.
//
// A receipt is an ordinary signed room envelope of type "ai-auth-receipt" whose
// issuer is the RECEIVER. It proves that the receiver's wallet key signed "I
// accepted message M from sender S in this room and origin" at some time. It
// does NOT prove that a human saw, read, or understood the content.
import { verifyEnvelope } from "./index.js";

export const RECEIPT_TYPE = "ai-auth-receipt";
export const RECEIPT_VERSION = 1;
export const MESSAGE_STATES = Object.freeze([
  "composing",
  "queued",
  "sent-to-transport",
  "received-by-peer",
  "failed",
  "expired",
]);
const STATE_TRANSITIONS = Object.freeze({
  composing: ["queued", "failed"],
  queued: ["sent-to-transport", "received-by-peer", "failed", "expired"],
  "sent-to-transport": ["received-by-peer", "failed", "expired"],
  "received-by-peer": [],
  failed: [],
  expired: [],
});
export const RECEIPT_TTL_MS = 3 * 60 * 1000;
const CLOCK_SKEW_MS = 30_000;
const MESSAGE_ID = /^[a-f0-9-]{36}$/iu;
const WALLET_ID = /^agent:[A-Za-z0-9_-]{20,100}$/u;
const MAX_HISTORY = 100;
const MAX_SEEN_NONCES = 1024;

export const isMessageId = (value) =>
  typeof value === "string" && MESSAGE_ID.test(value);
export const isWalletId = (value) =>
  typeof value === "string" && WALLET_ID.test(value);
export const canTransitionMessage = (from, to) =>
  STATE_TRANSITIONS[from]?.includes(to) === true;

/** True unless a signed target is present and names a different wallet. */
export function isAddressedTo(payload, selfId) {
  if (payload?.target === undefined) return true;
  return isWalletId(payload.target) && payload.target === selfId;
}

/** Payload fields for a receipt; the room adds room, origin, session, nonce. */
export function buildReceiptPayload({
  messageId,
  sender,
  receiver,
  receivedAt = Date.now(),
}) {
  if (!isMessageId(messageId)) throw new TypeError("Invalid message id");
  if (!isWalletId(sender) || !isWalletId(receiver))
    throw new TypeError("Invalid sender or receiver wallet id");
  return { v: RECEIPT_VERSION, messageId, sender, receiver, receivedAt };
}

const fail = (reason) => ({ ok: false, reason });

function checkBinding(body, expected, now) {
  const payload = body?.payload;
  if (body?.type !== RECEIPT_TYPE || payload?.v !== RECEIPT_VERSION)
    return "not-a-v1-receipt";
  if (payload.room !== expected.room) return "wrong-room";
  if (payload.origin !== expected.origin) return "wrong-origin";
  if (payload.sender !== expected.sender) return "wrong-sender";
  if (!isWalletId(payload.receiver) || payload.receiver !== body.issuer)
    return "receiver-mismatch";
  if (payload.receiver === payload.sender) return "self-receipt";
  if (!isMessageId(payload.messageId)) return "bad-message-id";
  if (!Number.isFinite(payload.receivedAt)) return "bad-time";
  if (typeof payload.nonce !== "string" || payload.nonce.length < 20)
    return "bad-nonce";
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= now)
    return "expired-envelope";
  return "";
}

/**
 * Verify a receipt envelope for the local sender. Checks the signature, that
 * the signer is the named receiver, and the exact room/origin/sender binding.
 */
export async function verifyReceipt(
  envelope,
  { sender, room, origin, now = Date.now() } = {},
) {
  const reason = checkBinding(envelope?.body, { sender, room, origin }, now);
  if (reason) return fail(reason);
  const { payload } = envelope.body;
  if (payload.receivedAt > now + CLOCK_SKEW_MS) return fail("bad-time");
  if (!(await verifyEnvelope(envelope, { expectedIssuer: payload.receiver })))
    return fail("bad-signature");
  return {
    ok: true,
    receipt: Object.freeze({
      messageId: payload.messageId,
      receiver: payload.receiver,
      receivedAt: payload.receivedAt,
      nonce: payload.nonce,
    }),
  };
}

const snapshot = (entry) =>
  Object.freeze({
    ...entry,
    receivers: Object.freeze([...entry.receivers.keys()]),
  });

/**
 * Bounded history of outgoing messages. Delivery is only ever advanced by
 * `applyReceipt` with a verified receipt; nothing else can set
 * "received-by-peer".
 */
export function createDeliveryLedger({
  now = Date.now,
  limit = MAX_HISTORY,
  ttlMs = RECEIPT_TTL_MS,
} = {}) {
  const entries = new Map();
  const seenNonces = new Set();
  const listeners = new Set();
  const emit = (entry) => {
    for (const listener of [...listeners]) {
      try {
        listener(snapshot(entry));
      } catch {
        // A UI subscriber must not break delivery bookkeeping.
      }
    }
  };
  const move = (entry, state, extra = {}) => {
    if (!canTransitionMessage(entry.state, state))
      throw new Error(`Illegal message transition ${entry.state} -> ${state}`);
    Object.assign(entry, extra, { state, updatedAt: now() });
    emit(entry);
  };
  const need = (messageId) => {
    const entry = entries.get(messageId);
    if (!entry) throw new Error("Unknown message");
    return entry;
  };
  return {
    /** Start a message in `composing`. `target` undefined = public room. */
    begin({ messageId, kind, target, summary = "" }) {
      if (!isMessageId(messageId)) throw new TypeError("Invalid message id");
      if (target !== undefined && !isWalletId(target))
        throw new TypeError("Invalid target wallet id");
      if (entries.has(messageId)) throw new Error("Duplicate message id");
      const entry = {
        messageId,
        kind: String(kind).slice(0, 32),
        target,
        summary: String(summary).slice(0, 200),
        state: "composing",
        error: undefined,
        createdAt: now(),
        updatedAt: now(),
        sentAt: 0,
        receivers: new Map(),
      };
      entries.set(messageId, entry);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      emit(entry);
      return snapshot(entry);
    },
    queue: (messageId) => move(need(messageId), "queued"),
    markSent: (messageId) =>
      move(need(messageId), "sent-to-transport", { sentAt: now() }),
    /** Drop a message that was never queued (the user discarded the draft). */
    discard(messageId) {
      if (entries.get(messageId)?.state === "composing")
        entries.delete(messageId);
    },
    fail: (messageId, error) =>
      move(need(messageId), "failed", {
        error: String(error?.message ?? error ?? "failed").slice(0, 200),
      }),
    /** Apply a receipt already checked by `verifyReceipt`. */
    applyReceipt(receipt) {
      const entry = entries.get(receipt?.messageId);
      if (!entry) return fail("unknown-message");
      if (
        !["queued", "sent-to-transport", "received-by-peer"].includes(
          entry.state,
        )
      )
        return fail("not-awaiting-receipt");
      if (entry.target !== undefined && receipt.receiver !== entry.target)
        return fail("wrong-receiver");
      if (entry.receivers.has(receipt.receiver)) return fail("replay");
      if (seenNonces.has(receipt.nonce)) return fail("replay");
      if (now() - entry.createdAt > ttlMs) return fail("expired");
      if (receipt.receivedAt < entry.createdAt - CLOCK_SKEW_MS)
        return fail("bad-time");
      seenNonces.add(receipt.nonce);
      if (seenNonces.size > MAX_SEEN_NONCES)
        seenNonces.delete(seenNonces.values().next().value);
      entry.receivers.set(receipt.receiver, receipt.receivedAt);
      if (entry.state === "received-by-peer") {
        entry.updatedAt = now();
        emit(entry);
      } else move(entry, "received-by-peer");
      return { ok: true };
    },
    /** Expire messages that stayed unacknowledged past the TTL. */
    sweep() {
      for (const entry of entries.values()) {
        const base = entry.state === "queued" ? entry.createdAt : entry.sentAt;
        if (
          (entry.state === "queued" || entry.state === "sent-to-transport") &&
          now() - base > ttlMs
        )
          move(entry, "expired");
      }
    },
    get: (messageId) =>
      entries.has(messageId) ? snapshot(entries.get(messageId)) : undefined,
    list: () => [...entries.values()].map(snapshot),
    subscribe(listener) {
      if (typeof listener !== "function")
        throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
