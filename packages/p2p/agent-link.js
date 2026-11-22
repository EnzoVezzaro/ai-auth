// Agent connect links: a site connects an agent without touching a wallet.
//
// The agent carries its own wallet on its own machine. A site never opens,
// hosts or chooses a wallet. Instead:
//
//   1. The site page joins its AI Auth room with a short-lived site key and
//      shows a one-time connect link (this module creates it).
//   2. Whoever runs the agent hands it the link. The agent (locally or on
//      another computer) uses its own identity, approves the scopes on its
//      own machine, joins the room and proves it holds the link.
//   3. The site remembers the agent's public id. Next time the agent is in
//      the room, the site checks it with a fresh signed challenge and it is
//      connected again with no new link.
//
// The link is a one-time pass: it is valid for one agent, for a few minutes,
// for one page session. Its secret travels in the URL fragment, which
// browsers never send to a server. Possession of the link is what admits an
// agent, so treat it like a pairing code and share it only with your agent.

export const AGENT_LINK_PARAM = "ai-auth-link";
export const AGENT_LINK_EVENTS = Object.freeze({
  hello: "agent/link-hello",
  accept: "agent/link-accept",
  challenge: "agent/site-challenge",
  response: "agent/site-response",
});
export const DEFAULT_AGENT_LINK_TTL_MS = 10 * 60_000;
export const MAX_AGENT_LINK_TTL_MS = 30 * 60_000;

const LINK_CAPABILITIES = new Set([
  "presence.read",
  "messages.send",
  "content.share",
  "tools.invoke",
]);
const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/u;
const ID_PATTERN = /^agent:[A-Za-z0-9_-]{20,100}$/u;
const MAX_TOKEN_CHARS = 2_048;
const LINK_FIELDS = [
  "type",
  "v",
  "origin",
  "room",
  "site",
  "name",
  "capabilities",
  "code",
  "expiresAt",
];

const subtle = () => {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error("Web Crypto is required for AI Auth agent links");
  return api;
};

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(text) {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function randomAgentLinkCode() {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export function randomAgentLinkNonce() {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(24)));
}

/** An exact web origin; plain HTTP is accepted only for loopback hosts. */
export function validLinkOrigin(value) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

function validCapabilities(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= LINK_CAPABILITIES.size &&
    new Set(value).size === value.length &&
    value.every((cap) => LINK_CAPABILITIES.has(cap))
  );
}

/** Validate a decoded link payload. Returns a frozen copy or throws. */
export function validateAgentLink(
  payload,
  { now = Date.now(), allowExpired = false } = {},
) {
  const fail = (reason) => {
    const error = new TypeError(`Invalid AI Auth connect link: ${reason}`);
    error.code = "INVALID_AGENT_LINK";
    throw error;
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    fail("not an object");
  if (Object.keys(payload).some((key) => !LINK_FIELDS.includes(key)))
    fail("unknown field");
  if (payload.type !== "ai-auth-link" || payload.v !== 1) fail("not a v1 link");
  if (!validLinkOrigin(payload.origin)) fail("bad origin");
  if (!ROOM_PATTERN.test(payload.room ?? "")) fail("bad room");
  if (!ID_PATTERN.test(payload.site ?? "")) fail("bad site key");
  if (
    typeof payload.name !== "string" ||
    !payload.name.trim() ||
    payload.name.length > 80 ||
    // No control characters: the name is printed to terminals and pages.
    /[\u0000-\u001f\u007f-\u009f]/u.test(payload.name)
  )
    fail("bad site name");
  if (!validCapabilities(payload.capabilities)) fail("bad capabilities");
  if (!CODE_PATTERN.test(payload.code ?? "")) fail("bad code");
  if (!Number.isFinite(payload.expiresAt)) fail("bad expiry");
  if (payload.expiresAt <= now && !allowExpired) {
    const error = new Error(
      "This AI Auth connect link has expired. Ask the site for a new one.",
    );
    error.code = "AGENT_LINK_EXPIRED";
    throw error;
  }
  if (!allowExpired && payload.expiresAt - now > MAX_AGENT_LINK_TTL_MS + 60_000)
    fail("expiry too far in the future");
  return Object.freeze({
    ...payload,
    capabilities: Object.freeze([...payload.capabilities].sort()),
  });
}

/** Create a one-time link payload for a site page session. */
export function createAgentLinkPayload({
  origin,
  room = "default",
  site,
  name,
  capabilities,
  ttlMs = DEFAULT_AGENT_LINK_TTL_MS,
  now = Date.now(),
} = {}) {
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs < 30_000 ||
    ttlMs > MAX_AGENT_LINK_TTL_MS
  )
    throw new RangeError("Link lifetime must be between 30 s and 30 min");
  return validateAgentLink(
    {
      type: "ai-auth-link",
      v: 1,
      origin,
      room,
      site,
      name: String(name ?? "")
        .trim()
        .slice(0, 80),
      capabilities: [...new Set(capabilities ?? [])].sort(),
      code: randomAgentLinkCode(),
      expiresAt: now + ttlMs,
    },
    { now },
  );
}

