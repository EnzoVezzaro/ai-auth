// Protocol-neutral tool descriptors for the unified registry.
//
// This module is deliberately inert: it only defines constants and pure
// functions. No DOM, no network, no I/O and no work happens at import time.
// A descriptor keeps the provider's original definition verbatim in `native`;
// translation is additive and never rewrites or drops a native field.

/** The tool protocols this layer can describe. */
export const PROTOCOLS = Object.freeze(["mcp", "webmcp", "utcp"]);
export const SIDE_EFFECTS = Object.freeze(["read", "write", "consequential"]);
export const AUTHORIZATION_KINDS = Object.freeze([
  "owner",
  "site",
  "native",
  "none",
]);
export const AVAILABILITIES = Object.freeze([
  "online",
  "offline",
  "expired",
  "unknown",
]);

/** ID segment separator: ids are `protocol:providerId:name`. */
export const TOOL_ID_SEPARATOR = ":";

// Bounds mirror the existing WebMCP catalog limits where they exist. They keep
// a hostile provider from turning a descriptor into an unbounded memory sink.
export const LIMITS = Object.freeze({
  MAX_NAME_LENGTH: 128,
  MAX_PROVIDER_ID_LENGTH: 128,
  MAX_TITLE_LENGTH: 120,
  MAX_DESCRIPTION_LENGTH: 240,
  MAX_DETAIL_LENGTH: 240,
  MAX_SOURCE_FIELD_LENGTH: 2048,
  MAX_CAPABILITIES: 64,
  MAX_ORIGINS: 64,
  MAX_WALLET_IDS: 128,
  MAX_ORIGIN_LENGTH: 512,
  MAX_SCHEMA_BYTES: 8192,
});

// A name may contain '/' (UTCP manual tools use e.g. "github/issues.search") but
// never ':' -- colon is the ID namespace separator. Allowing it would let one
// provider forge another provider's ID.
// A colon is permitted inside provider ids because origins such as
// `https://app.example` are carried there. IDs split at the FIRST and LAST
// separator: protocol is before the first, the tool name is after the last,
// and the provider id is everything between. Control characters and whitespace
// are still rejected.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/u;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const CAPABILITY_RE = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;
const WALLET_RE = /^agent:[A-Za-z0-9_-]{20,100}$/u;
const CONTROL_RE = /[\u0000-\u001F\u007F]/u;
// A conservative marker for auth-related native fields. It is used only to
// decide whether a native descriptor *mentions* authorization, never to lower
// a permission or to synthesize a capability.
const AUTH_FIELD_RE = /auth|oauth|token|credential|bearer|secret|api[_-]?key/i;

export const isProtocol = (value) =>
  typeof value === "string" && PROTOCOLS.includes(value);
export const isSideEffect = (value) =>
  typeof value === "string" && SIDE_EFFECTS.includes(value);
export const isAuthorizationKind = (value) =>
  typeof value === "string" && AUTHORIZATION_KINDS.includes(value);
export const isAvailability = (value) =>
  typeof value === "string" && AVAILABILITIES.includes(value);
export const isValidToolName = (value) =>
  typeof value === "string" && NAME_RE.test(value);
export const isValidProviderId = (value) =>
  typeof value === "string" && PROVIDER_RE.test(value);
export const isWalletId = (value) =>
  typeof value === "string" && WALLET_RE.test(value);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(
  value,
  label,
  max,
  { required = true, allowControl = false } = {},
) {
  if (value === undefined) {
    if (required) throw new TypeError(`${label} is required`);
    return undefined;
  }
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  if (value.length > max)
    throw new RangeError(`${label} must be at most ${max} characters`);
  if (!allowControl && CONTROL_RE.test(value))
    throw new TypeError(`${label} must not contain control characters`);
  return value;
}

function assertToken(value, label, re, max) {
  const text = boundedText(value, label, max);
  if (!re.test(text)) throw new TypeError(`${label} has an invalid format`);
  return text;
}

