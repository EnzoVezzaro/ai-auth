import { fetchDiscovery, validateDiscovery } from "@enzovezzaro/ai-auth-wallet";

const MAX_INPUT_CHARS = 16_000;
const MAX_MANIFEST_BYTES = 16_384;
const DISCOVERY_PATH = "/.well-known/ai-auth.json";
const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function exactOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      "Connect input needs an exact HTTPS origin or a connect instruction",
    );
  }
  const allowed =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!allowed)
    throw new TypeError(
      "The site origin must be HTTPS (HTTP only for localhost)",
    );
  return url.origin;
}

function capabilityList(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > 32 ||
    new Set(values).size !== values.length ||
    values.some((v) => typeof v !== "string" || !CAPABILITY_PATTERN.test(v))
  )
    throw new TypeError(
      "Capabilities must be a non-empty list of explicit names (no wildcards)",
    );
  return Object.freeze([...values].sort());
}

function descriptor({
  origin,
  room,
  capabilities,
  source,
  discoveryOnly,
  walletUrl,
  allowEmptyCapabilities = false,
}) {
  const exact = exactOrigin(origin);
  if (exact !== origin)
    throw new TypeError("origin must be an exact origin without a path");
  if (typeof room !== "string" || !ROOM_PATTERN.test(room))
    throw new TypeError("room must be 1–100 safe characters");
  // A copied instruction must name explicit scopes; discovery may omit them.
  const caps =
    allowEmptyCapabilities && (!capabilities || capabilities.length === 0)
      ? Object.freeze([])
      : capabilityList(capabilities);
  return Object.freeze({
    origin,
    room,
    walletUrl: typeof walletUrl === "string" ? walletUrl : null,
    capabilities: caps,
    source,
    discoveryOnly,
  });
}

function fromInstructionText(text) {
  const field = (name) =>
    new RegExp(`^${name}:[ \\t]*(.+)$`, "mu").exec(text)?.[1]?.trim();
  const caps = field("Capabilities");
  return descriptor({
    origin: field("Origin") ?? "",
    room: field("Room") ?? "default",
    walletUrl: field("Wallet"),
    capabilities: caps ? caps.split(",").map((c) => c.trim()) : [],
    source: "instruction",
    discoveryOnly: false,
  });
}

/**
 * Parse what a person pastes: a createAIAuthConnectInstruction() text, its JSON
 * descriptor, or a plain site URL. A URL yields only an origin: it starts
 * discovery and can never stand in for consent.
 */
export function parseConnectInput(input) {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > MAX_INPUT_CHARS
  )
    throw new TypeError(
      "Connect input must be a non-empty connect instruction or site URL",
    );
  const text = input.trim();
  if (text.startsWith("{")) {
    let meta;
    try {
      meta = JSON.parse(text);
    } catch {
      throw new TypeError("Connect input JSON is not valid");
    }
    if (meta?.protocol !== "ai-auth-wallet" || meta.version !== 1)
      throw new TypeError("Connect input is not an AI Auth connect descriptor");
    return descriptor({
      ...meta,
      room: meta.room ?? "default",
      source: "instruction",
      discoveryOnly: false,
    });
  }
  if (/^Origin:/mu.test(text)) return fromInstructionText(text);
  const origin = exactOrigin(text);
  return Object.freeze({
    origin,
    room: null,
    walletUrl: null,
    capabilities: Object.freeze([]),
    source: "url",
    discoveryOnly: true,
  });
}

/**
 * Fetch the legacy provisional hint for sites that have not moved to v1.
 * Shape: { origin, room?, capabilities[], walletUrl? }. It is kept only as a
 * clearly marked fallback and still goes through the strict validator (on the
 * overlapping fields) so secrets and malformed scopes are not accepted.
 */
async function fetchProvisionalManifest(
  origin,
  { fetch: fetchImpl, timeoutMs },
) {
  const exact = exactOrigin(origin);
  const response = await fetchImpl(`${exact}${DISCOVERY_PATH}`, {
    redirect: "error",
    credentials: "omit",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(
      `The site publishes no AI Auth discovery document (HTTP ${response.status})`,
    );
  const body = await response.text();
  if (body.length > MAX_MANIFEST_BYTES)
    throw new Error("The site manifest is too large");
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch {
    throw new Error("The site manifest is not valid JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("The site manifest is not an object");
  if (manifest.origin !== exact)
    throw new Error(
      "The site manifest does not match the origin it was served from",
    );
  // A strict document that failed for another reason must not be relabelled as
  // legacy; only the old, typeless shape is eligible for this fallback.
  if (manifest.type !== undefined || manifest.v !== undefined)
    throw new Error("The site publishes an invalid AI Auth discovery document");
  const upgraded = {
    type: "ai-auth-discovery",
    v: 1,
    origin: manifest.origin,
    ...(manifest.capabilities !== undefined && {
      capabilities: manifest.capabilities,
    }),
    ...(manifest.walletUrl !== undefined && { walletUrl: manifest.walletUrl }),
  };
  const check = validateDiscovery(upgraded, { origin: exact });
  if (!check.ok)
    throw new Error(`The legacy site manifest is invalid: ${check.reason}`);
  return manifest;
}

/**
 * Fetch `/.well-known/ai-auth.json` for an origin and turn the strict v1
 * discovery document into a real room and capability list. Validation and the
 * safe fetch are shared with packages/p2p/discovery.js, so a URL-only chat
 * instruction gets the same guarantees as a direct fetchDiscovery() call.
 * Discovery data is public and unsigned; it never grants anything by itself.
 * Old typeless manifests still work, marked `provisional: true`.
 */
export async function fetchSiteManifest(
  origin,
  { fetch: fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {},
) {
  const exact = exactOrigin(origin);
  const strict = await fetchDiscovery(exact, {
    fetch: fetchImpl,
    timeoutMs,
    baseUrl: origin,
  });
  if (strict.ok) {
    const doc = strict.discovery;
    const base = descriptor({
      origin: doc.origin,
      room: doc.rooms?.[0]?.name ?? "default",
      walletUrl: doc.walletUrl,
      capabilities: doc.capabilities ?? [],
      source: "manifest",
      discoveryOnly: true,
      allowEmptyCapabilities: true,
    });
    return Object.freeze({ ...base, provisional: false });
  }

  const legacy = await fetchProvisionalManifest(exact, {
    fetch: fetchImpl,
    timeoutMs,
  });
  const base = descriptor({
    origin: legacy.origin,
    room: legacy.room ?? "default",
    walletUrl: legacy.walletUrl,
    capabilities: legacy.capabilities ?? [],
    source: "manifest-provisional",
    discoveryOnly: true,
    allowEmptyCapabilities: true,
  });
  return Object.freeze({
    ...base,
    provisional: true,
    strictReason: strict.reason,
  });
}