export function encodeAgentLinkToken(payload) {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/**
 * The URL a site shows. The token lives in the fragment, never sent to a
 * server. The page's query string is dropped (it may hold unrelated tokens,
 * and the room is inside the token), and the result contains only URL-safe
 * characters with no quote, `$` or backtick, so it is safe inside a quoted
 * shell argument.
 */
export function agentLinkUrl(baseUrl, payload) {
  const url = new URL(baseUrl);
  if (url.origin !== payload.origin)
    throw new TypeError("The link page must be on the site's own origin");
  const path = url.pathname.replace(/[^A-Za-z0-9/._~%-]/gu, (char) =>
    encodeURIComponent(char).replace(
      /[!'()*]/gu,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    ),
  );
  return `${url.origin}${path}#${AGENT_LINK_PARAM}=${encodeAgentLinkToken(payload)}`;
}

function tokenFrom(input) {
  const text = String(input ?? "").trim();
  if (!text) return { token: null, pageOrigin: null };
  let url = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  // Only the full link URL is accepted, so its origin is always checked
  // against the origin inside the token. The token is only read from the
  // fragment, never from a query string a server would log.
  if (!url) return { token: null, pageOrigin: null };
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ""));
  return { token: fragment.get(AGENT_LINK_PARAM), pageOrigin: url.origin };
}

/** True when the input is an AI Auth connect link URL. */
export function isAgentLink(input) {
  const { token } = tokenFrom(input);
  if (!token || token.length > MAX_TOKEN_CHARS) return false;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(token)));
    return decoded?.type === "ai-auth-link";
  } catch {
    return false;
  }
}

/**
 * Parse a connect link URL. The URL's own origin must match the origin inside
 * the token, so a link copied from one site cannot point an agent at another.
 * A link is still a claim by whoever handed it over: use links from the
 * site's own Connect popup only.
 */
export function parseAgentLink(
  input,
  { now = Date.now(), allowExpired = false } = {},
) {
  const { token, pageOrigin } = tokenFrom(input);
  if (
    !token ||
    token.length > MAX_TOKEN_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(token)
  )
    throw new TypeError("Invalid AI Auth connect link: no link token");
  let decoded;
  try {
    decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(token)));
  } catch {
    throw new TypeError("Invalid AI Auth connect link: unreadable token");
  }
  const link = validateAgentLink(decoded, { now, allowExpired });
  if (pageOrigin !== link.origin)
    throw new TypeError(
      "Invalid AI Auth connect link: the page origin does not match the link",
    );
  return link;
}