function assertSchema(value, label, required) {
  if (value === undefined) {
    if (required) throw new TypeError(`${label} is required`);
    return undefined;
  }
  if (!isObject(value))
    throw new TypeError(`${label} must be a JSON Schema object`);
  let size;
  try {
    size = JSON.stringify(value).length;
  } catch {
    throw new TypeError(`${label} must be serializable JSON`);
  }
  if (size > LIMITS.MAX_SCHEMA_BYTES)
    throw new RangeError(`${label} is too large`);
  return value;
}

function assertCapabilities(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > LIMITS.MAX_CAPABILITIES)
    throw new TypeError("capabilities must be a bounded array");
  const out = new Set();
  for (const capability of value) {
    // Wildcards and empty/generic markers are never accepted. An unknown
    // native authorization must not turn into a generic capability.
    if (capability === "*")
      throw new TypeError("capability wildcards are not supported");
    if (typeof capability !== "string" || !CAPABILITY_RE.test(capability))
      throw new TypeError("capabilities must be explicit operation names");
    out.add(capability);
  }
  if (out.size !== value.length)
    throw new TypeError("capabilities must be unique");
  return Object.freeze([...out]);
}

function assertRisk(value) {
  if (!isObject(value))
    throw new TypeError("risk is required and must be an object");
  if (!isSideEffect(value.sideEffect))
    throw new TypeError("risk.sideEffect must be read, write or consequential");
  if (typeof value.untrustedContent !== "boolean")
    throw new TypeError("risk.untrustedContent must be a boolean");
  return Object.freeze({
    sideEffect: value.sideEffect,
    untrustedContent: value.untrustedContent,
  });
}

function assertSource(value) {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new TypeError("source must be an object");
  const source = {};
  for (const key of ["origin", "endpoint", "page"]) {
    if (value[key] !== undefined)
      source[key] = boundedText(
        value[key],
        `source.${key}`,
        LIMITS.MAX_SOURCE_FIELD_LENGTH,
      );
  }
  return Object.freeze(source);
}

function assertAudience(value) {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new TypeError("audience must be an object");
  const audience = {};
  if (value.origins !== undefined) {
    if (
      !Array.isArray(value.origins) ||
      value.origins.length > LIMITS.MAX_ORIGINS
    )
      throw new TypeError("audience.origins must be a bounded array");
    audience.origins = Object.freeze(
      value.origins.map((origin) =>
        boundedText(origin, "audience.origins[]", LIMITS.MAX_ORIGIN_LENGTH),
      ),
    );
  }
  if (value.walletIds !== undefined) {
    if (
      !Array.isArray(value.walletIds) ||
      value.walletIds.length > LIMITS.MAX_WALLET_IDS
    )
      throw new TypeError("audience.walletIds must be a bounded array");
    audience.walletIds = Object.freeze(
      value.walletIds.map((walletId) => {
        const text = boundedText(
          walletId,
          "audience.walletIds[]",
          LIMITS.MAX_ORIGIN_LENGTH,
        );
        if (!WALLET_RE.test(text))
          throw new TypeError("audience.walletIds[] has an invalid format");
        return text;
      }),
    );
  }
  return Object.freeze(audience);
}

/**
 * Scan a native descriptor for any hint of authorization. This produces a
 * requiredAuthorization classification only. It never returns capabilities:
 * an auth scheme we do not recognize stays "native" and is preserved in
 * `native`, rather than becoming an empty or generic AI Auth capability.
 */
