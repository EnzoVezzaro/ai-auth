// Unified tool registry and invocation gate.
//
// The registry stores validated descriptors, tracks their source, and decides
// whether a call may proceed. It never executes a tool: transport and native
// auth belong to the adapters. Every gate decision is recorded in a bounded,
// privacy-preserving audit sink.

import { buildToolDescriptor, parseToolId } from "./tool-descriptor.js";
import { createToolAudit } from "./tool-audit.js";

export const DENY_REASONS = Object.freeze({
  OK: "ok",
  NOT_FOUND: "tool-not-found",
  EXPIRED: "tool-expired",
  UNAVAILABLE: "tool-unavailable",
  CAPABILITY_DENIED: "capability-denied",
  AUTH_REQUIRED: "authorization-required",
  AUDIENCE_DENIED: "audience-denied",
  POLICY_DENIED: "policy-denied",
  POLICY_ERROR: "policy-error",
});

/** Convenience policy for callers that explicitly opt in to allowing calls. */
export const ALLOW_ALL_POLICY = () => true;
/** Default local policy: deny unless a caller supplies an approving hook. */
export const denyByDefault = () => false;

function approvedSet(values) {
  const out = new Set();
  if (!Array.isArray(values)) return out;
  for (const value of values) {
    // A wildcard or non-string scope never broadens an explicit grant.
    if (typeof value === "string" && value !== "*" && value.length <= 128)
      out.add(value);
  }
  return out;
}

function authorizationSatisfied(kind, ctx) {
  switch (kind) {
    case "none":
      return true;
    case "owner":
      return ctx.ownerApproved === true;
    case "site":
      return ctx.siteApproved === true;
    case "native":
      return ctx.nativeAuthorized === true;
    default:
      return false;
  }
}

function audienceSatisfied(audience, ctx) {
  if (!audience) return true;
  const origins = audience.origins ?? [];
  if (
    origins.length > 0 &&
    (typeof ctx.origin !== "string" || !origins.includes(ctx.origin))
  )
    return false;
  const walletIds = audience.walletIds ?? [];
  if (
    walletIds.length > 0 &&
    (typeof ctx.caller !== "string" || !walletIds.includes(ctx.caller))
  )
    return false;
  return true;
}

/**
 * The only object a policy hook ever sees. It intentionally excludes the
 * tool's description, native descriptor and any call arguments or payload:
 * untrusted text is data, never an instruction or a permission source.
 */
function policyContext(tool, ctx, matched) {
  return Object.freeze({
    toolId: tool.id,
    protocol: tool.protocol,
    providerId: tool.providerId,
    caller: ctx.caller,
    origin: ctx.origin,
    capabilities: tool.capabilities,
    risk: tool.risk,
    requiredAuthorization: tool.requiredAuthorization,
    approvedCapabilities: Array.isArray(ctx.approvedCapabilities)
      ? Object.freeze([...ctx.approvedCapabilities])
      : Object.freeze([]),
    matched: matched.ok,
  });
}

function policyReason(reason) {
  return typeof reason === "string" && reason.length > 0 && reason.length <= 200
    ? reason
    : DENY_REASONS.POLICY_DENIED;
}

/**
 * Create a registry. `audit` defaults to a fresh bounded audit sink and
 * `policy` defaults to deny-by-default: callers must supply an approving hook
 * for a gate to allow a call, on top of the capability/auth/availability checks.
 */