async function hmac(keyText, parts) {
  const key = await subtle().importKey(
    "raw",
    fromBase64Url(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle().sign(
    "HMAC",
    key,
    new TextEncoder().encode(parts.join("\n")),
  );
  return toBase64Url(new Uint8Array(mac));
}

/**
 * HMAC proof that the agent holds the link's code, bound to the exact site
 * key, agent id and a fresh nonce. The code itself never enters the room.
 */
export async function agentLinkProof({
  code,
  origin,
  room,
  site,
  agent,
  linkNonce,
}) {
  if (!CODE_PATTERN.test(code ?? ""))
    throw new TypeError("A link code is required");
  if (!NONCE_PATTERN.test(linkNonce ?? ""))
    throw new TypeError("A fresh link nonce is required");
  return hmac(code, ["ai-auth-link/v1", origin, room, site, agent, linkNonce]);
}

const PAIR_KEY_FIELDS = ["crv", "kty", "x", "y"];
const B64URL_COORD = /^[A-Za-z0-9_-]{43}$/u;

/** A public ECDH P-256 key as sent in link-hello / link-accept. */
export function isPairPublicKey(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === PAIR_KEY_FIELDS.join() &&
    value.kty === "EC" &&
    value.crv === "P-256" &&
    B64URL_COORD.test(value.x) &&
    B64URL_COORD.test(value.y)
  );
}

/** A fresh ephemeral ECDH key pair for one link redemption. */
export async function createPairKeyPair() {
  const pair = await subtle().generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const { kty, crv, x, y } = await subtle().exportKey("jwk", pair.publicKey);
  return Object.freeze({
    privateKey: pair.privateKey,
    publicKey: Object.freeze({ kty, crv, x, y }),
  });
}

/**
 * The secret a site and an agent share after a link is redeemed. It mixes
 * the link code with an ephemeral ECDH exchange, so neither a room observer
 * nor someone who later finds the used link can derive it. It is never sent.
 * Reconnect challenges are authenticated with it in both directions.
 */
export async function deriveAgentPairSecret({
  code,
  agent,
  linkNonce,
  privateKey,
  peerPublicKey,
}) {
  if (!CODE_PATTERN.test(code ?? ""))
    throw new TypeError("A link code is required");
  if (!isPairPublicKey(peerPublicKey))
    throw new TypeError("A valid peer pair key is required");
  const peer = await subtle().importKey(
    "jwk",
    { ...peerPublicKey, ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await subtle().deriveBits(
    { name: "ECDH", public: peer },
    privateKey,
    256,
  );
  return hmac(code, [
    "ai-auth-pair/v2",
    agent,
    linkNonce,
    toBase64Url(new Uint8Array(shared)),
  ]);
}

const PAIR_ROLES = new Set(["site-challenge", "agent-response"]);

export async function agentPairProof(
  secret,
  { role, origin, room, site, agent, challenge },
) {
  if (!CODE_PATTERN.test(secret ?? ""))
    throw new TypeError("A pair secret is required");
  if (!PAIR_ROLES.has(role)) throw new TypeError("Unknown pair proof role");
  if (!NONCE_PATTERN.test(challenge ?? ""))
    throw new TypeError("A fresh challenge is required");
  return hmac(secret, [
    `ai-auth-pair/${role}`,
    origin,
    room,
    site,
    agent,
    challenge,
  ]);
}

export async function verifyAgentPairProof(secret, fields, proof) {
  try {
    return constantTimeEqual(await agentPairProof(secret, fields), proof);
  } catch {
    return false;
  }
}

export const isAgentPairSecret = (value) =>
  typeof value === "string" && CODE_PATTERN.test(value);

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyAgentLinkProof(link, { agent, linkNonce, proof }) {
  if (!ID_PATTERN.test(agent ?? "") || !NONCE_PATTERN.test(linkNonce ?? ""))
    return false;
  const expected = await agentLinkProof({
    code: link.code,
    origin: link.origin,
    room: link.room,
    site: link.site,
    agent,
    linkNonce,
  });
  return constantTimeEqual(expected, proof);
}

export const isAgentLinkNonce = (value) =>
  typeof value === "string" && NONCE_PATTERN.test(value);
export const isAgentId = (value) =>
  typeof value === "string" && ID_PATTERN.test(value);
export const AGENT_LINK_CAPABILITIES = Object.freeze([...LINK_CAPABILITIES]);
