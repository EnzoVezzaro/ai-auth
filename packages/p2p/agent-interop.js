// Agent interoperability BOUNDARY (docs/architecture/AGENT_INTEROPERABILITY.md,
// docs/INTEROPERABILITY_CODE_MODE_RFC.md § P5).
//
// This module is additive and deliberately thin. It does NOT own A2A Agent
// Cards, A2A Task state machines, ACP sessions, ACP permission prompts or any
// JSON-RPC binding. It only supplies identity-claim and *untrusted metadata*
// helpers, plus explicit protocol labels so acronym collisions are resolved
// instead of guessed.
//
// Invariants enforced here:
//  1. Peer/card/task text is untrusted data, never instructions or permission.
//  2. An A2A Task is agent coordination, never a tool call. `authorizeAgentTask`
//     always denies and never returns a capability or tool permission.
//  3. An identity claim carries an existing signed AI Auth envelope verbatim;
//     it does not invent a new credential format or a new signature. Signature
//     validity is decided by an injected `verifier`, never by this module.
//  4. AI Auth grants, wallet credentials and task permissions are never
//     forwarded into another protocol automatically.
//
// Intentionally ABSENT: there is no `attachToolGrant`, `grantToolsFromTask`,
// `taskToToolCall` or equivalent export. An A2A task is not a tool call, so a
// helper that attaches a tool grant from a task/task metadata/card would turn
// agent coordination into authority — exactly the conflation the boundary
// forbids. Adding such a helper requires a separate trust review.

// ---------------------------------------------------------------------------
// Tiny, dependency-free helpers (no network, no DOM, no crypto at import time)
// ---------------------------------------------------------------------------

const isObject = (v) =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isPlainObject = (v) =>
  isObject(v) && Object.getPrototypeOf(v) === Object.prototype;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function fail(reason) {
  return deepFreeze({ ok: false, reason });
}

/** JSON-only clone: never returns the caller's object or array. */
function cloneJson(value, depth = 0) {
  if (depth > 24) throw new TypeError("Value is too deep to clone");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new TypeError("Non-finite numbers are not supported");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => cloneJson(v, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value))
      out[key] = cloneJson(value[key], depth + 1);
    return out;
  }
  throw new TypeError("Non-JSON value cannot be embedded in an interop record");
}

/** Bounded, inert string capture. Text is copied, never interpreted. */
function safeText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const VALID_CAPABILITY = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;
const MAX_CAPABILITY_LENGTH = 128;

// ---------------------------------------------------------------------------
// Protocol identity labels — spell out which "ACP" is meant
// ---------------------------------------------------------------------------

export const PROTOCOL_IDS = deepFreeze({
  A2A: "a2a",
  AGENT_CLIENT: "agent-client-protocol",
  AGENTIC_COMMERCE: "agentic-commerce-protocol",
  AGENT_COMMUNICATION: "agent-communication-protocol",
  AMBIGUOUS: "ambiguous",
  UNKNOWN: "unknown",
});

export const PROTOCOL_LABELS = deepFreeze({
  [PROTOCOL_IDS.A2A]: "A2A (Agent2Agent) 1.0.0 — agent-to-agent coordination",
  [PROTOCOL_IDS.AGENT_CLIENT]:
    "Agent Client Protocol — editor/harness ↔ coding agent (not A2A)",
  [PROTOCOL_IDS.AGENTIC_COMMERCE]:
    "Agentic Commerce Protocol — commerce checkout (not an agent-chat protocol)",
  [PROTOCOL_IDS.AGENT_COMMUNICATION]:
    "Agent Communication Protocol — historical IBM/BeeAI project, archived into A2A",
  [PROTOCOL_IDS.AMBIGUOUS]:
    "Ambiguous ACP acronym — spell out which protocol is meant",
  [PROTOCOL_IDS.UNKNOWN]: "Unknown protocol",
});

function normalizeName(name) {
  if (typeof name !== "string") return "";
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_\-/.]+/gu, " ")
    .trim();
}

/**
 * Classify a protocol by name into an explicit identity id. Bare `ACP` is
 * reported as `ambiguous` rather than guessed — the docs require the acronym
 * to be spelled out. Recognized ids key into {@link PROTOCOL_LABELS}.
 */
