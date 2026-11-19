// Bridging layer for the three EXISTING AI Auth tool catalogs.
//
// This module is additive: it reads catalogs produced by webmcp.js, mcp/bridge.js
// and agent/tool-provider.js and converts them into the protocol-neutral
// descriptor from docs/architecture/REFERENCE_ARCHITECTURE.md §6. It never
// mutates a source catalog, never rewrites a native descriptor, and never turns
// an advisory hint into a capability. Invocation stays with the existing native
// adapters; this file deliberately exposes no invoke/cancel/subscribe surface.

const UNKNOWN = "unknown";

// ---------------------------------------------------------------------------
// Defensive descriptor-helper binding (worker B: packages/p2p/tool-descriptor.js)
// ---------------------------------------------------------------------------
// The exact export name of worker B's builder is not pinned yet, so bind at
// module load by trying the plausible names. A small local fallback keeps this
// module usable before that file lands. Canonical fields are re-applied after
// the helper runs, so any helper signature/behavior cannot weaken the contract
// enforced here (namespacing, `native`, risk mapping, no fabricated scopes).
//
// The shared builder now accepts colons and slashes inside providerId/name and
// parses IDs at the first two separators, so `webmcp:<origin>:<name>` is valid.
// Canonical fields still win over anything the helper reshapes, so the
// provenance contract here cannot be weakened by a descriptor helper change.

const HELPER_EXPORT_NAMES = [
  "createToolDescriptor",
  "buildToolDescriptor",
  "makeToolDescriptor",
  "toUnifiedToolDescriptor",
  "unifiedToolDescriptor",
  "createDescriptor",
  "buildDescriptor",
  "toolDescriptor",
];

let descriptorFactory = null;
let descriptorFactoryName = null;

try {
  const helper = await import("./tool-descriptor.js");
  for (const name of HELPER_EXPORT_NAMES) {
    if (typeof helper?.[name] === "function") {
      descriptorFactory = helper[name];
      descriptorFactoryName = name;
      break;
    }
  }
  if (!descriptorFactory && typeof helper?.default === "function") {
    descriptorFactory = helper.default;
    descriptorFactoryName = "default";
  }
} catch {
  // tool-descriptor.js not present yet (or not loadable) -> local fallback.
  descriptorFactory = null;
  descriptorFactoryName = null;
}

/** Which descriptor builder is active. Exposed for diagnostics/tests. */
export function descriptorSource() {
  return descriptorFactoryName ?? "local-fallback";
}

function localDescriptor(fields) {
  const descriptor = {
    id: fields.id,
    protocol: fields.protocol,
    providerId: fields.providerId,
    source: fields.source ?? {},
    name: fields.name,
    description: fields.description,
    inputSchema: fields.inputSchema,
    capabilities: fields.capabilities,
    risk: fields.risk,
    requiredAuthorization: fields.requiredAuthorization,
    availability: fields.availability,
    native: fields.native,
  };
  if (fields.title !== undefined) descriptor.title = fields.title;
  if (fields.outputSchema !== undefined)
    descriptor.outputSchema = fields.outputSchema;
  if (fields.audience !== undefined) descriptor.audience = fields.audience;
  if (fields.expiresAt !== undefined) descriptor.expiresAt = fields.expiresAt;
  if (fields.provenance !== undefined)
    descriptor.provenance = fields.provenance;
  return descriptor;
}

function buildDescriptor(fields) {
  const canonical = localDescriptor(fields);
  if (!descriptorFactory) return canonical;
  let produced;
  try {
    produced = descriptorFactory(canonical);
  } catch {
    return canonical;
  }
  if (!produced || typeof produced !== "object" || Array.isArray(produced))
    return canonical;
  // Helper may add fields; canonical fields always win to preserve invariants.
  return { ...produced, ...canonical };
}

// ---------------------------------------------------------------------------
// Small, non-mutating extraction helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  for (const value of values)
    if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function toolArray(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (!isRecord(catalog)) return [];
  for (const key of ["tools", "descriptors", "actions"]) {
    if (Array.isArray(catalog[key])) return catalog[key];
  }
  return [];
}

