import assert from "node:assert/strict";
import test from "node:test";

import {
  ACP_LABELS,
  GENERIC_GRANT_MARKERS,
  PAYMENT_DECISIONS,
  PAYMENT_DENY_REASONS,
  PAYMENT_LAYER_RESPONSIBILITIES,
  REQUIRED_MANDATE_FIELDS,
  createPaymentBoundary,
  toPaymentAudit,
  verifyMandateBinding,
} from "../packages/p2p/commerce-boundary.js";

const NOW = Date.parse("2026-11-19T00:00:00Z");
const EXPIRY = "2026-11-20T00:00:00Z";

const SECRETS = {
  signature: "sig_do_not_log_me",
  paymentInstrument: { cardNumber: "4111111111111111", cvv: "123" },
  secret: "super-secret-token",
  credentials: { apiKey: "sk_live_abc123" },
  token: "bearer_xyz",
};

function mandate(overrides = {}) {
  return {
    kind: "payment",
    mandateId: "mnd_123",
    transactionId: "tx_checkout_42",
    amount: "19.99",
    currency: "USD",
    merchant: "https://shop.example",
    lineItems: [{ id: "sku-1", quantity: 1, unitAmount: "19.99" }],
    expiresAt: EXPIRY,
    audience: "https://shop.example",
    humanConfirmation: { confirmed: true, method: "wallet-prompt" },
    revoked: false,
    ...SECRETS,
    ...overrides,
  };
}

function expected(overrides = {}) {
  return {
    transactionId: "tx_checkout_42",
    amount: "19.99",
    currency: "USD",
    merchant: "https://shop.example",
    lineItems: [{ id: "sku-1", quantity: 1, unitAmount: "19.99" }],
    audience: "https://shop.example",
    now: NOW,
    ...overrides,
  };
}

const accept = async () => Object.freeze({ ok: true, code: "ok" });

function boundaryWith(verifier = accept) {
  const calls = [];
  const boundary = createPaymentBoundary({
    mandateVerifier: (...args) => {
      calls.push(args);
      return verifier(...args);
    },
  });
  return { boundary, calls };
}

// ---------------------------------------------------------------------------
// Exported labels and constants
// ---------------------------------------------------------------------------

test("labels: UCP vs AP2 responsibilities and the three ACP meanings", () => {
  assert.equal(Object.isFrozen(PAYMENT_DENY_REASONS), true);
  assert.equal(Object.isFrozen(PAYMENT_DECISIONS), true);
  assert.deepEqual([...PAYMENT_DECISIONS], ["allow", "deny"]);
  assert.deepEqual(
    [...REQUIRED_MANDATE_FIELDS],
    [
      "transactionId",
      "amount",
      "currency",
      "merchant",
      "lineItems",
      "expiresAt",
      "audience",
      "humanConfirmation",
      "revoked",
    ],
  );

  assert.match(PAYMENT_LAYER_RESPONSIBILITIES.UCP, /checkout/i);
  assert.match(PAYMENT_LAYER_RESPONSIBILITIES.UCP, /UCP/i);
  assert.match(PAYMENT_LAYER_RESPONSIBILITIES.AP2, /mandate/i);
  assert.match(PAYMENT_LAYER_RESPONSIBILITIES.AP2, /AP2/i);
  assert.match(
    PAYMENT_LAYER_RESPONSIBILITIES.AI_AUTH,
    /does not mint mandates/i,
  );
  assert.notEqual(
    PAYMENT_LAYER_RESPONSIBILITIES.UCP,
    PAYMENT_LAYER_RESPONSIBILITIES.AP2,
  );

  assert.deepEqual(Object.keys(ACP_LABELS).sort(), [
    "agent-client-protocol",
    "agent-communication-protocol",
    "agentic-commerce-protocol",
  ]);
  assert.match(ACP_LABELS["agentic-commerce-protocol"], /commerce/i);
  assert.match(ACP_LABELS["agent-communication-protocol"], /A2A/i);
  assert.match(ACP_LABELS["agent-client-protocol"], /editor/i);

  for (const marker of [
    "tools.invoke",
    "membership",
    "executionGrant",
    "a2a.task",
    "ai_auth_code",
  ])
    assert.equal(GENERIC_GRANT_MARKERS.includes(marker), true);
});

// ---------------------------------------------------------------------------
// The happy path and the core separation rule
// ---------------------------------------------------------------------------