export function classifyProtocol(name) {
  const n = normalizeName(name);
  if (!n) return PROTOCOL_IDS.UNKNOWN;
  if (
    /\ba2a\b/u.test(n) ||
    n.includes("agent2agent") ||
    n.includes("agent to agent")
  )
    return PROTOCOL_IDS.A2A;
  // Agentic Commerce is a third ACP: match it before the generic ACP rules.
  if (n.includes("agentic commerce") || n.includes("commerce acp"))
    return PROTOCOL_IDS.AGENTIC_COMMERCE;
  // Historical IBM/BeeAI Agent Communication Protocol.
  if (
    n.includes("agent communication") ||
    n.includes("ibm acp") ||
    n.includes("beeai acp") ||
    n.includes("historical acp")
  )
    return PROTOCOL_IDS.AGENT_COMMUNICATION;
  // Editor/harness Agent Client Protocol.
  if (
    n.includes("agent client") ||
    n.includes("client protocol") ||
    n.includes("acp client") ||
    n.includes("harness protocol")
  )
    return PROTOCOL_IDS.AGENT_CLIENT;
  if (n === "acp" || n.includes("acp")) return PROTOCOL_IDS.AMBIGUOUS;
  return PROTOCOL_IDS.UNKNOWN;
}

/** Human-readable label for a protocol id (or a raw name). */
export function protocolLabel(idOrName) {
  const id = Object.values(PROTOCOL_IDS).includes(idOrName)
    ? idOrName
    : classifyProtocol(idOrName);
  if (id === PROTOCOL_IDS.UNKNOWN) return null;
  return PROTOCOL_LABELS[id] ?? null;
}

/**
 * A small boundary marker for the Agent Client Protocol (editor/harness).
 * It states identity and non-ownership; it does not implement sessions,
 * turns, streaming or permission semantics.
 */
export function createAcpHarnessBoundary({ protocolVersion = 1 } = {}) {
  const version =
    typeof protocolVersion === "number" && Number.isFinite(protocolVersion)
      ? String(protocolVersion)
      : (safeText(protocolVersion, 32) ?? "1");
  return deepFreeze({
    protocol: PROTOCOL_IDS.AGENT_CLIENT,
    label: PROTOCOL_LABELS[PROTOCOL_IDS.AGENT_CLIENT],
    protocolVersion: version,
    transport: "jsonrpc-2.0-stdio",
    // AI Auth does not own or duplicate ACP session/permission semantics.
    ownsSessionSemantics: false,
    ownsPermissionSemantics: false,
    notTheSameAs: deepFreeze({
      historical: PROTOCOL_IDS.AGENT_COMMUNICATION,
      commerce: PROTOCOL_IDS.AGENTIC_COMMERCE,
      agentToAgent: PROTOCOL_IDS.A2A,
    }),
    classify: classifyProtocol,
  });
}

// ---------------------------------------------------------------------------
// Untrusted A2A Agent Card view
// ---------------------------------------------------------------------------

function safeHttpUrl(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 2048) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

const MAX_SKILLS = 32;
const MAX_AUTH_SCHEMES = 16;

function readSkills(value) {
  if (!Array.isArray(value)) return deepFreeze([]);
  const out = [];
  for (const skill of value.slice(0, MAX_SKILLS)) {
    if (!isObject(skill)) continue;
    out.push(
      deepFreeze({
        id: safeText(skill.id, 120),
        name: safeText(skill.name, 200),
        // Untrusted descriptive text. Captured as inert data only.
        description: safeText(skill.description, 500),
      }),
    );
  }
  return deepFreeze(out);
}

function readAuthSchemes(card) {
  const schemes =
    card.securitySchemes ?? card.authSchemes ?? card.authentication ?? null;
  const out = [];
  const add = (key, value) => {
    const type = isObject(value)
      ? safeText(value.type ?? value.scheme, 80)
      : safeText(value, 80);
    out.push(deepFreeze({ name: safeText(key, 120), type }));
  };
  if (isObject(schemes)) {
    for (const [key, value] of Object.entries(schemes).slice(
      0,
      MAX_AUTH_SCHEMES,
    ))
      add(key, value);
  } else if (Array.isArray(schemes)) {
    for (const value of schemes.slice(0, MAX_AUTH_SCHEMES)) add(null, value);
  }
  return deepFreeze(out);
}

function verifierVerdict(value) {
  return typeof value === "boolean" ? value : Boolean(value && value.ok);
}

/**
 * Read an A2A Agent Card fixture into a safe, untrusted metadata view.
 *
 * The view never grants authority: `capabilities`, `toolPermissions` and
 * `authority` are always empty/"none" regardless of card content. Card text
 * (name, skill descriptions, auth schemes) is copied as inert, bounded strings
 * and is never treated as instructions or permission. An optional `verifier`
 * may inspect a signed card, but even a verified card gains no permissions.
 * The input card is never mutated.
 */
