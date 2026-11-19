// Bounded, privacy-preserving audit of tool-registry decisions.
//
// A record contains only scalar metadata: a caller pseudonym, provider,
// protocol, tool id, decision, outcome and a timestamp. Payloads, arguments,
// secrets and untrusted descriptions are never accepted into a record -- the
// recorder copies an allowlist of fields, it does not spread its input.

export const DECISIONS = Object.freeze(["allow", "deny"]);
export const MAX_AUDIT_ENTRIES = 256;

const FIELD_LIMIT = 200;
const TOOL_ID_LIMIT = 300;

/**
 * Deterministic pseudonym for a caller id. FNV-1a is enough to avoid storing a
 * raw identifier; it is NOT a security-grade hash. Sensitive deployments can
 * inject a stronger `hashCaller` into createToolAudit.
 */
export function hashCallerId(value) {
  const text = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `c_${hash.toString(16).padStart(8, "0")}`;
}

function clipped(value, label, max) {
  if (value === undefined || value === null)
    throw new TypeError(`${label} is required`);
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  const text = value.replace(/[\u0000-\u001F\u007F]/gu, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Create an audit sink. `limit` caps the in-memory ring; older entries are
 * evicted first. `now` is injectable so tests are deterministic.
 */
export function createToolAudit({
  limit = MAX_AUDIT_ENTRIES,
  now = () => Date.now(),
  hashCaller = hashCallerId,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("limit must be a positive integer");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof hashCaller !== "function")
    throw new TypeError("hashCaller must be a function");

  const entries = [];

  return {
    /**
     * Append one decision record. Unknown fields in the argument are ignored,
     * which is what keeps payloads, secrets and descriptions out of the audit.
     */
    record({ caller, providerId, protocol, toolId, decision, outcome } = {}) {
      if (!DECISIONS.includes(decision))
        throw new TypeError("decision must be allow or deny");
      const when = now();
      const entry = Object.freeze({
        caller:
          caller === undefined || caller === null
            ? "anonymous"
            : clipped(hashCaller(caller), "caller", FIELD_LIMIT),
        providerId: clipped(providerId, "providerId", FIELD_LIMIT),
        protocol: clipped(protocol, "protocol", FIELD_LIMIT),
        toolId: clipped(toolId, "toolId", TOOL_ID_LIMIT),
        decision,
        outcome: clipped(outcome, "outcome", FIELD_LIMIT),
        timestamp: Number.isFinite(when) ? when : 0,
      });
      entries.push(entry);
      while (entries.length > limit) entries.shift();
      return entry;
    },
    /** Snapshot of the ring, oldest first. */
    list: () => [...entries],
    size: () => entries.length,
    clear: () => {
      entries.length = 0;
    },
    get limit() {
      return limit;
    },
  };
}