function catalogMetadata(catalog) {
  return isRecord(catalog) ? catalog : {};
}

function copyNative(tool) {
  // Shallow copy: preserves every enumerable field of the native descriptor
  // without aliasing its top-level object back into the source catalog.
  return isRecord(tool) ? { ...tool } : tool;
}

function capabilitiesFrom(tool, options) {
  const result = [];
  const seen = new Set();
  const add = (value) => {
    if (typeof value !== "string" || !value || seen.has(value)) return;
    seen.add(value);
    result.push(value);
  };

  if (Array.isArray(options.capabilities)) options.capabilities.forEach(add);
  if (typeof options.capability === "string") add(options.capability);

  // Persist explicit capability declarations carried by a native descriptor.
  // Annotations/hints are NEVER consulted here.
  if (isRecord(tool)) {
    for (const key of ["requiredCapability", "capability"]) add(tool[key]);
    for (const key of ["requiredCapabilities", "capabilities"]) {
      if (Array.isArray(tool[key])) tool[key].forEach(add);
    }
  }
  return result;
}

function availabilityFrom(expiresAt) {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
    return "unknown";
  return expiresAt <= Date.now() ? "expired" : "online";
}

function stringList(value) {
  if (typeof value === "string" && value) return [value];
  if (Array.isArray(value))
    return value.filter((item) => typeof item === "string" && item);
  return [];
}

function audienceFrom(meta, tool) {
  const origins = stringList(meta.fromOrigins);
  for (const value of stringList(meta.exposedTo)) origins.push(value);
  const walletIds = stringList(meta.wallet);
  if (isRecord(tool?.audience)) {
    origins.push(...stringList(tool.audience.origins));
    walletIds.push(...stringList(tool.audience.walletIds));
  }
  const audience = {};
  if (origins.length) audience.origins = [...new Set(origins)];
  if (walletIds.length) audience.walletIds = [...new Set(walletIds)];
  return Object.keys(audience).length ? audience : undefined;
}

