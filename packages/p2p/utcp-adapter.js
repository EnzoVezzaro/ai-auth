// UTCP adapter: thin wrapper over the official `@utcp/sdk`, with an AI Auth
// destination policy layered *above* the SDK.
//
// Boundaries (docs/architecture/TOOL_PROTOCOLS.md §4, REFERENCE_ARCHITECTURE.md):
// - We never parse a UTCP manual or a tool_call_template ourselves. Discovery,
//   registration and invocation are delegated to an injected client or to a
//   lazily imported `@utcp/sdk`. Tests inject a fake client, so no network is
//   needed and the optional dependency is never required.
// - The native descriptor is preserved verbatim in `native`; translation is
//   additive and never weakens a native field.
// - The destination policy, credential isolation, deadline wrapper and output
//   bound are AI Auth concerns that live here, not in the SDK.
//
// Assumption about worker B's descriptor helpers: `packages/p2p/tool-descriptor.js`
// may export `buildToolDescriptor`/`validateToolDescriptor`. Its exact signature
// is not pinned yet, so this adapter builds a local, minimal UnifiedToolDescriptor
// (REFERENCE_ARCHITECTURE.md §6) and only *optionally* consults the shared
// validator. Namespacing is always enforced locally as `utcp:<manual>:<tool>`.
// A caller can inject `descriptorBuilder` to route through worker B once its
// signature is confirmed, or set `useSharedDescriptorBuilder: true` to attempt
// `buildToolDescriptor(localDescriptor)`.

import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const PROTOCOL = "utcp";
const ID_PREFIX = "utcp:";
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_192;
const DEFAULT_MAX_ERROR_CHARS = 512;

/** Stable, machine-readable codes. Destination denials all use a member of this map. */
export const UTCP_ERROR_CODES = Object.freeze({
  UTCP_SDK_UNAVAILABLE: "UTCP_SDK_UNAVAILABLE",
  UTCP_MANUAL_REQUIRED: "UTCP_MANUAL_REQUIRED",
  UTCP_HOST_NOT_ALLOWED: "UTCP_HOST_NOT_ALLOWED",
  UTCP_SCHEME_REQUIRED: "UTCP_SCHEME_REQUIRED",
  UTCP_PRIVATE_TARGET: "UTCP_PRIVATE_TARGET",
  UTCP_LINK_LOCAL_TARGET: "UTCP_LINK_LOCAL_TARGET",
  UTCP_UNSPECIFIED_TARGET: "UTCP_UNSPECIFIED_TARGET",
  UTCP_MULTICAST_TARGET: "UTCP_MULTICAST_TARGET",
  UTCP_UNRESOLVABLE: "UTCP_UNRESOLVABLE",
  UTCP_LOOPBACK_DENIED: "UTCP_LOOPBACK_DENIED",
  UTCP_LOOPBACK_FROM_REMOTE_MANUAL: "UTCP_LOOPBACK_FROM_REMOTE_MANUAL",
  UTCP_REDIRECT_LIMIT: "UTCP_REDIRECT_LIMIT",
  UTCP_REDIRECT_LOOPBACK: "UTCP_REDIRECT_LOOPBACK",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  TOOL_UNAVAILABLE: "TOOL_UNAVAILABLE",
  UTCP_TOOL_NOT_FOUND: "UTCP_TOOL_NOT_FOUND",
  UTCP_NATIVE_ERROR: "UTCP_NATIVE_ERROR",
  CANCELLED: "CANCELLED",
  TIMEOUT: "TIMEOUT",
  DENIED: "DENIED",
});

export function toolError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra && typeof extra === "object") Object.assign(error, extra);
  return error;
}

// ---------------------------------------------------------------------------
// Namespaced ids
// ---------------------------------------------------------------------------

export function buildUtcpToolId(manual, tool) {
  const m = String(manual ?? "").trim();
  const t = String(tool ?? "").trim();
  if (!m || !t) {
    throw toolError(
      UTCP_ERROR_CODES.UTCP_TOOL_NOT_FOUND,
      "A UTCP tool id needs both a manual and a tool name",
    );
  }
  return `${ID_PREFIX}${m}:${t}`;
}

export function parseUtcpToolId(id) {
  if (typeof id !== "string" || !id.startsWith(ID_PREFIX)) return null;
  const rest = id.slice(ID_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    manual: rest.slice(0, separator),
    tool: rest.slice(separator + 1),
  };
}