test("authorizePayment allows a bound mandate accepted by the external verifier", async () => {
  const { boundary, calls } = boundaryWith();
  const decision = await boundary.authorizePayment({
    mandate: mandate(),
    context: expected(),
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.decision, "allow");
  assert.equal(decision.reason, PAYMENT_DENY_REASONS.OK);
  assert.equal(decision.binding.ok, true);
  assert.equal(decision.verifier.code, "ok");
  assert.equal(decision.audit.decision, "allow");
  assert.equal(calls.length, 1);
  assert.equal(Object.isFrozen(decision), true);
});

test("a generic tool grant is never payment authority", async () => {
  const { boundary, calls } = boundaryWith();
  const allPowerfulGrant = {
    scopes: [
      "tools.invoke",
      "tools.execute",
      "membership",
      "a2a.task",
      "ai_auth_code",
      "*",
    ],
    capabilities: ["*"],
    executionGrant: true,
    codeMode: true,
  };

  const decision = await boundary.authorizePayment({
    toolGrant: allPowerfulGrant,
    context: expected(),
  });
  assert.equal(decision.allowed, false);
  assert.equal(
    decision.reason,
    PAYMENT_DENY_REASONS.GENERIC_GRANT_NOT_AUTHORITY,
  );
  assert.equal(decision.verifier, null);
  assert.equal(calls.length, 0);

  // A grant smuggling a mandate inside itself is still not a payment mandate.
  const smuggled = await boundary.authorizePayment({
    toolGrant: { mandate: mandate(), grant: "tools.invoke" },
    context: expected(),
  });
  assert.equal(smuggled.allowed, false);
  assert.equal(
    smuggled.reason,
    PAYMENT_DENY_REASONS.GENERIC_GRANT_NOT_AUTHORITY,
  );
  assert.equal(calls.length, 0);

  // Same signal carried only in the context must not grant authority either.
  const viaContext = await boundary.authorizePayment({
    context: { ...expected(), scopes: ["tools.invoke"] },
  });
  assert.equal(viaContext.allowed, false);
  assert.equal(
    viaContext.reason,
    PAYMENT_DENY_REASONS.GENERIC_GRANT_NOT_AUTHORITY,
  );

  // With no grant at all, a missing mandate is simply a missing mandate.
  const plain = await boundary.authorizePayment({ context: expected() });
  assert.equal(plain.allowed, false);
  assert.equal(plain.reason, PAYMENT_DENY_REASONS.NO_MANDATE);
});

// ---------------------------------------------------------------------------
// Missing / unknown fields fail closed
// ---------------------------------------------------------------------------

test("missing or unrecognized transaction fields are denied", async () => {
  const { boundary, calls } = boundaryWith();

  for (const [input, reason] of [
    [{ mandate: mandate() }, PAYMENT_DENY_REASONS.FIELD_MISSING],
    [
      { mandate: mandate({ transactionId: undefined }), context: expected() },
      PAYMENT_DENY_REASONS.FIELD_MISSING,
    ],
    [{ context: expected() }, PAYMENT_DENY_REASONS.NO_MANDATE],
    [{ mandate: mandate(), context: {} }, PAYMENT_DENY_REASONS.FIELD_MISSING],
    [
      { mandate: mandate({ amount: undefined }), context: expected() },
      PAYMENT_DENY_REASONS.FIELD_MISSING,
    ],
    [
      { mandate: mandate(), context: expected({ merchant: undefined }) },
      PAYMENT_DENY_REASONS.FIELD_MISSING,
    ],
  ]) {
    const decision = await boundary.authorizePayment(input);
    assert.equal(decision.allowed, false, JSON.stringify(input));
    assert.equal(decision.reason, reason);
  }

  const malformed = await boundary.authorizePayment({
    mandate: mandate({ amount: { not: "a number" } }),
    context: expected(),
  });
  assert.equal(malformed.allowed, false);
  assert.equal(malformed.reason, PAYMENT_DENY_REASONS.FIELD_UNKNOWN);

  const wrongKind = await boundary.authorizePayment({
    mandate: mandate({ kind: "checkout" }),
    context: expected(),
  });
  assert.equal(wrongKind.allowed, false);
  assert.equal(wrongKind.reason, PAYMENT_DENY_REASONS.NOT_TRANSACTION_BOUND);

  assert.equal(
    calls.length,
    0,
    "verifier must not be called on malformed input",
  );
});

test("verifyMandateBinding is pure, frozen and never invents validity", () => {
  const result = verifyMandateBinding({
    mandate: mandate(),
    expected: expected(),
  });
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
  assert.deepEqual(
    { ...result.checks },
    {
      transactionBound: true,
      audience: true,
      merchant: true,
      amount: true,
      currency: true,
      lineItems: true,
      expiry: true,
      revocation: true,
      humanConfirmation: true,
    },
  );

  // A verifier result is surfaced verbatim but cannot make a bad binding pass.
  const native = Object.freeze({ ok: false, code: "MANDATE_SCOPE_MISMATCH" });
  const preserved = verifyMandateBinding({
    mandate: mandate({ merchant: "https://evil.example" }),
    expected: expected(),
    verifierResult: native,
  });
  assert.equal(preserved.ok, false);
  assert.equal(preserved.reason, PAYMENT_DENY_REASONS.MERCHANT_MISMATCH);
  assert.equal(preserved.verifier.code, "MANDATE_SCOPE_MISMATCH");

  const empty = verifyMandateBinding();
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, PAYMENT_DENY_REASONS.NO_MANDATE);
  assert.equal(empty.verifier, null);
});

