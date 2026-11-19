// Hard boundary between generic tool authority and payment authority.
//
// AP2 mandates are verified according to their own specification by an EXTERNAL,
// injected verifier. This module does NOT mint, sign, issue, decode or otherwise
// produce a real payment mandate, and it never performs a purchase, transfer or
// payment submission. It only checks that a supplied mandate is bound to one
// transaction and matches the expected checkout, then defers cryptographic
// validity to `mandateVerifier`. UCP commerce workflows live in their own layer
// and are not reachable from the unified tool registry through this module.
//
// Pure ESM: no network, no I/O, no credentials, no side effects at import time.

/** Reasons a payment authorization can be denied. `OK` is the only allow reason. */
export const PAYMENT_DENY_REASONS = Object.freeze({
  OK: "ok",
  NO_MANDATE: "payment-mandate-missing",
  GENERIC_GRANT_NOT_AUTHORITY: "generic-grant-is-not-payment-authority",
  NO_VERIFIER: "mandate-verifier-missing",
  NOT_TRANSACTION_BOUND: "mandate-not-transaction-bound",
  FIELD_MISSING: "mandate-field-missing",
  FIELD_UNKNOWN: "mandate-field-unknown",
  AUDIENCE_MISMATCH: "audience-mismatch",
  MERCHANT_MISMATCH: "merchant-mismatch",
  AMOUNT_MISMATCH: "amount-mismatch",
  CURRENCY_MISMATCH: "currency-mismatch",
  LINE_ITEMS_MISMATCH: "line-items-mismatch",
  EXPIRED: "mandate-expired",
  REVOKED: "mandate-revoked",
  HUMAN_CONFIRMATION_REQUIRED: "human-confirmation-required",
  VERIFIER_REJECTED: "verifier-rejected",
  VERIFIER_ERROR: "verifier-error",
});

/** The two possible top-level decisions. */
export const PAYMENT_DECISIONS = Object.freeze(["allow", "deny"]);

/**
 * The fields a closed payment mandate must carry to be considered
 * transaction-bound. All are mandatory; there is no "partial" authority.
 */
export const REQUIRED_MANDATE_FIELDS = Object.freeze([
  "transactionId",
  "amount",
  "currency",
  "merchant",
  "lineItems",
  "expiresAt",
  "audience",
  "humanConfirmation",
  "revoked",
]);

/**
 * UCP and AP2 have separate jobs. AI Auth supplies identity/audit primitives
 * only; it is neither the commerce workflow nor the payment credential format.
 */
export const PAYMENT_LAYER_RESPONSIBILITIES = Object.freeze({
  UCP: "UCP / Universal Commerce Protocol: merchant capability discovery, checkout, identity linking, order webhooks, payment token exchange and where mandates live in a checkout session (commerce workflow layer).",
  AP2: "AP2 / Agent Payments Protocol: verifiable digital credential mandates (checkout and payment), verifiable intent, and expiry/audience/merchant/amount/consent binding (payment credential and authority layer).",
  AI_AUTH:
    "AI Auth: portable identity, consent, scoped authority, revocation and audit primitives only. It does not mint mandates and does not execute payments.",
});

/**
 * Three unrelated acronyms share the letters ACP. Keep them distinct so a
 * commerce ACP checkout is never confused with an agent communication or
 * editor integration protocol.
 */
export const ACP_LABELS = Object.freeze({
  "agent-communication-protocol":
    "ACP (Agent Communication Protocol): IBM/BeeAI predecessor absorbed into A2A; legacy compatibility only.",
  "agent-client-protocol":
    "ACP (Agent Client Protocol): editor/IDE to coding-agent interface; orthogonal to A2A and commerce.",
  "agentic-commerce-protocol":
    "ACP (Agentic Commerce Protocol): a third, unrelated acronym for commerce checkout; modeled separately from the two above.",
});

/**
 * Signals that look like authority but are NOT payment authority. They are used
 * only to explain a denial; they never grant or widen any permission.
 */
export const GENERIC_GRANT_MARKERS = Object.freeze([
  "tools.invoke",
  "tools.execute",
  "tools:invoke",
  "capabilityGrant",
  "capability-grant",
  "membership",
  "member",
  "executionGrant",
  "execution-grant",
  "a2aTask",
  "a2a.task",
  "taskPermission",
  "codeMode",
  "code-mode",
  "ai_auth_code",
]);

