// Site discovery document: `/.well-known/ai-auth.json`, schema v1.
// This is an AI Auth convention. It is NOT a WebMCP standard, not OAuth
// metadata, and not llms.txt (see docs/DISCOVERY.md). It is public, unsigned
// advertising: a hint for where to connect, never proof of anything. Consent
// is still a signed wallet approval bound to the exact origin.

export const DISCOVERY_TYPE = "ai-auth-discovery";
export const DISCOVERY_VERSION = 1;
export const DISCOVERY_PATH = "/.well-known/ai-auth.json";
export const MAX_DISCOVERY_BYTES = 16 * 1024;
export const DISCOVERY_TIMEOUT_MS = 8_000;
// Scopes a discovery document may ask for. `tasks.delegate` stays accepted so
// existing documents are not rejected, but it is not offered as a default:
// there is no task protocol behind it yet.
export const DISCOVERY_CAPABILITIES = Object.freeze([
  "presence.read",
  "messages.send",
  "content.share",
  "tools.invoke",
]);
const ACCEPTED_CAPABILITIES = Object.freeze([
  ...DISCOVERY_CAPABILITIES,
  "tasks.delegate",
]);

const KEYS = new Set([
  "type",
  "v",
  "origin",
  "name",
  "walletUrl",
  "docsUrl",
  "capabilities",
  "rooms",
  "issuers",
  "webmcp",
]);
const ROOM_KEYS = new Set(["name", "mode"]);
const ROOM_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const WALLET_ID = /^agent:[A-Za-z0-9_-]{20,100}$/u;
// Public documents must not carry credentials, even by accident.
const SECRET_KEY =
  /secret|token|passw|api[-_]?key|private|bearer|credential|session[-_]?key/iu;
const SECRET_VALUE =
  /(bearer\s+[a-z0-9._~+/-]{10,}|-----BEGIN [A-Z ]*PRIVATE|sk-[a-z0-9]{16,}|eyJ[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]{10,}\.)/iu;

const fail = (reason) => ({ ok: false, reason });
const isLocalHost = (host) =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** Parse an exact origin: https, or http only for localhost. Returns "" if unusable. */
export function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length > 200) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && isLocalHost(url.hostname)))
    return "";
  if (url.username || url.password || url.search || url.hash) return "";
  if (url.pathname !== "/" || value.endsWith("//")) return "";
  return url.origin === value || `${url.origin}/` === value ? url.origin : "";
}

function secretFree(value, depth = 0) {
  if (depth > 6) return false;
  if (typeof value === "string") return !SECRET_VALUE.test(value);
  if (Array.isArray(value)) return value.every((v) => secretFree(v, depth + 1));
  if (value && typeof value === "object")
    return Object.entries(value).every(
      ([key, v]) => !SECRET_KEY.test(key) && secretFree(v, depth + 1),
    );
  return true;
}

const httpsUrl = (value) => {
  try {
    const url = new URL(value);
    return (
      value.length <= 300 &&
      !url.username &&
      !url.password &&
      !url.search &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLocalHost(url.hostname)))
    );
  } catch {
    return false;
  }
};

function checkRooms(rooms) {
  if (!Array.isArray(rooms) || rooms.length > 8) return false;
  return rooms.every(
    (room) =>
      room &&
      typeof room === "object" &&
      Object.keys(room).every((k) => ROOM_KEYS.has(k)) &&
      ROOM_NAME.test(room.name ?? "") &&
      (room.mode === "open" || room.mode === "restricted"),
  );
}

/** Validate a discovery document for an exact expected origin. */
export function validateDiscovery(doc, { origin } = {}) {
  const expected = normalizeOrigin(origin);
  if (!expected) return fail("bad-origin");
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return fail("not-an-object");
  if (!secretFree(doc)) return fail("contains-secret");
  if (Object.keys(doc).some((key) => !KEYS.has(key)))
    return fail("unknown-field");
  if (doc.type !== DISCOVERY_TYPE || doc.v !== DISCOVERY_VERSION)
    return fail("not-a-v1-document");
  if (doc.origin !== expected) return fail("origin-mismatch");
  if (
    doc.name !== undefined &&
    (typeof doc.name !== "string" || !doc.name || doc.name.length > 80)
  )
    return fail("bad-name");
  for (const key of ["walletUrl", "docsUrl"])
    if (doc[key] !== undefined && !httpsUrl(doc[key]))
      return fail(`bad-${key}`);
  const caps = doc.capabilities;
  if (
    caps !== undefined &&
    (!Array.isArray(caps) ||
      caps.length > ACCEPTED_CAPABILITIES.length ||
      new Set(caps).size !== caps.length ||
      !caps.every((c) => ACCEPTED_CAPABILITIES.includes(c)))
  )
    return fail("bad-capabilities");
  if (doc.rooms !== undefined && !checkRooms(doc.rooms))
    return fail("bad-rooms");
  if (
    doc.issuers !== undefined &&
    (!Array.isArray(doc.issuers) ||
      doc.issuers.length > 8 ||
      !doc.issuers.every((i) => WALLET_ID.test(i)))
  )
    return fail("bad-issuers");
  if (doc.webmcp !== undefined && typeof doc.webmcp !== "boolean")
    return fail("bad-webmcp");
  return { ok: true, discovery: Object.freeze(structuredClone(doc)) };
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch and validate the discovery document of `origin`. Never follows
 * redirects, sends no credentials, caps the body, and requires the document's
 * own `origin` to equal the requested origin exactly.
 */
export async function fetchDiscovery(
  origin,
  {
    fetch: fetchImpl = globalThis.fetch,
    maxBytes = MAX_DISCOVERY_BYTES,
    timeoutMs = DISCOVERY_TIMEOUT_MS,
  } = {},
) {
  const expected = normalizeOrigin(origin);
  if (!expected) return fail("bad-origin");
  if (typeof fetchImpl !== "function") return fail("no-fetch");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${expected}${DISCOVERY_PATH}`, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return fail("http-error");
    const type = response.headers?.get?.("content-type") ?? "";
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json\b/iu.test(type))
      return fail("bad-content-type");
    const text = await readCapped(response, maxBytes);
    if (text === null) return fail("too-large");
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return fail("bad-json");
    }
    return validateDiscovery(doc, { origin: expected });
  } catch {
    return fail("fetch-failed");
  } finally {
    clearTimeout(timer);
  }
}
