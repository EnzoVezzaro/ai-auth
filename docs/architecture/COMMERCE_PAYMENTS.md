# Commerce and payments

> Status: boundary decision and proposed integration plan. No commerce or payment code exists in this repository. No real purchases, payment submissions or financial account operations are permitted during development or testing. Research date: 2026-11-19.

## 1. Hard rule

**Generic tool permissions must never grant authority to make a purchase, transfer money, or sign a payment mandate.**

`tools.invoke` in AI Auth means "a tool may run after scope and approval checks". It says nothing about spending. A capability grant, membership or execution grant is not a payment credential. This rule is non-negotiable and overrides any convenience argument.

## 2. Responsibilities

| System                     | Responsibility                                                                                          | AI Auth relationship                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| UCP                        | Checkout, identity linking, order webhooks, payment token exchange, capability negotiation              | Separate commerce layer; may use an AI Auth identity claim if a verifier accepts it |
| AP2                        | Verifiable Digital Credentials as checkout and payment mandates; verifiable intent, not inferred action | Separate payment layer; AI Auth does not mint mandates from generic grants          |
| UCP AP2 mandates extension | Places mandates in UCP checkout and binds them to a specific session                                    | Optional integration; "security locked" sessions cannot fall back                   |
| AI Auth                    | Portable identity, consent, scoped authority, revocation, audit                                         | Supplies identity and proof primitives only                                         |

## 3. UCP findings

From primary sources:

- Active specification with dated releases; examples use `2026-08-25`. Apache-2.0.
- Capabilities: checkout (cart, tax, human-in-the-loop or autonomous), identity linking (OAuth 2.0), order (webhooks), payment token exchange. Extensions cover fulfillment, discounts, buyer consent, AP2 mandates, 3DS, terms and split payments.
- Discovery: business profile at `/.well-known/ucp`, platform profile via `UCP-Agent`, capability intersection negotiation. Reverse-domain namespace `dev.ucp.*`.
- Transports: REST, MCP, A2A, embedded; transport agnostic.
- Keys: RFC 7517 JWK Set; EC P-256/P-384 (ES256/ES384) and OKP Ed25519 (EdDSA); `kid` is the RFC 7638 SHA-256 thumbprint; JCS (RFC 8785) for durable signatures.
- Security model is a "trust triangle" with transaction integrity and non-repudiation. Scenario C is the autonomous agent with AP2.

## 4. AP2 findings

From primary sources:

- v0.1.0 (16 Sep 2025), v0.2.0 (28 Apr 2026). Pre-1.0 and evolving. Apache-2.0.
- Standardization continues in FIDO Alliance agentic authentication and payments working groups.
- Core idea: Verifiable Digital Credentials as cryptographic mandates, "verifiable intent, not inferred action", non-repudiable audit trail.
- Checkout Mandate: Open (pre-cart constraints) and Closed (finalized checkout). Payment Mandate: Open (budget/instrument constraints) and Closed (amount bound to final checkout).
- Available as extensions for A2A and UCP.
- Known caveat: AP2 v0.2 is internally inconsistent on the signature algorithm rule (AP2 issue #268). Treat as evolving.

## 5. UCP AP2 mandates extension

From `ucp.dev/latest/specification/payment/extensions/ap2-mandates/`:

- Capability `dev.ucp.common.payment.ap2_mandate` extends `dev.ucp.shopping.checkout`.
- Once negotiated, the session is "security locked" and cannot fall back to unprotected checkout.
- Business signs checkout terms as a detached JWS (RFC 7515 Appendix F) with `alg` and `kid`; payload is JCS-canonicalized checkout minus `ap2`.
- Platform produces a checkout mandate (SD-JWT with key binding) and a payment mandate token.
- Consent models: trusted platform provider with explicit user consent, or digital payment credential presented via OpenID4VP with wallet signing.
- Verification: business verifies signature, key binding, expiry, embedded checkout, merchant authorization and terms match; PSP verifies the payment mandate. Errors include `mandate_required`, `mandate_invalid_signature`, `mandate_expired`, `mandate_scope_mismatch`.

Division of labor: UCP specifies where mandates live and how they bind to checkout; AP2 specifies the mandate credential structure.

## 6. Proposed integration boundary

| Item                                                        | Decision                                                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| AI Auth identity used as a verifiable agent identity in UCP | Optional; only if UCP verifiers accept the claim format. No new credential format.                                    |
| Key reuse                                                   | Align signing keys with ES256/Ed25519 and RFC 7638 `kid`, already consistent with AI Auth's P-256 identity.           |
| Payment authority from `tools.invoke`                       | Reject outright.                                                                                                      |
| Payment authority from a capability grant                   | Reject outright.                                                                                                      |
| Spending constraints                                        | Must be transaction-bound mandates with amount, instrument, expiry and explicit human consent as required by AP2/UCP. |
| Integration mode                                            | Separate optional package, mocks and provider sandboxes only.                                                         |
| Real financial operations                                   | Not permitted in development or testing.                                                                              |
| Core SDK changes                                            | None. No website-specific or merchant-specific logic enters the core SDK.                                             |

## 7. Acceptance criteria

- UCP commerce workflows remain separate from the unified tool registry.
- AP2 mandates are verified according to their own specification, not by AI Auth grant verification.
- Payment authorization is bound to a specific transaction and constraints.
- A test asserts that a wallet holding `tools.invoke` cannot produce a valid purchase or payment mandate.
- No real payment credentials or accounts are used in any test.
- Secrets never appear in logs, room events or audit records.