const MAX_LINE_ITEMS = 100;
const MAX_TEXT = 300;
const MAX_CODE = 120;
const CURRENCY_RE = /^[A-Z]{3}$/u;
const DECIMAL_RE = /^\d+(?:\.\d{1,6})?$/u;
const CONTROL_RE = /[\u0000-\u001F\u007F]/u;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Read the first present canonical field. An explicit `undefined` is absent. */
function pick(raw, names) {
  for (const name of names) {
    if (has(raw, name) && raw[name] !== undefined)
      return { present: true, value: raw[name] };
  }
  return { present: false, value: undefined };
}

function clip(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function boundedString(value, max = MAX_TEXT) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(CONTROL_RE, " ").trim();
  if (text.length === 0) return undefined;
  return clip(text, max);
}

/** Canonical, precision-safe amount as a scaled integer string (minor units). */
function canonicalAmount(value) {
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    text = value.toFixed(6);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return undefined;
  }
  if (!DECIMAL_RE.test(text)) return undefined;
  const [whole, fraction = ""] = text.split(".");
  const scaled = `${whole}${fraction.padEnd(6, "0")}`.replace(/^0+(?=\d)/u, "");
  return /^0+$/u.test(scaled) ? undefined : scaled;
}

function canonicalCurrency(value) {
  const text = boundedString(value, 8);
  if (text === undefined) return undefined;
  const upper = text.toUpperCase();
  return CURRENCY_RE.test(upper) ? upper : undefined;
}

/** Public identifier of one purchasable line. Extra fields never add authority. */
function canonicalLineItems(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_LINE_ITEMS
  )
    return undefined;
  const items = [];
  for (const item of value) {
    if (!isObject(item)) return undefined;
    const id = boundedString(
      pick(item, ["id", "sku", "productId", "itemId"]).value,
      MAX_TEXT,
    );
    const quantity = item.quantity;
    if (id === undefined || !Number.isInteger(quantity) || quantity <= 0)
      return undefined;
    const unit = pick(item, ["unitAmount", "price", "amount"]);
    const unitAmount = unit.present ? canonicalAmount(unit.value) : null;
    if (unit.present && unitAmount === undefined) return undefined;
    items.push({ id, quantity, unitAmount });
  }
  items.sort(
    (a, b) =>
      a.id.localeCompare(b.id) ||
      a.quantity - b.quantity ||
      String(a.unitAmount).localeCompare(String(b.unitAmount)),
  );
  return items;
}