// ---------------------------------------------------------------------------
// Binding mismatches
// ---------------------------------------------------------------------------

test("wrong transaction, audience, merchant, amount, currency or items are denied", () => {
  const cases = [
    [
      { mandate: mandate({ transactionId: "tx_other" }) },
      PAYMENT_DENY_REASONS.NOT_TRANSACTION_BOUND,
    ],
    [
      { mandate: mandate({ audience: "https://other.example" }) },
      PAYMENT_DENY_REASONS.AUDIENCE_MISMATCH,
    ],
    [
      { mandate: mandate({ merchant: "https://attacker.example" }) },
      PAYMENT_DENY_REASONS.MERCHANT_MISMATCH,
    ],
    [
      { mandate: mandate({ amount: "20.00" }) },
      PAYMENT_DENY_REASONS.AMOUNT_MISMATCH,
    ],
    [
      { mandate: mandate({ currency: "EUR" }) },
      PAYMENT_DENY_REASONS.CURRENCY_MISMATCH,
    ],
    [
      {
        mandate: mandate({
          lineItems: [{ id: "sku-1", quantity: 2, unitAmount: "19.99" }],
        }),
      },
      PAYMENT_DENY_REASONS.LINE_ITEMS_MISMATCH,
    ],
    [
      {
        mandate: mandate({
          lineItems: [{ id: "sku-999", quantity: 1, unitAmount: "19.99" }],
        }),
      },
      PAYMENT_DENY_REASONS.LINE_ITEMS_MISMATCH,
    ],
  ];

  for (const [input, reason] of cases) {
    const binding = verifyMandateBinding({
      mandate: input.mandate,
      expected: input.expected ?? expected(),
    });
    assert.equal(binding.ok, false, reason);
    assert.equal(binding.reason, reason);
  }
});

test("line item order does not matter but quantities do", () => {
  const items = [
    { id: "sku-a", quantity: 1 },
    { id: "sku-b", quantity: 2 },
  ];
  const result = verifyMandateBinding({
    mandate: mandate({ lineItems: [items[1], items[0]] }),
    expected: expected({ lineItems: items }),
  });
  assert.equal(result.ok, true);

  const changed = verifyMandateBinding({
    mandate: mandate({ lineItems: [{ id: "sku-a", quantity: 3 }, items[1]] }),
    expected: expected({ lineItems: items }),
  });
  assert.equal(changed.reason, PAYMENT_DENY_REASONS.LINE_ITEMS_MISMATCH);

  const empty = verifyMandateBinding({
    mandate: mandate({ lineItems: [] }),
    expected: expected(),
  });
  assert.equal(empty.reason, PAYMENT_DENY_REASONS.FIELD_UNKNOWN);
});

