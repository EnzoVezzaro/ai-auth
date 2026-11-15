// Application-level messages carried inside independently signed room envelopes.
import {
  RECEIPT_TYPE,
  buildReceiptPayload,
  isAddressedTo,
  isMessageId,
  isWalletId,
  verifyReceipt,
} from "./receipts.js";

export const COLLABORATION_LIMITS = Object.freeze({
  textCharacters: 4000,
  elementBytes: 4096,
  screenshotBytes: 512 * 1024,
  recordingBytes: 1024 * 1024,
});

const CHUNK_BYTES = 24 * 1024;
const CHUNK_INTERVAL_MS = 1800;
const TRANSFER_TTL_MS = 3 * 60 * 1000;
const MAX_TRANSFERS = 4;
const MEDIA_TYPES = {
  screenshot: new Set(["image/png", "image/jpeg", "image/webp"]),
  recording: new Set(["video/webm", "video/mp4"]),
};
// Browsers and MediaRecorder append codec/parameter suffixes (for example
// "video/webm;codecs=vp9"). Validate the base media type on the same
// normalized value for outgoing and incoming media.
function normalizeMime(value) {
  if (typeof value !== "string") return "";
  const [type] = value.split(";");
  return type.trim().toLowerCase();
}
function mediaMime(kind, value) {
  const mime = normalizeMime(value);
  return MEDIA_TYPES[kind]?.has(mime) ? mime : "";
}
const encoder = new TextEncoder();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const validText = (text) =>
  typeof text === "string" &&
  text.length > 0 &&
  text.length <= COLLABORATION_LIMITS.textCharacters;
const validElement = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return (
      encoder.encode(JSON.stringify(value)).length <=
      COLLABORATION_LIMITS.elementBytes
    );
  } catch {
    return false;
  }
};
const mediaLimit = (kind) =>
  kind === "screenshot"
    ? COLLABORATION_LIMITS.screenshotBytes
    : kind === "recording"
      ? COLLABORATION_LIMITS.recordingBytes
      : 0;
const validName = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  name.length <= 120 &&
  !/[\u0000-\u001f\u007f/\\]/u.test(name);
function encodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeBytes(value) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  )
    throw new Error("Invalid attachment chunk");
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class CollaborationTransfers {
  constructor(room, { authorize = () => true, receipts = true } = {}) {
    this.room = room;
    // Capability flags the wheel reads before it offers targeting or receipts.
    this.supportsTargets = true;
    this.supportsReceipts = receipts !== false;
    this.sendReceipts = receipts !== false;
    this.authorize = authorize;
    this.listeners = new Set();
    this.transfers = new Map();
    this.closed = false;
    this.sending = false;
    this.unsubscribe = room.subscribe((event) => {
      if (event.direction === "in") this.receive(event.envelope);
    });
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  notify(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Collaboration listener failed", error);
      }
    }
  }
  // `messageId` and `target` live in the signed payload. A target addresses
  // one wallet; it is not encryption (see docs/SECURITY.md).
  addressing({ messageId, target } = {}) {
    if (messageId !== undefined && !isMessageId(messageId))
      throw new TypeError("Invalid message id");
    if (target !== undefined && !isWalletId(target))
      throw new TypeError("Invalid target wallet id");
    return {
      messageId: messageId ?? crypto.randomUUID(),
      ...(target === undefined ? {} : { target }),
    };
  }
  async sendText(text, options) {
    this.checkAuthorization();
    if (!validText(text))
      throw new TypeError("Messages must contain 1–4000 characters");
    return this.room.send("collab/text", {
      text,
      ...this.addressing(options),
    });
  }
  async sendElement(metadata, options) {
    this.checkAuthorization();
    if (!validElement(metadata))
      throw new TypeError(
        "Element metadata must be an object no larger than 4 KiB",
      );
    return this.room.send("collab/element", {
      metadata,
      ...this.addressing(options),
    });
  }
  async sendAttachment(blob, { kind, name, messageId, target } = {}) {
    this.checkAuthorization();
    if (this.closed || this.sending)
      throw new Error(
        "Another attachment is being sent or collaboration is closed",
      );
    const mime = mediaMime(kind, blob?.type);
    const limit = mediaLimit(kind);
    if (
      !(blob instanceof Blob) ||
      !limit ||
      !mime ||
      !validName(name) ||
      blob.size < 1 ||
      blob.size > limit
    )
      throw new TypeError("Unsupported attachment type, name, or size");
    const addressing = this.addressing({ messageId, target });
    this.sending = true;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const id = addressing.messageId;
      const total = Math.ceil(bytes.length / CHUNK_BYTES);
      for (let index = 0; index < total; index++) {
        if (this.closed)
          throw new Error("Collaboration was closed during transfer");
        if (index) await delay(CHUNK_INTERVAL_MS);
        if (this.closed)
          throw new Error("Collaboration was closed during transfer");
        this.checkAuthorization();
        if (!this.room.hasDirectPeer())
          throw new Error(
            "A direct peer connection is required for attachments",
          );
        await this.room.send("collab/attachment", {
          ...addressing,
          id,
          kind,
          name,
          mime,
          size: bytes.length,
          total,
          index,
          data: encodeBytes(
            bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
          ),
        });
      }
      return { id, messageId: id, kind, name, mime, size: bytes.length };
    } finally {
      this.sending = false;
    }
  }
  checkAuthorization() {
    if (this.closed || !this.authorize())
      throw new Error("Collaboration authorization has expired or closed");
  }
  receive(envelope) {
    if (this.closed || !this.authorize() || !envelope?.body) return;
    const { type, payload, issuer } = envelope.body;
    if (type === RECEIPT_TYPE) return void this.receiveReceipt(envelope);
    // A message signed for another wallet is dropped, never displayed.
    if (
      type?.startsWith("collab/") &&
      !isAddressedTo(payload, this.room.wallet?.id)
    )
      return;
    if (type === "collab/text" && validText(payload.text)) {
      this.notify({ type: "text", text: payload.text, envelope });
      this.acknowledge(envelope);
    } else if (type === "collab/element" && validElement(payload.metadata)) {
      this.notify({ type: "element", metadata: payload.metadata, envelope });
      this.acknowledge(envelope);
    } else if (type === "collab/attachment")
      this.receiveChunk(envelope, issuer, payload);
  }
  // Sign a receipt for a message that was addressed to this wallet and shown.
  acknowledge(envelope, messageId = envelope.body.payload?.messageId) {
    if (!this.sendReceipts || !isMessageId(messageId)) return;
    const receiver = this.room.wallet?.id;
    const sender = envelope.body.issuer;
    if (!isWalletId(receiver) || !isWalletId(sender) || sender === receiver)
      return;
    // Best effort: a lost receipt only leaves the sender at "sent-to-transport".
    this.room
      .send(RECEIPT_TYPE, buildReceiptPayload({ messageId, sender, receiver }))
      .catch(() => {});
  }
  async receiveReceipt(envelope) {
    const { room, wallet, origin } = this.room;
    const result = await verifyReceipt(envelope, {
      sender: wallet?.id,
      room,
      origin,
    });
    if (!result.ok || this.closed || !this.authorize()) return;
    this.notify({ type: "receipt", receipt: result.receipt, envelope });
  }
  receiveChunk(envelope, issuer, payload) {
    const now = Date.now();
    for (const [key, transfer] of this.transfers)
      if (transfer.expiresAt <= now) this.transfers.delete(key);
    const { id, kind, name, size, total, index, data, session } = payload ?? {};
    const limit = mediaLimit(kind);
    const mime = mediaMime(kind, payload?.mime);
    if (
      typeof id !== "string" ||
      !/^[a-f0-9-]{36}$/iu.test(id) ||
      !limit ||
      !mime ||
      !validName(name) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > limit ||
      total !== Math.ceil(size / CHUNK_BYTES) ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= total
    )
      return;
    let chunk;
    try {
      chunk = decodeBytes(data);
    } catch {
      return;
    }
    if (
      chunk.length !==
      (index === total - 1 ? size - index * CHUNK_BYTES : CHUNK_BYTES)
    )
      return;
    const key = `${issuer}:${session}:${id}`;
    let transfer = this.transfers.get(key);
    if (!transfer) {
      if (this.transfers.size >= MAX_TRANSFERS) return;
      transfer = {
        kind,
        name,
        mime,
        size,
        total,
        chunks: new Array(total),
        count: 0,
        expiresAt: now + TRANSFER_TTL_MS,
      };
      this.transfers.set(key, transfer);
    }
    if (
      transfer.kind !== kind ||
      transfer.name !== name ||
      transfer.mime !== mime ||
      transfer.size !== size ||
      transfer.total !== total ||
      transfer.chunks[index]
    )
      return;
    transfer.chunks[index] = chunk;
    transfer.count++;
    if (transfer.count === total) {
      this.transfers.delete(key);
      this.acknowledge(envelope, id);
      this.notify({
        type: "attachment",
        kind,
        name,
        mime,
        size,
        blob: new Blob(transfer.chunks, { type: mime }),
        envelope,
      });
    }
  }
  close() {
    this.closed = true;
    this.unsubscribe();
    this.transfers.clear();
    this.listeners.clear();
  }
}