export async function fromAgentCard(card, { verifier } = {}) {
  if (!isObject(card)) throw new TypeError("Agent Card must be an object");

  const signed = Boolean(
    card.signature ||
    (Array.isArray(card.signatures) && card.signatures.length > 0),
  );
  let verification = "not-checked";
  if (signed && typeof verifier === "function") {
    try {
      verification = verifierVerdict(await verifier(card))
        ? "verified"
        : "unverified";
    } catch {
      verification = "unverified";
    }
  } else if (signed) {
    verification = "unverified";
  } else if (typeof verifier === "function") {
    verification = "no-signature";
  }

  return deepFreeze({
    protocol: PROTOCOL_IDS.A2A,
    kind: "untrusted-agent-card-metadata",
    untrusted: true,
    name: safeText(card.name, 200),
    url: safeHttpUrl(card.url),
    skills: readSkills(card.skills),
    authSchemes: readAuthSchemes(card),
    signed,
    verification,
    // No permission is derived from a card, signed or otherwise.
    capabilities: deepFreeze([]),
    toolPermissions: deepFreeze([]),
    authority: "none",
    note: "Card text is untrusted data, never instructions or permission.",
  });
}

// ---------------------------------------------------------------------------
// Minimal identity claim bound to an existing signed AI Auth envelope
// ---------------------------------------------------------------------------

export const IDENTITY_CLAIM_TYPE = "a2a/identity-claim";
export const CLAIM_VERSION = 1;

function normalizeIdentity(value) {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label || label.length > 512) return null;
  if (label.startsWith("agent:") && label.length > "agent:".length)
    return label;
  if (label.startsWith("did:key:") && label.length > "did:key:".length)
    return label;
  return null;
}

function normalizeInteraction(interaction) {
  if (!isObject(interaction)) return null;
  const id = safeText(interaction.id, 256);
  if (!id) return null;
  const protocol = safeText(interaction.protocol, 80);
  const kind = safeText(interaction.kind, 80);
  return deepFreeze({
    id,
    protocol: protocol ?? null,
    kind: kind ?? null,
  });
}

function interactionId(value) {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof value.id === "string") return value.id;
  return null;
}

/**
 * Create a claim binder bound to an identity label and an injected verifier.
 *
 * `create()` wraps an EXISTING signed AI Auth envelope (the output of
 * `signEnvelope`) together with an external interaction descriptor. It copies
 * the envelope verbatim — no re-signing, no new credential format — and adds
 * no grants or capabilities. `subject` is the requested identity label
 * (`agent:` or an additive `did:key:` alias); `identity` is the envelope's own
 * issuer. Equivalence between the two is never asserted here.
 *
 * `verify()` checks origin/audience binding and delegates signature validity
 * to `verifier(envelope, { expectedIssuer })`, failing closed on any error.
 */
export function createAgentIdentityClaim({ identity, verifier } = {}) {
  if (typeof verifier !== "function")
    throw new TypeError("A verifier function is required");
  if (
    identity !== undefined &&
    identity !== null &&
    normalizeIdentity(identity) === null
  )
    throw new TypeError("Invalid identity label (expected agent: or did:key:)");
  const subject = normalizeIdentity(identity);

  function create({ envelope, interaction, audience } = {}) {
    if (
      !isObject(envelope) ||
      !isObject(envelope.body) ||
      !isObject(envelope.proof)
    )
      throw new TypeError("A signed AI Auth envelope is required");
    const issuer = envelope.body.issuer;
    if (normalizeIdentity(issuer) === null)
      throw new TypeError("Envelope has no AI Auth agent: issuer");
    const interactionView = normalizeInteraction(interaction);
    if (!interactionView)
      throw new TypeError(
        "A valid interaction { protocol, kind, id } is required",
      );
    if (
      audience !== undefined &&
      audience !== null &&
      (typeof audience !== "string" || audience.length > 512)
    )
      throw new TypeError("Invalid audience label");

    return deepFreeze({
      version: CLAIM_VERSION,
      type: IDENTITY_CLAIM_TYPE,
      // Identity comes from the signed envelope, never invented here.
      identity: issuer,
      subject,
      interaction: interactionView,
      audience: typeof audience === "string" ? audience : null,
      // Signature is preserved verbatim; validity is the verifier's decision.
      envelope: cloneJson(envelope),
      // An identity claim confers no tool permission.
      grants: deepFreeze([]),
      capabilities: deepFreeze([]),
    });
  }

  async function verify(claim, expectations = {}) {
    if (
      !isObject(claim) ||
      claim.type !== IDENTITY_CLAIM_TYPE ||
      claim.version !== CLAIM_VERSION ||
      !isObject(claim.envelope) ||
      normalizeIdentity(claim.identity) === null ||
      !isObject(claim.interaction) ||
      typeof claim.interaction.id !== "string"
    )
      return fail("malformed-claim");
    if (claim.subject !== null && normalizeIdentity(claim.subject) === null)
      return fail("malformed-claim");

    const expectedIdentity =
      expectations.expectedIdentity ?? subject ?? claim.identity;
    if (
      expectedIdentity !== claim.identity &&
      expectedIdentity !== claim.subject
    )
      return fail("identity-mismatch");

    const expectedInteraction = expectations.expectedInteraction;
    if (expectedInteraction !== undefined) {
      const expectedId = interactionId(expectedInteraction);
      if (!expectedId || expectedId !== claim.interaction.id)
        return fail("interaction-mismatch");
      if (isObject(expectedInteraction)) {
        const protocol = safeText(expectedInteraction.protocol, 80);
        const kind = safeText(expectedInteraction.kind, 80);
        if (protocol && protocol !== claim.interaction.protocol)
          return fail("interaction-mismatch");
        if (kind && kind !== claim.interaction.kind)
          return fail("interaction-mismatch");
      }
    }

    if (
      expectations.expectedAudience !== undefined &&
      expectations.expectedAudience !== claim.audience
    )
      return fail("audience-mismatch");

    let verdict;
    try {
      verdict = await verifier(claim.envelope, {
        expectedIssuer: claim.identity,
      });
    } catch {
      return fail("verifier-error");
    }
    if (!verifierVerdict(verdict)) return fail("bad-signature");

    return deepFreeze({
      ok: true,
      identity: claim.identity,
      subject: claim.subject,
      interaction: claim.interaction,
      audience: claim.audience,
    });
  }

  return deepFreeze({ identity: subject, create, verify });
}