test("audience sets require every expected audience to be listed", () => {
  const result = verifyMandateBinding({
    mandate: mandate({ audience: ["https://shop.example", "wallet-123"] }),
    expected: expected({ audience: { origins: ["https://shop.example"] } }),
  });
  assert.equal(result.ok, true);

  const missing = verifyMandateBinding({
    mandate: mandate({ audience: ["https://shop.example"] }),
    expected: expected({
      audience: ["https://shop.example", "platform-123"],
    }),
  });
  assert.equal(missing.reason, PAYMENT_DENY_REASONS.AUDIENCE_MISMATCH);

  // Unknown scalar audiences must fail closed, not normalize into a value that
  // a different unknown value could accidentally match.
  for (const bad of [123, { origins: [123] }, {}]) {
    const unknown = verifyMandateBinding({
      mandate: mandate({ audience: bad }),
      expected: expected(),
    });
    assert.equal(unknown.reason, PAYMENT_DENY_REASONS.FIELD_UNKNOWN);
  }
});

// ---------------------------------------------------------------------------
// Expiry, revocation, confirmation
// ---------------------------------------------------------------------------

test("expired or revoked mandates are denied", () => {
  const expired = verifyMandateBinding({
    mandate: mandate(),
    expected: expected({ now: Date.parse("2026-11-21T00:00:00Z") }),
  });
  assert.equal(expired.reason, PAYMENT_DENY_REASONS.EXPIRED);

  const malformed = verifyMandateBinding({
    mandate: mandate({ expiresAt: "not-a-date" }),
    expected: expected(),
  });
  assert.equal(malformed.reason, PAYMENT_DENY_REASONS.FIELD_UNKNOWN);

  const revoked = verifyMandateBinding({
    mandate: mandate({ revoked: true }),
    expected: expected(),
  });
  assert.equal(revoked.reason, PAYMENT_DENY_REASONS.REVOKED);

  const unknownFlag = verifyMandateBinding({
    mandate: mandate({ revoked: "false" }),
    expected: expected(),
  });
  assert.equal(unknownFlag.reason, PAYMENT_DENY_REASONS.FIELD_UNKNOWN);
});