function uniqTools(descriptors) {
  const seen = new Set();
  const result = [];
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    result.push(descriptor);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Risk mapping
// ---------------------------------------------------------------------------

// WebMCP annotations are mapped to neutral risk fields. Hints are advisory for
// authorization purposes but they are the only risk signal a WebMCP page gives,
// so mapping them never grants a scope and never mints a permission.
function webmcpRisk(tool, meta) {
  const annotations = isRecord(tool?.annotations) ? tool.annotations : {};
  const consequential =
    annotations.consequentialHint === true ||
    tool?.consequentialHint === true ||
    tool?.protected === true;
  // A page is an untrusted source. Advisory readOnlyHint is deliberately
  // ignored here: a hostile page can label a destructive tool read-only.
  // Hints may only raise risk, never lower it.
  const sideEffect = consequential ? "consequential" : "write";

  let untrustedContent =
    annotations.untrustedContentHint === true ||
    tool?.untrustedContentHint === true ||
    tool?.untrustedContent === true;
  if (meta.untrusted === true) untrustedContent = true;
  return { sideEffect, untrustedContent };
}

// MCP (and signed agent catalogs received from peers) carry advisory hints that
// MUST NOT grant authority. A hint can only ever make a tool look MORE risky,
// never less: readOnlyHint is deliberately ignored and untrustedContent stays
// true for untrusted sources.
function advisoryRisk(tool, meta) {
  const annotations = isRecord(tool?.annotations) ? tool.annotations : {};
  const consequential =
    annotations.consequentialHint === true ||
    tool?.consequentialHint === true ||
    annotations.destructiveHint === true;
  const sideEffect = consequential ? "consequential" : "write";
  // Advisory sources are untrusted by default; a hint can never lower this.
  return { sideEffect, untrustedContent: true };
}

function peerRisk(tool, meta) {
  return advisoryRisk(tool, meta);
}

// ---------------------------------------------------------------------------
// Public conversion functions
// ---------------------------------------------------------------------------

/**
 * Convert a WebMCP page/agent catalog into unified descriptors.
 * catalog may be the tool array or the signed catalog object
 * `{ tools, expiresAt, wallet, session, fromOrigins, exposedTo, page }`.
 */
export function fromWebMCPCatalog(catalog, options = {}) {
  const meta = catalogMetadata(catalog);
  const tools = toolArray(catalog);
  const fallbackOrigin = firstString(
    options.origin,
    meta.origin,
    meta.source?.origin,
    meta.page,
  );
  const origin = fallbackOrigin ?? UNKNOWN;
  const providerId = firstString(options.providerId, origin, UNKNOWN);
  const expiresAt = meta.expiresAt;
  const availability = availabilityFrom(expiresAt);
  const audience = audienceFrom(meta, null);
  const authorization = {
    kind: "site",
    detail:
      "WebMCP page tool: embedder allow, provider exposedTo, consumer fromOrigins and a human authorize gate all apply.",
  };

  return uniqTools(
    tools.filter(isRecord).map((tool) => {
      const name = firstString(tool.name, UNKNOWN);
      const source = {};
      if (fallbackOrigin) source.origin = fallbackOrigin;
      if (typeof meta.page === "string" && meta.page) source.page = meta.page;
      if (typeof tool.page === "string" && tool.page) source.page = tool.page;

      const fields = {
        // The ID must use the same token as providerId, because the shared
        // descriptor validator requires id === protocol:providerId:name.
        // The real origin stays in source.origin for provenance and policy.
        id: `webmcp:${providerId}:${name}`,
        protocol: "webmcp",
        providerId,
        source,
        name,
        description:
          typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema ?? {},
        capabilities: capabilitiesFrom(tool, options),
        risk: webmcpRisk(tool, meta),
        requiredAuthorization: authorization,
        availability,
        native: copyNative(tool),
      };
      if (typeof tool.title === "string") fields.title = tool.title;
      if (tool.outputSchema !== undefined)
        fields.outputSchema = tool.outputSchema;
      if (audience) fields.audience = audience;
      if (expiresAt !== undefined) fields.expiresAt = expiresAt;
      if (!fallbackOrigin) fields.provenance = "missing-origin";
      return buildDescriptor(fields);
    }),
  );
}

/**
 * Convert an MCP catalog into unified descriptors. Accepts a plain tool array,
 * `buildAgentActions()` output, a `{ tools }` object, or a `listTools()` result
 * with `sites: [{ wallet, session, expiresAt, tools }]`.
 */
export function fromMcpCatalog(catalog, options = {}) {
  const providerId = firstString(options.providerId, UNKNOWN);
  const capabilities = options.capabilities;
  const records = [];

  if (isRecord(catalog) && Array.isArray(catalog.sites)) {
    for (const site of catalog.sites) {
      if (!isRecord(site)) continue;
      const meta = { ...site, untrusted: catalog.untrusted };
      for (const tool of toolArray(site)) records.push({ tool, meta });
    }
  } else {
    const meta = { untrusted: catalog?.untrusted };
    for (const tool of toolArray(catalog)) records.push({ tool, meta });
  }

  const authorization = {
    kind: "native",
    detail:
      "The MCP server's native auth is passed through untouched; AI Auth scopes gate local registration only.",
  };

  return uniqTools(
    records
      .filter(({ tool }) => isRecord(tool))
      .map(({ tool, meta }) => {
        const name = firstString(tool.name, UNKNOWN);
        const source = {};
        if (typeof options.endpoint === "string" && options.endpoint)
          source.endpoint = options.endpoint;
        else if (typeof meta.endpoint === "string" && meta.endpoint)
          source.endpoint = meta.endpoint;

        const expiresAt = meta.expiresAt;
        const fields = {
          id: `mcp:${providerId}:${name}`,
          protocol: "mcp",
          providerId,
          source,
          name,
          description:
            typeof tool.description === "string" ? tool.description : "",
          inputSchema: tool.inputSchema ?? {},
          capabilities: capabilitiesFrom(tool, { capabilities }),
          risk: advisoryRisk(tool, meta),
          requiredAuthorization: authorization,
          availability: availabilityFrom(expiresAt),
          native: copyNative(tool),
        };
        if (typeof tool.title === "string") fields.title = tool.title;
        if (tool.outputSchema !== undefined)
          fields.outputSchema = tool.outputSchema;
        const audience = audienceFrom(meta, tool);
        if (audience) fields.audience = audience;
        if (expiresAt !== undefined) fields.expiresAt = expiresAt;
        return buildDescriptor(fields);
      }),
  );
}

/**
 * Convert a signed agent tool-provider catalog (published as `tool-catalog`
 * `agent/action` events) into unified descriptors. The providerId is the
 * UTCP-style "manual" segment of the namespaced id.
 */
export function fromAgentToolCatalog(catalog, options = {}) {
  const meta = catalogMetadata(catalog);
  const tools = toolArray(catalog);
  const manual = firstString(
    options.manual,
    options.providerId,
    meta.manual,
    UNKNOWN,
  );
  const providerId = firstString(options.providerId, manual, UNKNOWN);
  const expiresAt = meta.expiresAt;
  const authorization = {
    kind: "owner",
    detail:
      "The providing agent's authorize(requester, name, input) gate must approve every call; peer data is untrusted.",
  };

  return uniqTools(
    tools.filter(isRecord).map((tool) => {
      const name = firstString(tool.name, UNKNOWN);
      const fields = {
        id: `utcp:${providerId}:${name}`,
        protocol: "utcp",
        providerId,
        source: {},
        name,
        description:
          typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema ?? {},
        capabilities: capabilitiesFrom(tool, options),
        risk: peerRisk(tool, meta),
        requiredAuthorization: authorization,
        availability: availabilityFrom(expiresAt),
        native: copyNative(tool),
      };
      if (typeof tool.title === "string") fields.title = tool.title;
      if (tool.outputSchema !== undefined)
        fields.outputSchema = tool.outputSchema;
      if (expiresAt !== undefined) fields.expiresAt = expiresAt;
      return buildDescriptor(fields);
    }),
  );
}

// ---------------------------------------------------------------------------
// ToolProviderAdapter-shaped facade (discover / listTools / getTool / close)
// ---------------------------------------------------------------------------
// No `invoke`, `cancel` or `subscribe`: those need the real native transports
// and would otherwise invent authority or lifecycle guarantees this bridge
// cannot honour.

function makeAdapter(protocol, convert, catalog, options = {}) {
  let closed = false;
  let descriptors = [];

  const readCatalog = () => {
    const value =
      typeof options.refresh === "function"
        ? options.refresh()
        : typeof catalog === "function"
          ? catalog()
          : catalog;
    return value;
  };

  const refresh = () => {
    if (closed) return [];
    descriptors = convert(readCatalog(), options);
    return descriptors;
  };

  const adapter = {
    protocol,
    discover: async () => refresh(),
    listTools: async () => refresh(),
    getTool: async (id) => refresh().find((descriptor) => descriptor.id === id),
    close: async () => {
      if (closed) return;
      closed = true;
      descriptors = [];
      if (isRecord(catalog) && typeof catalog.close === "function")
        await catalog.close();
      else if (typeof options.onClose === "function") await options.onClose();
    },
  };
  return Object.freeze(adapter);
}

export function createWebMCPAdapter(catalog, options = {}) {
  return makeAdapter("webmcp", fromWebMCPCatalog, catalog, options);
}

export function createMcpAdapter(catalog, options = {}) {
  return makeAdapter("mcp", fromMcpCatalog, catalog, options);
}

export function createAgentToolAdapter(catalog, options = {}) {
  return makeAdapter("utcp", fromAgentToolCatalog, catalog, options);
}

/** Dispatch to one of the three adapters by protocol name. */
export function createProviderAdapter({ protocol, catalog, ...options } = {}) {
  switch (protocol) {
    case "webmcp":
      return createWebMCPAdapter(catalog, options);
    case "mcp":
      return createMcpAdapter(catalog, options);
    case "utcp":
    case "agent":
      return createAgentToolAdapter(catalog, options);
    default:
      throw new TypeError(`Unsupported tool catalog protocol: ${protocol}`);
  }
}