/** Standalone claim verification with an injected verifier. */
export async function verifyAgentIdentityClaim(
  claim,
  { verifier, ...rest } = {},
) {
  if (typeof verifier !== "function") return fail("verifier-missing");
  const binder = createAgentIdentityClaim({ verifier });
  // subject comes from the claim itself, not from the binder.
  return binder.verify(claim, rest);
}

// ---------------------------------------------------------------------------
// Deny-by-default A2A task authorization
// ---------------------------------------------------------------------------

export const INTEROP_DENIAL_CODES = deepFreeze({
  TASK_NOT_A_TOOL_CALL: "TASK_NOT_A_TOOL_CALL",
  CAPABILITY_NOT_APPROVED: "CAPABILITY_NOT_APPROVED",
  INVALID_IDENTITY: "INVALID_IDENTITY",
});

function readRequestedCapabilities(task) {
  if (!isObject(task)) return [];
  const candidates = [
    task.capabilities,
    task.metadata?.capabilities,
    task.metadata?.requestedCapabilities,
  ];
  const out = [];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    for (const value of list.slice(0, 64)) {
      if (
        typeof value === "string" &&
        value.length <= MAX_CAPABILITY_LENGTH &&
        VALID_CAPABILITY.test(value) &&
        !out.includes(value)
      )
        out.push(value);
    }
  }
  return out;
}

/**
 * Deny-by-default gate for an A2A Task. An A2A task coordinates independent
 * agents; it is NOT a tool call and must never imply tool permission. This
 * function always returns `allowed: false`, `toolPermission: false` and an
 * empty `grantedCapabilities`, with a specific reason/code. Inputs are never
 * mutated.
 */
export function authorizeAgentTask({
  task,
  identity,
  approvedCapabilities,
} = {}) {
  const requested = readRequestedCapabilities(task);
  const approved = new Set(
    Array.isArray(approvedCapabilities)
      ? approvedCapabilities.filter(
          (value) =>
            typeof value === "string" &&
            value.length <= MAX_CAPABILITY_LENGTH &&
            VALID_CAPABILITY.test(value),
        )
      : [],
  );
  const missing = requested.filter((value) => !approved.has(value));
  const identityLabel = normalizeIdentity(identity);

  let code = INTEROP_DENIAL_CODES.TASK_NOT_A_TOOL_CALL;
  let reason =
    "An A2A Task is agent coordination, not a tool call; it never grants AI Auth tool permission";
  if (identity !== undefined && identity !== null && identityLabel === null) {
    code = INTEROP_DENIAL_CODES.INVALID_IDENTITY;
    reason =
      "Task authorization requires a valid AI Auth agent: or did:key: identity";
  } else if (missing.length > 0) {
    code = INTEROP_DENIAL_CODES.CAPABILITY_NOT_APPROVED;
    reason = `Task requests capabilities not approved for this identity: ${missing.join(", ")}`;
  }

  return deepFreeze({
    allowed: false,
    ok: false,
    code,
    reason,
    identity: identityLabel,
    requestedCapabilities: deepFreeze([...requested]),
    missingCapabilities: deepFreeze([...missing]),
    grantedCapabilities: deepFreeze([]),
    toolPermission: false,
  });
}

export default {
  PROTOCOL_IDS,
  PROTOCOL_LABELS,
  classifyProtocol,
  protocolLabel,
  createAcpHarnessBoundary,
  fromAgentCard,
  createAgentIdentityClaim,
  verifyAgentIdentityClaim,
  authorizeAgentTask,
  INTEROP_DENIAL_CODES,
  IDENTITY_CLAIM_TYPE,
  CLAIM_VERSION,
};
