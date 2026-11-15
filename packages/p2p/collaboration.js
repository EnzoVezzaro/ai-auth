// Application-level messages carried inside independently signed room envelopes.
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
  constructor(room, { authorize = () => true } = {}) {
    this.room = room;
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
  async sendText(text) {
    this.checkAuthorization();
    if (!validText(text))
      throw new TypeError("Messages must contain 1–4000 characters");
    return this.room.send("collab/text", { text });
  }
  async sendElement(metadata) {
    this.checkAuthorization();
    if (!validElement(metadata))
      throw new TypeError(
        "Element metadata must be an object no larger than 4 KiB",
      );
    return this.room.send("collab/element", { metadata });
  }
  async sendAttachment(blob, { kind, name } = {}) {
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
    this.sending = true;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const id = crypto.randomUUID();
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
      return { id, kind, name, mime, size: bytes.length };
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
    if (type === "collab/text" && validText(payload.text))
      this.notify({ type: "text", text: payload.text, envelope });
    else if (type === "collab/element" && validElement(payload.metadata))
      this.notify({ type: "element", metadata: payload.metadata, envelope });
    else if (type === "collab/attachment")
      this.receiveChunk(envelope, issuer, payload);
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