function canonicalExpiry(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const text = boundedString(value, 64);
  if (text === undefined) return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

/** Only an explicit human confirmation counts; truthy surrogates do not. */
function canonicalConfirmation(value) {
  if (value === true) return true;
  if (isObject(value) && value.confirmed === true) return true;
  return false;
}

/** Flatten audience forms to a set of strings. Unknown shapes fail closed. */
function audienceSet(value) {
  const out = new Set();
  let unknown = false;
  const add = (entry) => {
    if (typeof entry === "string") {
      const text = boundedString(entry, MAX_TEXT);
      if (text === undefined) unknown = true;
      else out.add(text);
      return;
    }
    if (Array.isArray(entry)) {
      for (const nested of entry) add(nested);
      return;
    }
    if (isObject(entry)) {
      for (const key of [
        "audience",
        "audiences",
        "origin",
        "origins",
        "walletIds",
        "id",
        "value",
      ])
        if (has(entry, key)) add(entry[key]);
      return;
    }
    // A non-string scalar is an unknown audience value. It must never become
    // a comparable token that a different unknown value could match.
    if (entry !== undefined && entry !== null) unknown = true;
  };
  add(value);
  return unknown || out.size === 0 ? undefined : out;
}

/** True only when every expected audience is explicitly listed by the mandate. */
function audiencesMatch(mandateAudience, expectedAudience) {
  if (!mandateAudience || !expectedAudience) return false;
  for (const wanted of expectedAudience)
    if (!mandateAudience.has(wanted)) return false;
  return true;
}

function looksLikeGrant(value, depth = 0) {
  if (value === undefined || value === null || depth > 4) return false;
  if (typeof value === "string")
    return GENERIC_GRANT_MARKERS.some((marker) => value.includes(marker));
  if (!isObject(value)) return false;
  const scopes = [
    ...(Array.isArray(value.scopes) ? value.scopes : []),
    ...(Array.isArray(value.capabilities) ? value.capabilities : []),
    ...(Array.isArray(value.grants) ? value.grants : []),
  ];
  return (
    scopes.some((scope) => looksLikeGrant(scope, depth + 1)) ||
    has(value, "grant")
  );
}

/** Keep only the verifier's native boolean/code/message, bounded and verbatim. */
function nativeSummary(native) {
  if (native === undefined || native === null) return null;
  if (typeof native === "boolean")
    return Object.freeze({ ok: native, code: native ? "ok" : "rejected" });
  if (!isObject(native))
    return Object.freeze({ ok: false, code: "unknown-verifier-result" });
  const ok =
    native.ok === true || native.valid === true || native.accepted === true;
  const rawCode =
    typeof native.code === "string"
      ? native.code
      : typeof native.errorCode === "string"
        ? native.errorCode
        : ok
          ? "ok"
          : "rejected";
  const summary = {
    ok,
    code: clip(String(rawCode).replace(CONTROL_RE, " "), MAX_CODE),
  };
  for (const key of ["error", "message", "nativeCode"]) {
    if (typeof native[key] === "string")
      summary[key] = clip(native[key].replace(CONTROL_RE, " "), MAX_CODE);
  }
  return Object.freeze(summary);
}

function errorCode(error) {
  const code = error && (error.code ?? error.errorCode);
  return typeof code === "string" ? clip(code, MAX_CODE) : "verifier-threw";
}

function errorMessage(error) {
  const message =
    error && typeof error.message === "string" ? error.message : "";
  return message ? clip(message.replace(CONTROL_RE, " "), MAX_CODE) : undefined;
}

/**
 * Pure, deterministic binding check: does the mandate match this one expected
 * transaction? Never mints validity -- a missing or unrecognized value denies.
 * `verifierResult` is optional and is only surfaced (native code preserved);
 * it can never make this check pass on its own.
 */
export function verifyMandateBinding({
  mandate,
  expected,
  verifierResult,
} = {}) {
  const verifier = nativeSummary(verifierResult);
  const checks = Object.freeze({
    transactionBound: false,
    audience: false,
    merchant: false,
    amount: false,
    currency: false,
    lineItems: false,
    expiry: false,
    revocation: false,
    humanConfirmation: false,
  });

  const fail = (reason, detail = checks) =>
    Object.freeze({
      ok: false,
      reason,
      checks: Object.freeze({ ...detail }),
      verifier,
    });

  if (!isObject(mandate)) return fail(PAYMENT_DENY_REASONS.NO_MANDATE);
  if (!isObject(expected)) return fail(PAYMENT_DENY_REASONS.FIELD_MISSING);

  // A checkout mandate or any non-payment kind is never a payment mandate.
  const kind = pick(mandate, ["kind", "type", "mandateType"]);
  if (kind.present) {
    const label = boundedString(kind.value, 40);
    if (label === undefined || !/^payment(?:[-_ ]mandate)?$/iu.test(label))
      return fail(PAYMENT_DENY_REASONS.NOT_TRANSACTION_BOUND);
  }

  const read = (obj, names, convert) => {
    const field = pick(obj, names);
    return {
      present: field.present,
      value: field.present ? convert(field.value) : undefined,
    };
  };

  const m = {
    transactionId: read(
      mandate,
      ["transactionId", "transaction", "checkoutId"],
      boundedString,
    ),
    amount: read(mandate, ["amount", "total"], canonicalAmount),
    currency: read(mandate, ["currency", "currencyCode"], canonicalCurrency),
    merchant: read(mandate, ["merchant", "merchantId"], boundedString),
    lineItems: read(
      mandate,
      ["lineItems", "items", "line_items"],
      canonicalLineItems,
    ),
    expiry: read(
      mandate,
      ["expiresAt", "expiry", "expiration"],
      canonicalExpiry,
    ),
    audience: read(mandate, ["audience", "audiences"], audienceSet),
    confirmation: read(
      mandate,
      ["humanConfirmation", "confirmation"],
      canonicalConfirmation,
    ),
  };
  const revokedField = pick(mandate, ["revoked", "isRevoked"]);
  const revoked = revokedField.present ? revokedField.value : undefined;

  const e = {
    transactionId: read(
      expected,
      ["transactionId", "transaction", "checkoutId"],
      boundedString,
    ),
    amount: read(expected, ["amount", "total"], canonicalAmount),
    currency: read(expected, ["currency", "currencyCode"], canonicalCurrency),
    merchant: read(expected, ["merchant", "merchantId"], boundedString),
    lineItems: read(
      expected,
      ["lineItems", "items", "line_items"],
      canonicalLineItems,
    ),
    audience: read(expected, ["audience", "audiences"], audienceSet),
  };

  // Fail closed if any required value is absent or has an unrecognized shape.
  for (const field of [...Object.values(m), ...Object.values(e)]) {
    if (!field.present) return fail(PAYMENT_DENY_REASONS.FIELD_MISSING);
    if (field.value === undefined)
      return fail(PAYMENT_DENY_REASONS.FIELD_UNKNOWN);
  }
  if (!revokedField.present) return fail(PAYMENT_DENY_REASONS.FIELD_MISSING);
  if (typeof revoked !== "boolean")
    return fail(PAYMENT_DENY_REASONS.FIELD_UNKNOWN);

  const result = { ...checks };
  result.transactionBound = m.transactionId.value === e.transactionId.value;
  if (!result.transactionBound)
    return fail(PAYMENT_DENY_REASONS.NOT_TRANSACTION_BOUND, result);

  result.audience = audiencesMatch(m.audience.value, e.audience.value);
  if (!result.audience)
    return fail(PAYMENT_DENY_REASONS.AUDIENCE_MISMATCH, result);

  result.merchant = m.merchant.value === e.merchant.value;
  if (!result.merchant)
    return fail(PAYMENT_DENY_REASONS.MERCHANT_MISMATCH, result);

  result.amount = m.amount.value === e.amount.value;
  if (!result.amount) return fail(PAYMENT_DENY_REASONS.AMOUNT_MISMATCH, result);

  result.currency = m.currency.value === e.currency.value;
  if (!result.currency)
    return fail(PAYMENT_DENY_REASONS.CURRENCY_MISMATCH, result);

  result.lineItems =
    JSON.stringify(m.lineItems.value) === JSON.stringify(e.lineItems.value);
  if (!result.lineItems)
    return fail(PAYMENT_DENY_REASONS.LINE_ITEMS_MISMATCH, result);

  result.revocation = revoked === false;
  if (!result.revocation) return fail(PAYMENT_DENY_REASONS.REVOKED, result);

  result.humanConfirmation = m.confirmation.value === true;
  if (!result.humanConfirmation)
    return fail(PAYMENT_DENY_REASONS.HUMAN_CONFIRMATION_REQUIRED, result);

  const now = Number.isFinite(expected.now) ? expected.now : Date.now();
  result.expiry = Number.isFinite(m.expiry.value) && now < m.expiry.value;
  if (!result.expiry) return fail(PAYMENT_DENY_REASONS.EXPIRED, result);

  return Object.freeze({
    ok: true,
    reason: PAYMENT_DENY_REASONS.OK,
    checks: Object.freeze(result),
    verifier,
  });
}

/** Deterministic, non-cryptographic pseudonym; avoids storing raw identifiers. */
function hashScalar(value) {
  let text;
  try {
    text = String(value);
  } catch {
    text = "unavailable";
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Build bounded audit metadata from a mandate and a decision. Only an
 * allowlist of non-sensitive scalars is copied: no payload, no card/instrument
 * data, no secrets, no verifier message. Identifiers are hashed, not stored.
 */
export function toPaymentAudit(mandate, decision) {
  const d = isObject(decision) ? decision : {};
  const raw = isObject(mandate) ? mandate : {};
  const mandateId = pick(raw, ["mandateId", "id", "paymentMandateId"]).value;
  const merchant = boundedString(
    pick(raw, ["merchant", "merchantId"]).value,
    MAX_TEXT,
  );
  const currency = canonicalCurrency(
    pick(raw, ["currency", "currencyCode"]).value,
  );
  const items = pick(raw, ["lineItems", "items", "line_items"]).value;
  const expires = canonicalExpiry(
    pick(raw, ["expiresAt", "expiry", "expiration"]).value,
  );
  const revokedField = pick(raw, ["revoked", "isRevoked"]);
  const confirmation = canonicalConfirmation(
    pick(raw, ["humanConfirmation", "confirmation"]).value,
  );
  const transactionId = boundedString(
    pick(raw, ["transactionId", "transaction", "checkoutId"]).value,
    MAX_TEXT,
  );
  const allowed = d.allowed === true || d.decision === "allow";
  const reason = boundedString(d.reason, MAX_CODE) ?? "unspecified";
  const code = boundedString(d.verifierCode, MAX_CODE);

  return Object.freeze({
    decision: allowed ? "allow" : "deny",
    reason,
    mandateIdHash:
      mandateId === undefined ? "none" : `m_${hashScalar(mandateId)}`,
    merchantHash:
      merchant === undefined ? "none" : `mc_${hashScalar(merchant)}`,
    currency: currency ?? "unknown",
    transactionBound: transactionId !== undefined,
    hasLineItems: Array.isArray(items) && items.length > 0,
    lineItemCount: Array.isArray(items)
      ? Math.min(items.length, MAX_LINE_ITEMS)
      : 0,
    expiryState: expires === undefined ? "unknown" : "present",
    revoked: revokedField.present ? revokedField.value === true : "unknown",
    humanConfirmed: confirmation === true,
    verifierCode: code ?? "none",
    ...(Number.isFinite(d.timestamp) ? { timestamp: d.timestamp } : {}),
  });
}

/** Build an authorization gate. With no verifier, every payment is denied. */
export function createPaymentBoundary({ mandateVerifier } = {}) {
  if (mandateVerifier !== undefined && typeof mandateVerifier !== "function")
    throw new TypeError("mandateVerifier must be a function");

  function finalize(decision, mandate, binding, verifier) {
    return Object.freeze({
      allowed: decision.allowed,
      decision: decision.allowed ? "allow" : "deny",
      reason: decision.reason,
      verifier,
      binding,
      audit: toPaymentAudit(mandate, {
        allowed: decision.allowed,
        reason: decision.reason,
        verifierCode: verifier?.code,
      }),
    });
  }

  const deny = (reason) => Object.freeze({ allowed: false, reason });
  const allow = () =>
    Object.freeze({ allowed: true, reason: PAYMENT_DENY_REASONS.OK });

  /**
   * Authorize ONE transaction. `toolGrant` is accepted only so it can be
   * ignored: a generic capability, membership, execution grant, A2A task
   * permission or Code Mode script is never a payment credential. Authority
   * comes solely from a bound mandate accepted by the external verifier.
   */
  async function authorizePayment({ mandate, toolGrant, context } = {}) {
    const expected = isObject(context?.expected) ? context.expected : context;

    if (!isObject(mandate)) {
      const reason =
        looksLikeGrant(toolGrant) || looksLikeGrant(context)
          ? PAYMENT_DENY_REASONS.GENERIC_GRANT_NOT_AUTHORITY
          : PAYMENT_DENY_REASONS.NO_MANDATE;
      return finalize(deny(reason), mandate, null, null);
    }

    const binding = verifyMandateBinding({ mandate, expected });
    if (!binding.ok)
      return finalize(deny(binding.reason), mandate, binding, null);

    if (typeof mandateVerifier !== "function")
      return finalize(
        deny(PAYMENT_DENY_REASONS.NO_VERIFIER),
        mandate,
        binding,
        null,
      );

    let native;
    try {
      native = await mandateVerifier(mandate, context);
    } catch (error) {
      const verifier = Object.freeze({
        ok: false,
        code: errorCode(error),
        error: errorMessage(error),
      });
      return finalize(
        deny(PAYMENT_DENY_REASONS.VERIFIER_ERROR),
        mandate,
        binding,
        verifier,
      );
    }

    const verifier = nativeSummary(native);
    if (!verifier.ok)
      return finalize(
        deny(PAYMENT_DENY_REASONS.VERIFIER_REJECTED),
        mandate,
        binding,
        verifier,
      );

    return finalize(allow(), mandate, binding, verifier);
  }

  return Object.freeze({ authorizePayment });
}