export function authorizationFromNative(native) {
  if (!isObject(native)) return Object.freeze({ kind: "none" });
  const seen = new Set();
  const stack = [native];
  let mentionsAuth = false;
  while (stack.length && !mentionsAuth) {
    const value = stack.pop();
    if (!isObject(value) && !Array.isArray(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (AUTH_FIELD_RE.test(key)) {
        mentionsAuth = true;
        break;
      }
      if ((isObject(child) || Array.isArray(child)) && !seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
  }
  return Object.freeze(
    mentionsAuth
      ? {
          kind: "native",
          detail: "provider-native authorization preserved verbatim",
        }
      : { kind: "none" },
  );
}

function assertRequiredAuthorization(value, native) {
  if (value === undefined) return authorizationFromNative(native);
  if (!isObject(value))
    throw new TypeError("requiredAuthorization must be an object");
  if (!isAuthorizationKind(value.kind))
    throw new TypeError("requiredAuthorization.kind is invalid");
  const result = { kind: value.kind };
  if (value.detail !== undefined)
    result.detail = boundedText(
      value.detail,
      "requiredAuthorization.detail",
      LIMITS.MAX_DETAIL_LENGTH,
    );
  return Object.freeze(result);
}

/** Compose a namespaced ID from validated parts. */
export function makeToolId({ protocol, providerId, name }) {
  if (!isProtocol(protocol))
    throw new TypeError("Invalid protocol for tool id");
  assertToken(
    providerId,
    "providerId",
    PROVIDER_RE,
    LIMITS.MAX_PROVIDER_ID_LENGTH,
  );
  assertToken(name, "name", NAME_RE, LIMITS.MAX_NAME_LENGTH);
  return `${protocol}${TOOL_ID_SEPARATOR}${providerId}${TOOL_ID_SEPARATOR}${name}`;
}

/** Split a namespaced ID, or return null when it is malformed. */
export function parseToolId(id) {
  if (typeof id !== "string") return null;
  const first = id.indexOf(TOOL_ID_SEPARATOR);
  const last = id.lastIndexOf(TOOL_ID_SEPARATOR);
  if (first <= 0 || last <= first + 1 || last === id.length - 1) return null;
  const protocol = id.slice(0, first);
  const providerId = id.slice(first + 1, last);
  const name = id.slice(last + 1);
  if (
    !isProtocol(protocol) ||
    !PROVIDER_RE.test(providerId) ||
    !NAME_RE.test(name)
  )
    return null;
  return { protocol, providerId, name };
}

/**
 * Validate a neutral descriptor and return a frozen copy. `native` is kept by
 * reference and is never cloned, reworded or enriched. Strict validation is
 * the only path to a descriptor object the registry will accept.
 */
export function validateToolDescriptor(input) {
  if (!isObject(input))
    throw new TypeError("A tool descriptor object is required");
  if (!isProtocol(input.protocol))
    throw new TypeError("protocol must be mcp, webmcp or utcp");

  const providerId = assertToken(
    input.providerId,
    "providerId",
    PROVIDER_RE,
    LIMITS.MAX_PROVIDER_ID_LENGTH,
  );
  const name = assertToken(input.name, "name", NAME_RE, LIMITS.MAX_NAME_LENGTH);
  const expectedId = makeToolId({ protocol: input.protocol, providerId, name });
  if (input.id !== undefined && input.id !== expectedId)
    throw new TypeError(
      "Tool id must be protocol:providerId:name of its fields",
    );

  if (input.native === undefined || !isObject(input.native))
    throw new TypeError(
      "A native descriptor object is required and is preserved verbatim",
    );

  const availability = input.availability ?? "unknown";
  if (!isAvailability(availability))
    throw new TypeError("availability is invalid");

  return Object.freeze({
    id: expectedId,
    protocol: input.protocol,
    providerId,
    name,
    source: assertSource(input.source),
    title: boundedText(input.title, "title", LIMITS.MAX_TITLE_LENGTH, {
      required: false,
    }),
    // Description is untrusted data. It is bounded and stored, never parsed
    // for instructions, permissions or capabilities.
    description: boundedText(
      input.description,
      "description",
      LIMITS.MAX_DESCRIPTION_LENGTH,
      { allowControl: true },
    ),
    inputSchema: assertSchema(input.inputSchema, "inputSchema", true),
    outputSchema: assertSchema(input.outputSchema, "outputSchema", false),
    capabilities: assertCapabilities(input.capabilities),
    risk: assertRisk(input.risk),
    audience: assertAudience(input.audience),
    requiredAuthorization: assertRequiredAuthorization(
      input.requiredAuthorization,
      input.native,
    ),
    availability,
    native: input.native,
  });
}

/** Build a validated, frozen descriptor. Alias of validateToolDescriptor. */
export const buildToolDescriptor = validateToolDescriptor;

/** True when a value is already a validated descriptor. */
export function isToolDescriptor(value) {
  try {
    validateToolDescriptor(value);
    return true;
  } catch {
    return false;
  }
}