test("an explicit human confirmation is required", async () => {
  const { boundary, calls } = boundaryWith();

  for (const value of [false, "yes", 1, { confirmed: false }]) {
    const decision = await boundary.authorizePayment({
      mandate: mandate({ humanConfirmation: value }),
      context: expected(),
    });
    assert.equal(decision.allowed, false, String(value));
    assert.equal(
      decision.reason,
      PAYMENT_DENY_REASONS.HUMAN_CONFIRMATION_REQUIRED,
    );
  }

  const missing = await boundary.authorizePayment({
    mandate: mandate({ humanConfirmation: undefined }),
    context: expected(),
  });
  assert.equal(missing.reason, PAYMENT_DENY_REASONS.FIELD_MISSING);

  const objectForm = await boundary.authorizePayment({
    mandate: mandate({ humanConfirmation: { confirmed: true, at: NOW } }),
    context: expected(),
  });
  assert.equal(objectForm.allowed, true);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// The external verifier's native result/code is preserved
// ---------------------------------------------------------------------------

test("no verifier means no payment authority", async () => {
  const boundary = createPaymentBoundary();
  const decision = await boundary.authorizePayment({
    mandate: mandate(),
    context: expected(),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, PAYMENT_DENY_REASONS.NO_VERIFIER);
  assert.equal(decision.binding.ok, true);
});

test("verifier rejection and thrown errors preserve native codes", async () => {
  const rejected = boundaryWith(async () => ({
    ok: false,
    code: "mandate_invalid_signature",
    error: "bad signature",
  }));
  const denied = await rejected.boundary.authorizePayment({
    mandate: mandate(),
    context: expected(),
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, PAYMENT_DENY_REASONS.VERIFIER_REJECTED);
  assert.equal(denied.verifier.code, "mandate_invalid_signature");
  assert.equal(denied.verifier.error, "bad signature");
  assert.equal(denied.verifier.ok, false);
  assert.equal(denied.audit.verifierCode, "mandate_invalid_signature");

  const booleanReject = boundaryWith(async () => false);
  const boolDecision = await booleanReject.boundary.authorizePayment({
    mandate: mandate(),
    context: expected(),
  });
  assert.equal(boolDecision.reason, PAYMENT_DENY_REASONS.VERIFIER_REJECTED);
  assert.equal(boolDecision.verifier.code, "rejected");

  const thrown = boundaryWith(async () => {
    const error = new Error("PSP offline");
    error.code = "MANDATE_VERIFICATION_UNAVAILABLE";
    throw error;
  });
  const failed = await thrown.boundary.authorizePayment({
    mandate: mandate(),
    context: expected(),
  });
  assert.equal(failed.allowed, false);
  assert.equal(failed.reason, PAYMENT_DENY_REASONS.VERIFIER_ERROR);
  assert.equal(failed.verifier.code, "MANDATE_VERIFICATION_UNAVAILABLE");
  assert.equal(failed.verifier.error, "PSP offline");
});

test("a constructor rejects a non-function verifier", () => {
  assert.throws(
    () => createPaymentBoundary({ mandateVerifier: {} }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// Privacy-preserving, bounded audit
// ---------------------------------------------------------------------------

test("audit metadata contains no credentials, payload or secrets", async () => {
  const boundary = createPaymentBoundary({ mandateVerifier: accept });
  const decision = await boundary.authorizePayment({
    mandate: mandate(),
    context: expected(),
  });
  const serialized = JSON.stringify(decision.audit);

  for (const needle of [
    SECRETS.signature,
    SECRETS.secret,
    SECRETS.token,
    SECRETS.paymentInstrument.cardNumber,
    SECRETS.paymentInstrument.cvv,
    SECRETS.credentials.apiKey,
    "paymentInstrument",
    "credentials",
    "cardNumber",
    "lineItems",
    "mnd_123",
    "https://shop.example",
    "wallet-prompt",
  ])
    assert.equal(serialized.includes(needle), false, `leaked: ${needle}`);

  assert.equal(Object.isFrozen(decision.audit), true);
  assert.deepEqual(Object.keys(decision.audit).sort(), [
    "currency",
    "decision",
    "expiryState",
    "hasLineItems",
    "humanConfirmed",
    "lineItemCount",
    "mandateIdHash",
    "merchantHash",
    "reason",
    "revoked",
    "transactionBound",
    "verifierCode",
  ]);
  assert.equal(decision.audit.currency, "USD");
  assert.equal(decision.audit.lineItemCount, 1);
  assert.equal(decision.audit.humanConfirmed, true);
  assert.equal(decision.audit.transactionBound, true);
  assert.match(decision.audit.mandateIdHash, /^m_[0-9a-f]{8}$/u);
  assert.match(decision.audit.merchantHash, /^mc_[0-9a-f]{8}$/u);
});

test("toPaymentAudit is bounded, allowlisted and safe on missing input", () => {
  const audit = toPaymentAudit(
    mandate({ secret: "x".repeat(5000), mandateId: "i".repeat(5000) }),
    {
      allowed: false,
      reason: "r".repeat(5000),
      verifierCode: "c".repeat(5000),
    },
  );
  for (const value of Object.values(audit)) {
    if (typeof value !== "string") continue;
    assert.equal(value.includes("x"), false);
    assert.equal(value.length <= 300, true, `unbounded field: ${value.length}`);
  }
  assert.equal(audit.reason.endsWith("…"), true);
  assert.equal(audit.verifierCode.endsWith("…"), true);
  assert.equal(audit.decision, "deny");

  const empty = toPaymentAudit();
  assert.equal(empty.decision, "deny");
  assert.equal(empty.reason, "unspecified");
  assert.equal(empty.merchantHash, "none");
  assert.equal(empty.currency, "unknown");
  assert.equal(empty.revoked, "unknown");
  assert.equal(Object.isFrozen(empty), true);
});

// ---------------------------------------------------------------------------
// Inputs are never mutated
// ---------------------------------------------------------------------------

test("no input is mutated (deep-frozen inputs)", async () => {
  const deepFreeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };

  const m = deepFreeze(mandate());
  const e = deepFreeze(expected());
  const grant = deepFreeze({ scopes: ["tools.invoke"] });
  const context = deepFreeze({ ...e, toolGrant: grant });
  const before = {
    m: structuredClone(m),
    e: structuredClone(e),
    grant: structuredClone(grant),
    context: structuredClone(context),
  };

  const boundary = createPaymentBoundary({ mandateVerifier: accept });
  await boundary.authorizePayment({ mandate: m, toolGrant: grant, context });
  verifyMandateBinding({ mandate: m, expected: e });
  toPaymentAudit(m, { allowed: true, reason: "ok" });

  assert.deepEqual(m, before.m);
  assert.deepEqual(e, before.e);
  assert.deepEqual(grant, before.grant);
  assert.deepEqual(context, before.context);
});