// ---------------------------------------------------------------------------
// IP classification (no network; pure string math)
// ---------------------------------------------------------------------------

function stripBrackets(host) {
  return String(host ?? "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
}

function parseIpv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    // Ambiguous octal/hex forms (e.g. 010.0.0.1) are denied rather than guessed.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === "0") return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function parseIpv6(input) {
  let value = input.split("%")[0];
  if (value.includes(".")) {
    const idx = value.lastIndexOf(":");
    if (idx < 0) return null;
    const octets = parseIpv4(value.slice(idx + 1));
    if (!octets) return null;
    const tail = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    value = `${value.slice(0, idx + 1)}${tail}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail =
    halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = [...head, ...(tail ?? [])];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  }
  if (tail === null) {
    if (groups.length !== 8) return null;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups.splice(head.length, 0, ...Array(missing).fill("0"));
  }
  return groups.map((group) => Number.parseInt(group, 16));
}

/** Classify an address: loopback, private, link-local, etc. Hostnames -> "hostname". */
export function classifyUtcpAddress(address) {
  const ip = stripBrackets(address);
  const version = net.isIP(ip);
  if (version === 4) {
    const o = parseIpv4(ip);
    if (!o) return "unknown";
    const [a, b] = o;
    if (a === 0) return "unspecified";
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link-local";
    if (a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a >= 224 && a <= 239) return "multicast";
    if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return "reserved";
    if (a >= 240) return "reserved";
    return "public";
  }
  if (version === 6) {
    const g = parseIpv6(ip);
    if (!g) return "unknown";
    if (g.every((x) => x === 0)) return "unspecified";
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
    if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
    if ((g[0] & 0xfe00) === 0xfc00) return "private"; // ULA
    if ((g[0] & 0xff00) === 0xff00) return "multicast";
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return classifyUtcpAddress(
        `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`,
      );
    }
    return "public";
  }
  return "hostname";
}

function isLoopbackName(host) {
  const h = stripBrackets(host);
  return h === "localhost" || h.endsWith(".localhost");
}

const DENY_BY_CLASS = Object.freeze({
  unspecified: UTCP_ERROR_CODES.UTCP_UNSPECIFIED_TARGET,
  private: UTCP_ERROR_CODES.UTCP_PRIVATE_TARGET,
  "link-local": UTCP_ERROR_CODES.UTCP_LINK_LOCAL_TARGET,
  multicast: UTCP_ERROR_CODES.UTCP_MULTICAST_TARGET,
  reserved: UTCP_ERROR_CODES.UTCP_PRIVATE_TARGET,
  unknown: UTCP_ERROR_CODES.UTCP_UNRESOLVABLE,
});

// ---------------------------------------------------------------------------
// Allowlist + DNS resolution
// ---------------------------------------------------------------------------

function splitHostPort(entry) {
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close > 0) {
      const host = entry.slice(1, close);
      const port = entry.slice(close + 1).replace(/^:/, "");
      return [host, port || null];
    }
  }
  const firstColon = entry.indexOf(":");
  if (firstColon < 0) return [entry, null];
  return [entry.slice(0, firstColon), entry.slice(firstColon + 1) || null];
}

function matchesAllowlist(url, allowlist, ctx) {
  if (allowlist === undefined || allowlist === null) return true;
  if (typeof allowlist === "function") return Boolean(allowlist(url, ctx));
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const host = stripBrackets(url.hostname);
  for (const raw of allowlist) {
    if (typeof raw !== "string") continue;
    const entry = raw.trim();
    if (entry.includes("://")) {
      try {
        const allowed = new URL(entry);
        if (
          allowed.protocol === url.protocol &&
          stripBrackets(allowed.hostname) === host &&
          (!allowed.port || allowed.port === url.port)
        ) {
          return true;
        }
      } catch {
        // An invalid allowlist entry simply does not match.
      }
      continue;
    }
    const [allowedHost, allowedPort] = splitHostPort(entry);
    if (
      stripBrackets(allowedHost) === host &&
      (!allowedPort || allowedPort === url.port)
    ) {
      return true;
    }
  }
  return false;
}

async function defaultResolver(hostname) {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function defaultRedirectFetch(url, init) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw toolError(
      UTCP_ERROR_CODES.UTCP_REDIRECT_LIMIT,
      "Redirect containment needs a fetch implementation or an injected redirectFetch",
    );
  }
  return fetchImpl(url, init);
}

function redirectLocation(response) {
  if (!response) return null;
  if (typeof response.location === "string") return response.location;
  const headers = response.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get("location");
  return headers.location ?? null;
}

// ---------------------------------------------------------------------------
// Destination policy
// ---------------------------------------------------------------------------

/**
 * Parse, resolve and re-check a destination. Denials throw an Error with a
 * stable `code` from UTCP_ERROR_CODES. `allowLoopback` is only true for a
 * locally declared manual/tool; a remote manual never gets loopback targets.
 */
export async function checkUtcpDestination(rawUrl, options = {}) {
  const {
    allowLoopback = false,
    allowlist,
    resolver = defaultResolver,
    context,
  } = options;
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw toolError(
      UTCP_ERROR_CODES.TOOL_UNAVAILABLE,
      "Invalid UTCP destination URL",
    );
  }

  if (!matchesAllowlist(url, allowlist, context)) {
    throw toolError(
      UTCP_ERROR_CODES.UTCP_HOST_NOT_ALLOWED,
      `UTCP destination is not allowed: ${url.host}`,
    );
  }

  const host = stripBrackets(url.hostname);
  const literalClass = classifyUtcpAddress(host);
  const literalLoopback = literalClass === "loopback" || isLoopbackName(host);
  const secureScheme = url.protocol === "https:" || url.protocol === "wss:";
  const allowedScheme =
    secureScheme || url.protocol === "http:" || url.protocol === "ws:";
  if (!allowedScheme) {
    throw toolError(
      UTCP_ERROR_CODES.UTCP_SCHEME_REQUIRED,
      "UTCP destinations must use HTTPS/WSS (or HTTP/WS for literal loopback)",
    );
  }
  // Address class is checked before the HTTPS rule so that, for example, a
  // private http:// target reports UTCP_PRIVATE_TARGET rather than a scheme
  // error. The HTTPS requirement is enforced at the end of this function.

  let addresses;
  if (net.isIP(host)) {
    if (literalClass === "unknown") {
      throw toolError(
        UTCP_ERROR_CODES.UTCP_UNRESOLVABLE,
        "Ambiguous IP literal is not accepted as a UTCP destination",
      );
    }
    addresses = [host];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      throw toolError(
        UTCP_ERROR_CODES.UTCP_UNRESOLVABLE,
        `Could not resolve UTCP destination: ${host}`,
      );
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw toolError(
        UTCP_ERROR_CODES.UTCP_UNRESOLVABLE,
        `UTCP destination resolved to no addresses: ${host}`,
      );
    }
  }

  const resolvedLoopback = addresses.every(
    (address) => classifyUtcpAddress(address) === "loopback",
  );
  for (const address of addresses) {
    const kind = classifyUtcpAddress(address);
    if (kind === "loopback") {
      if (!allowLoopback || (!literalLoopback && !resolvedLoopback)) {
        throw toolError(
          UTCP_ERROR_CODES.UTCP_LOOPBACK_DENIED,
          "Loopback destinations are only valid for locally declared UTCP tools",
        );
      }
      continue;
    }
    const denial = DENY_BY_CLASS[kind];
    if (denial) {
      throw toolError(denial, `Blocked UTCP destination class: ${kind}`);
    }
  }

  if (!secureScheme && !literalLoopback && !resolvedLoopback) {
    throw toolError(
      UTCP_ERROR_CODES.UTCP_SCHEME_REQUIRED,
      "HTTPS is required outside literal loopback",
    );
  }

  return { url, addresses, loopback: literalLoopback || resolvedLoopback };
}

function isLoopbackEndpoint(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    const host = stripBrackets(url.hostname);
    return classifyUtcpAddress(host) === "loopback" || isLoopbackName(host);
  } catch {
    return false;
  }
}

async function checkRedirects(rawUrl, options = {}) {
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    redirectFetch = defaultRedirectFetch,
    allowLoopback = false,
    allowlist,
    resolver,
    context,
  } = options;
  const policy = { allowLoopback, allowlist, resolver, context };
  let current = String(rawUrl);
  const seen = new Set([current]);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Re-resolve and re-check on every hop: a name may change answer between
    // the preflight and the real SDK call (DNS rebinding).
    const info = await checkUtcpDestination(current, policy);
    const response = await redirectFetch(info.url.href, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: {},
    });
    const location = redirectLocation(response);
    if (!location) return info;
    const next = new URL(location, info.url).href;
    if (seen.has(next)) {
      throw toolError(
        UTCP_ERROR_CODES.UTCP_REDIRECT_LIMIT,
        "UTCP redirect loop",
      );
    }
    seen.add(next);
    if (!info.loopback && isLoopbackEndpoint(next)) {
      throw toolError(
        UTCP_ERROR_CODES.UTCP_REDIRECT_LOOPBACK,
        "A remote UTCP endpoint may not redirect to loopback",
      );
    }
    current = next;
  }
  throw toolError(
    UTCP_ERROR_CODES.UTCP_REDIRECT_LIMIT,
    `UTCP redirect limit (${maxRedirects}) exceeded`,
  );
}

// ---------------------------------------------------------------------------
// Authorization, credential isolation, bounded output
// ---------------------------------------------------------------------------

/** Check AI Auth caller authorization expiry. Never inspects provider credentials. */
export function checkUtcpAuthorization(ctx = {}) {
  const auth = ctx.authorization ?? ctx.auth ?? null;
  if (!auth) return;
  if (auth.valid === false || auth.expired === true) {
    throw toolError(UTCP_ERROR_CODES.AUTH_EXPIRED, "Authorization has expired");
  }
  let expiresAt = auth.expiresAt ?? ctx.expiresAt;
  if (typeof auth.exp === "number") expiresAt = auth.exp * 1000;
  if (typeof expiresAt === "string") expiresAt = Date.parse(expiresAt);
  if (
    typeof expiresAt === "number" &&
    Number.isFinite(expiresAt) &&
    Date.now() > expiresAt
  ) {
    throw toolError(UTCP_ERROR_CODES.AUTH_EXPIRED, "Authorization has expired");
  }
}

const AI_AUTH_SECRET_KEYS = Object.freeze([
  "grant",
  "grants",
  "signature",
  "signatures",
  "authorization",
  "auth_grant",
  "authGrant",
  "capabilityGrant",
  "capability_grant",
  "proof",
  "envelope",
  "signedEnvelope",
  "session",
  "sessionId",
  "wallet",
  "walletId",
  "identity",
  "actor",
  "caller",
  "delegation",
  "delegations",
  "membership",
  "room",
]);

function sanitizeProviderConfig(config, namespace) {
  const source = config && typeof config === "object" ? config : {};
  const namespaced =
    source.namespaces?.[namespace] ??
    source.credentials?.[namespace] ??
    source[namespace] ??
    {};
  const clean = {};
  for (const [key, value] of Object.entries(namespaced)) {
    // Provider-native auth is allowed; AI Auth grants/signatures never are.
    if (AI_AUTH_SECRET_KEYS.includes(key)) continue;
    // Transport targets are validated on the manual URL. A credential entry
    // must not silently replace that URL after validation.
    if (/^(url|baseurl|base_url|endpoint|manualurl|manual_url)$/iu.test(key))
      continue;
    clean[key] = value;
  }
  return clean;
}

function safeMessage(message, maxChars = DEFAULT_MAX_ERROR_CHARS) {
  const text = typeof message === "string" ? message : String(message ?? "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function boundUtcpOutput(value, maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  if (value === undefined) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw toolError(
      UTCP_ERROR_CODES.TOOL_UNAVAILABLE,
      "UTCP output is not JSON serializable",
    );
  }
  if (typeof serialized !== "string") return null;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= maxBytes) return value;
  const budget = Math.max(0, maxBytes - 128);
  return {
    __utcpTruncated: true,
    bytes,
    maxBytes,
    preview: serialized.slice(0, budget),
  };
}

// ---------------------------------------------------------------------------
// Descriptor conversion (local minimal shape; shared helpers are optional)
// ---------------------------------------------------------------------------

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function toolEndpoints(tool) {
  const template = tool?.tool_call_template ?? tool?.toolCallTemplate ?? {};
  const candidates = [
    template.url,
    template.url_template,
    template.endpoint,
    tool?.url,
    tool?.endpoint,
    template.config?.url,
    tool?.config?.url,
  ];
  return [
    ...new Set(
      candidates.filter((value) => typeof value === "string" && value),
    ),
  ];
}

function manualNameForTool(tool, manuals) {
  const named =
    firstString(
      tool?.manual_name,
      tool?.manualName,
      tool?.provider,
      tool?.manual,
    ) ??
    firstString(
      tool?.tool_call_template?.manual_name,
      tool?.tool_call_template?.manual,
    );
  if (named) {
    const match = manuals.find(
      (manual) => manual.name === named || manual.id === named,
    );
    if (match) return match;
  }
  return manuals[0];
}

async function loadSharedDescriptorHelpers() {
  try {
    const module = await import("./tool-descriptor.js");
    return {
      build:
        typeof module.buildToolDescriptor === "function"
          ? module.buildToolDescriptor
          : typeof module.buildDescriptor === "function"
            ? module.buildDescriptor
            : null,
      validate:
        typeof module.validateToolDescriptor === "function"
          ? module.validateToolDescriptor
          : null,
    };
  } catch {
    // Worker B's module is optional at this adapter's layer.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Official SDK loading
// ---------------------------------------------------------------------------

let officialSdkPromise;
function loadOfficialSdk(moduleName = "@utcp/sdk") {
  if (!officialSdkPromise) {
    officialSdkPromise = import(/* webpackIgnore: true */ moduleName).catch(
      () => null,
    );
  }
  return officialSdkPromise;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return `utcp-req-${requestCounter}`;
}

/**
 * Create a UTCP tool-provider adapter.
 *
 * Options:
 *   manuals: array of `{ id?, name, url|manualUrl, ...template }` (required).
 *   client: injected client implementing registerManual/getTools/callTool.
 *   clientFactory: async `({ manual, adapter }) => client` for custom setups.
 *   allowlist: array of allowed hosts/origins or `(url, ctx) => boolean`.
 *   resolver: async `(hostname) => string[]` (default: node dns.lookup, all).
 *   redirectFetch: async `(url, init) => response` for redirect containment.
 *   credentials: per-namespace provider-native credentials (never AI Auth grants).
 *   capabilities: AI Auth scopes required to invoke these tools.
 *   maxRedirects, deadlineMs, maxOutputBytes, maxErrorChars.
 *   useSharedDescriptorBuilder: attempt worker B's buildToolDescriptor (off by
 *     default so descriptors stay deterministic until its signature is pinned).
 *   descriptorBuilder: explicit injection, wins over the shared builder.
 */
export function createUtcpAdapter(options = {}) {
  const {
    client,
    clientFactory,
    allowlist,
    resolver = defaultResolver,
    redirectFetch = defaultRedirectFetch,
    credentials = {},
    capabilities = [],
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxErrorChars = DEFAULT_MAX_ERROR_CHARS,
    useSharedDescriptorBuilder = false,
    descriptorBuilder,
    resolveManualForTool = manualNameForTool,
    sdkModuleName = "@utcp/sdk",
    sdkConfig = {},
  } = options;

  const manuals = (Array.isArray(options.manuals) ? options.manuals : []).map(
    (manual, index) => {
      const url = manual.url ?? manual.manualUrl;
      if (!url) {
        throw toolError(
          UTCP_ERROR_CODES.UTCP_MANUAL_REQUIRED,
          `Manual ${index} needs a url or manualUrl`,
        );
      }
      const name = manual.name ?? manual.id ?? `manual-${index}`;
      const template = { ...manual, name, url };
      delete template.id;
      return {
        id: manual.id ?? name,
        name,
        url,
        template,
        registered: false,
        remote: null,
      };
    },
  );

  const descriptors = new Map();
  const active = new Map();
  let resolvedClient = client ?? null;
  let clientPromise = null;
  let discovered = false;
  let closed = false;
  let sharedHelpersPromise;

  const policyFor = (context, allowLoopback) => ({
    allowLoopback,
    allowlist,
    resolver,
    context,
  });

  const policyWithRedirects = (context, allowLoopback) => ({
    ...policyFor(context, allowLoopback),
    maxRedirects,
    redirectFetch,
  });

  async function getClient() {
    if (resolvedClient) return resolvedClient;
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      if (typeof clientFactory === "function") {
        resolvedClient = await clientFactory({
          adapter: publicApi,
          manuals,
          sdkConfig,
        });
        return resolvedClient;
      }
      const sdk = await loadOfficialSdk(sdkModuleName);
      if (!sdk?.UtcpClient?.create) {
        throw toolError(
          UTCP_ERROR_CODES.UTCP_SDK_UNAVAILABLE,
          "@utcp/sdk is not installed; inject a client or clientFactory",
        );
      }
      resolvedClient = await sdk.UtcpClient.create(sdkConfig);
      return resolvedClient;
    })();
    return clientPromise;
  }

  async function toDescriptor(tool, manual) {
    const name = firstString(tool?.name, tool?.tool_name, tool?.toolName) ?? "";
    if (!name) {
      throw toolError(
        UTCP_ERROR_CODES.UTCP_TOOL_NOT_FOUND,
        "Native UTCP tool has no name",
      );
    }
    const endpoints = toolEndpoints(tool);
    const endpoint = endpoints[0] ?? manual.url;
    let origin;
    try {
      origin = new URL(endpoint).origin;
    } catch {
      origin = undefined;
    }
    const annotations = tool?.annotations ?? tool?.risk ?? {};
    const sideEffect =
      annotations.consequentialHint === true ||
      annotations.destructiveHint === true
        ? "consequential"
        : annotations.readOnlyHint === true
          ? "read"
          : "write";
    const authType = firstString(
      tool?.auth?.auth_type,
      manual.template?.auth?.auth_type,
    );
    const description =
      firstString(tool?.description, tool?.tool_call_template?.description) ??
      "";
    const inputSchema =
      tool?.inputSchema ??
      tool?.input_schema ??
      tool?.tool_call_template?.inputs?.parameters ??
      tool?.tool_call_template?.parameters ??
      {};

    const local = {
      // The ID and providerId must use the same manual segment so the shared
      // descriptor validator accepts it. The original manual id is kept as
      // provenance in native metadata, not as the namespace token.
      id: buildUtcpToolId(manual.name, name),
      protocol: PROTOCOL,
      providerId: manual.name,
      source: { endpoint, ...(origin ? { origin } : {}) },
      name,
      title: firstString(tool?.title),
      description,
      inputSchema,
      outputSchema:
        tool?.outputSchema ?? tool?.tool_call_template?.outputs?.parameters,
      capabilities: [...capabilities],
      risk: { sideEffect, untrustedContent: true },
      // UTCP auth stays provider-native even when the manual declares no auth.
      requiredAuthorization: {
        kind: "native",
        ...(authType ? { detail: `utcp:${authType}` } : {}),
      },
      availability: "online",
      native: tool,
      // Internal wiring, not part of the public descriptor contract.
      __manual: manual.name,
    };

    let result = local;
    let builder = descriptorBuilder;
    if (!builder && useSharedDescriptorBuilder) {
      sharedHelpersPromise ??= loadSharedDescriptorHelpers();
      builder = (await sharedHelpersPromise)?.build ?? null;
    }
    if (typeof builder === "function") {
      try {
        const built = await builder(local);
        if (built && typeof built === "object") {
          result = { ...local, ...built };
        }
      } catch {
        // A mismatched shared builder never weakens the local descriptor.
      }
    }
    // Namespacing and native preservation are non-negotiable.
    result.id = local.id;
    result.native = local.native;
    result.protocol = PROTOCOL;
    result.__manual = local.__manual;
    return result;
  }

  async function discover() {
    if (closed) {
      throw toolError(
        UTCP_ERROR_CODES.TOOL_UNAVAILABLE,
        "UTCP adapter is closed",
      );
    }
    const sdk = await getClient();
    for (const manual of manuals) {
      if (!manual.registered) {
        const info = await checkUtcpDestination(
          manual.url,
          policyFor(undefined, true),
        );
        manual.remote = !info.loopback;
        // A remote manual must never redirect to a loopback destination.
        await checkRedirects(
          manual.url,
          policyWithRedirects(undefined, !manual.remote),
        );
        const providerConfig = sanitizeProviderConfig(credentials, manual.name);
        await sdk.registerManual({ ...manual.template, ...providerConfig });
        manual.registered = true;
      }
    }

    if (typeof sdk.getTools !== "function") {
      throw toolError(
        UTCP_ERROR_CODES.TOOL_UNAVAILABLE,
        "UTCP client does not expose getTools()",
      );
    }
    const nativeTools = (await sdk.getTools()) ?? [];
    descriptors.clear();
    for (const tool of nativeTools) {
      const manual = resolveManualForTool(tool, manuals) ?? manuals[0];
      const endpoints = toolEndpoints(tool);
      for (const endpoint of endpoints) {
        try {
          await checkUtcpDestination(
            endpoint,
            policyFor(undefined, !manual.remote),
          );
          await checkRedirects(
            endpoint,
            policyWithRedirects(undefined, !manual.remote),
          );
        } catch (error) {
          if (manual.remote && isLoopbackEndpoint(endpoint)) {
            throw toolError(
              UTCP_ERROR_CODES.UTCP_LOOPBACK_FROM_REMOTE_MANUAL,
              "A remote UTCP manual may not declare loopback tool URLs",
            );
          }
          throw error;
        }
      }
      const descriptor = await toDescriptor(tool, manual);
      descriptors.set(descriptor.id, descriptor);
    }
    discovered = true;
    return [...descriptors.values()].map(stripInternal);
  }

  async function listTools(query) {
    if (!discovered) await discover();
    const sdk = await getClient();
    if (typeof query === "string" && typeof sdk.searchTools === "function") {
      const found = (await sdk.searchTools(query)) ?? [];
      const allowed = new Set(
        found.map((tool) => firstString(tool?.name, tool?.tool_name)),
      );
      return [...descriptors.values()]
        .filter((descriptor) => allowed.has(descriptor.name))
        .map(stripInternal);
    }
    const all = [...descriptors.values()];
    if (typeof query !== "string" || !query) return all.map(stripInternal);
    const needle = query.toLowerCase();
    return all
      .filter(
        (descriptor) =>
          descriptor.id.toLowerCase().includes(needle) ||
          descriptor.name.toLowerCase().includes(needle),
      )
      .map(stripInternal);
  }

  async function getTool(id) {
    if (!discovered) await discover();
    const descriptor = descriptors.get(id);
    return descriptor ? stripInternal(descriptor) : undefined;
  }

  function stripInternal(descriptor) {
    const { __manual, ...publicDescriptor } = descriptor;
    return publicDescriptor;
  }

  function invoke(id, args, ctx = {}) {
    return invokeInternal(id, args, ctx);
  }

  async function invokeInternal(id, args, ctx = {}) {
    if (closed) {
      throw toolError(
        UTCP_ERROR_CODES.TOOL_UNAVAILABLE,
        "UTCP adapter is closed",
      );
    }
    if (!discovered) await discover();
    const descriptor = descriptors.get(id);
    if (!descriptor) {
      throw toolError(
        UTCP_ERROR_CODES.UTCP_TOOL_NOT_FOUND,
        `Unknown UTCP tool: ${id}`,
      );
    }
    checkUtcpAuthorization(ctx);
    const manual =
      manuals.find((entry) => entry.name === descriptor.__manual) ?? manuals[0];

    // Best-effort resolve-and-re-check. This is NOT IP pinning: the SDK opens
    // its own connection and may resolve again. True rebinding prevention needs
    // a pinned transport, which the official SDK does not expose here.
    const endpoint = descriptor.source.endpoint;
    if (endpoint) {
      await checkUtcpDestination(endpoint, policyFor(ctx, !manual.remote));
      await checkRedirects(endpoint, policyWithRedirects(ctx, !manual.remote));
    }

    const sdk = await getClient();
    const nativeName = firstString(
      descriptor.native?.name,
      descriptor.native?.tool_name,
      descriptor.name,
    );
    const nativeArgs = args === undefined ? {} : args;
    const requestId = ctx.requestId ?? nextRequestId();
    const controller = new AbortController();
    let finished = false;
    let deadlineReached = false;
    let callerAborted = false;
    const abortByCaller = () => {
      callerAborted = true;
      controller.abort();
    };
    active.set(requestId, { controller, abortByCaller });

    const abortPromise = new Promise((resolve) => {
      const onAbort = () => {
        if (!finished) resolve({ kind: "abort" });
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let timer;
    const externalSignal = ctx.signal;
    const onExternalAbort = () => abortByCaller();
    if (externalSignal?.aborted) abortByCaller();
    else if (externalSignal?.addEventListener) {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const effectiveDeadline = ctx.deadlineMs ?? ctx.timeoutMs ?? deadlineMs;
    if (Number.isFinite(effectiveDeadline) && effectiveDeadline > 0) {
      // Deliberately not unref'd: the deadline must keep the event loop alive
      // until an in-flight native call settles or the wrapper times out.
      timer = setTimeout(() => {
        deadlineReached = true;
        controller.abort();
      }, effectiveDeadline);
    }

    const streaming =
      ctx.stream === true && typeof sdk.callToolStreaming === "function";
    const call = streaming
      ? sdk.callToolStreaming(nativeName, nativeArgs, {
          signal: controller.signal,
        })
      : sdk.callTool(nativeName, nativeArgs, { signal: controller.signal });
    // Settle to a tagged object so a late native rejection cannot become an
    // unhandled rejection after a deadline/cancel already returned.
    const nativePromise = Promise.resolve(call).then(
      (value) => ({ kind: "result", value }),
      (error) => ({ kind: "error", error }),
    );

    try {
      const outcome = await Promise.race([nativePromise, abortPromise]);
      const base = {
        protocol: PROTOCOL,
        toolId: id,
        requestId,
        nativeCancellationSupported: false,
      };
      if (outcome.kind === "result") {
        return {
          ...base,
          ok: true,
          result: boundUtcpOutput(outcome.value, maxOutputBytes),
          native: boundUtcpOutput(
            { tool: descriptor.native, manual: manual.name },
            maxOutputBytes,
          ),
        };
      }
      if (outcome.kind === "error") {
        const error = outcome.error;
        const nativeCode = firstString(
          error?.code,
          error?.nativeCode,
          error?.name,
        );
        return {
          ...base,
          ok: false,
          error: {
            code: UTCP_ERROR_CODES.UTCP_NATIVE_ERROR,
            message: safeMessage(error?.message ?? error, maxErrorChars),
            ...(nativeCode ? { nativeCode } : {}),
          },
          native: boundUtcpOutput(
            {
              tool: descriptor.native,
              manual: manual.name,
              error: {
                code: nativeCode,
                message: safeMessage(error?.message ?? error, maxErrorChars),
                ...(error?.data !== undefined
                  ? { data: boundUtcpOutput(error.data, maxOutputBytes) }
                  : {}),
              },
            },
            maxOutputBytes,
          ),
        };
      }
      // Distinguish a deadline from an explicit abort/cancel truthfully. The
      // official SDK has no verified cancellation, so the native call may
      // still be running after we return; we never claim otherwise.
      const isTimeout = deadlineReached && !callerAborted;
      return {
        ...base,
        ok: false,
        error: {
          code: isTimeout
            ? UTCP_ERROR_CODES.TIMEOUT
            : UTCP_ERROR_CODES.CANCELLED,
          message: isTimeout
            ? "UTCP call exceeded its deadline; native SDK cannot cancel the in-flight call"
            : "UTCP call was cancelled; native SDK cannot cancel the in-flight call",
        },
        timedOut: isTimeout,
        cancelled: !isTimeout,
        nativeCallMayStillRun: true,
        native: boundUtcpOutput(
          { tool: descriptor.native, manual: manual.name },
          maxOutputBytes,
        ),
      };
    } finally {
      finished = true;
      clearTimeout(timer);
      active.delete(requestId);
      externalSignal?.removeEventListener?.("abort", onExternalAbort);
    }
  }

  function cancel(requestId) {
    const entry = active.get(requestId);
    if (entry) entry.abortByCaller();
    return Promise.resolve();
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const entry of active.values()) entry.abortByCaller();
    active.clear();
    const sdk = resolvedClient;
    if (sdk?.deregisterManual) {
      for (const manual of manuals) {
        try {
          await sdk.deregisterManual(manual.name);
        } catch {
          // Best-effort cleanup; never surface a secret-bearing failure here.
        }
      }
    }
    descriptors.clear();
    discovered = false;
  }

  const publicApi = {
    protocol: PROTOCOL,
    nativeCancellationSupported: false,
    discover,
    listTools,
    getTool,
    invoke,
    cancel,
    close,
  };
  return publicApi;
}

export default createUtcpAdapter;