export function createToolRegistry({
  audit = createToolAudit(),
  policy = denyByDefault,
} = {}) {
  if (!audit || typeof audit.record !== "function")
    throw new TypeError("audit with a record() method is required");
  if (typeof policy !== "function")
    throw new TypeError("policy must be a function");

  /** id -> validated, frozen descriptor. Namespacing is part of the id. */
  const tools = new Map();

  return {
    audit,

    /** Validate and register a descriptor. Duplicate namespaced ids throw. */
    register(descriptor) {
      const tool = buildToolDescriptor(descriptor);
      if (tools.has(tool.id))
        throw new Error(`Tool already registered: ${tool.id}`);
      tools.set(tool.id, tool);
      return tool;
    },

    /** Remove a tool by namespaced id. Returns whether it existed. */
    unregister(id) {
      return tools.delete(id);
    },

    get(id) {
      return tools.get(id);
    },

    /** List registered tools, optionally filtered by source/provenance. */
    list(filter = {}) {
      if (filter === null || typeof filter !== "object") filter = {};
      let result = [...tools.values()];
      for (const key of ["protocol", "providerId"]) {
        if (filter[key] !== undefined)
          result = result.filter((tool) => tool[key] === filter[key]);
      }
      for (const key of ["origin", "endpoint", "page"]) {
        if (filter[key] !== undefined)
          result = result.filter((tool) => tool.source[key] === filter[key]);
      }
      return result;
    },

    /** One source record per registered tool, for provenance display/audit. */
    sources() {
      return [...tools.values()].map((tool) =>
        Object.freeze({
          toolId: tool.id,
          protocol: tool.protocol,
          providerId: tool.providerId,
          origin: tool.source.origin,
          endpoint: tool.source.endpoint,
          page: tool.source.page,
        }),
      );
    },

    /**
     * Synchronous checks that need no policy hook: existence, availability,
     * capability coverage, required authorization and audience. Pure decision,
     * no audit side effect -- invokeGate is the recording entry point.
     */
    match(id, ctx = {}) {
      const tool = tools.get(id);
      if (!tool)
        return Object.freeze({ ok: false, reason: DENY_REASONS.NOT_FOUND });

      // Availability is never permission, but it is a precondition.
      if (tool.availability === "expired")
        return Object.freeze({ ok: false, reason: DENY_REASONS.EXPIRED });
      if (tool.availability !== "online")
        return Object.freeze({ ok: false, reason: DENY_REASONS.UNAVAILABLE });

      const approved = approvedSet(ctx.approvedCapabilities);
      for (const capability of tool.capabilities) {
        if (!approved.has(capability))
          return Object.freeze({
            ok: false,
            reason: DENY_REASONS.CAPABILITY_DENIED,
          });
      }

      if (!authorizationSatisfied(tool.requiredAuthorization.kind, ctx))
        return Object.freeze({
          ok: false,
          reason: DENY_REASONS.AUTH_REQUIRED,
        });

      if (!audienceSatisfied(tool.audience, ctx))
        return Object.freeze({
          ok: false,
          reason: DENY_REASONS.AUDIENCE_DENIED,
        });

      return Object.freeze({ ok: true, reason: DENY_REASONS.OK });
    },

    /**
     * Full gate: the synchronous checks, then the local policy hook, then a
     * single audit record. Does not execute anything.
     */
    async invokeGate(id, ctx = {}) {
      const tool = tools.get(id);
      const parsed = parseToolId(id);
      const providerId = tool?.providerId ?? "unknown";
      const protocol = tool?.protocol ?? parsed?.protocol ?? "unknown";

      const matched = this.match(id, ctx);
      let allowed = false;
      let reason = matched.reason;

      if (matched.ok) {
        try {
          const verdict = await policy(policyContext(tool, ctx, matched));
          if (verdict === true || verdict?.allow === true) {
            allowed = true;
            reason = DENY_REASONS.OK;
          } else {
            reason = policyReason(verdict?.reason);
          }
        } catch {
          // Fail closed: a policy that throws must never allow a call.
          reason = DENY_REASONS.POLICY_ERROR;
        }
      }

      audit.record({
        caller: ctx.caller,
        providerId,
        protocol,
        toolId: id,
        decision: allowed ? "allow" : "deny",
        outcome: allowed ? DENY_REASONS.OK : reason,
      });

      return Object.freeze({
        allowed,
        decision: allowed ? "allow" : "deny",
        reason,
        toolId: id,
      });
    },
  };
}
