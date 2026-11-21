# Architecture decisions

> Status: decisions from the 2026-11-19 council. ADR-002, ADR-011 and the optional subpaths they describe were ratified in v0.12.0; the remaining ADRs are still proposals. "Existing behavior is unchanged" applies to the wire format and root exports, not to the optional subpaths added in v0.12.0. See [the standards matrix](STANDARDS_MATRIX.md).

## ADR-001 — Keep `agent:` identity canonical

- **Decision:** Keep the SHA-256 JWK thumbprint `agent:` identifier as canonical. Keep `did:key` as an additive alias.
- **Why:** Existing wallets, consent and tests depend on it; a self-certifying key verifies offline without a resolver.
- **Alternative rejected:** DID-native identity as the primary format.
- **Consequence:** Standardized credential adapters can be added without a migration.
- **Status:** Proposed; reflects current code.

## ADR-002 — Three first-class tool providers, one registry

- **Decision:** MCP, WebMCP and UTCP are first-class providers behind one source-aware registry and invocation API.
- **Why:** A single developer-facing surface is useful immediately; no new tool protocol is needed.
- **Alternative rejected:** Extending the MCP command only, or building a universal AI Auth tool protocol.
- **Consequence:** Each adapter must preserve native auth, errors and lifecycle.
- **Status:** Proposed.

## ADR-003 — Do not substitute AI Auth signatures for MCP OAuth

- **Decision:** When MCP's official HTTP authorization framework applies, pass OAuth 2.1 bearer tokens through untouched. AI Auth scopes govern local registration only.
- **Important nuance:** MCP authorization is optional at the base-spec level, and the base spec permits bilaterally negotiated custom auth. Such a scheme is legal MCP but is not standard MCP authorization and will not interoperate with conforming OAuth clients.
- **Alternative rejected:** Replacing OAuth bearer tokens with signed AI Auth envelopes.
- **Consequence:** The MCP adapter is an authorization consumer, not a credential issuer.
- **Status:** Proposed; aligns with the mission constraint.

## ADR-004 — WebMCP stays native and versioned

- **Decision:** Use `document.modelContext` where present. Keep a versioned compatibility adapter, never a competing browser tool API or a fake polyfill.
- **Why:** WebMCP is a W3C Community Group draft (13 Nov 2026), not a standard; browser support is experimental.
- **Consequence:** Feature detection, annotation mapping and lifecycle withdrawal are mandatory.
- **Status:** Proposed; current code already uses `document.modelContext`.

## ADR-005 — Reuse the official UTCP SDK, add a destination policy

- **Decision:** Depend on `@utcp/sdk` and call native endpoints directly. Add AI Auth checks for endpoint allowlist, DNS rebinding, credential isolation and cancellation.
- **Why:** The SDK already handles manual discovery, direct invocation and much SSRF hardening; rewriting it would add risk.
- **Alternative rejected:** A wrapper MCP server for UTCP tools.
- **Consequence:** UTCP-specific risks must be tested separately; no implicit trust from SDK provenance.
- **Status:** Proposed.

## ADR-006 — A2A and ACP are interoperability adapters, not tools

- **Decision:** A2A is agent-to-agent; Agent Client Protocol is editor-to-agent; the historical IBM/BeeAI ACP is archived and unsupported.
- **Why:** They solve different problems and have different data models.
- **Alternative rejected:** Recreating A2A task state or ACP session semantics inside AI Auth.
- **Consequence:** No implicit A2A-task-to-tool-call mapping.
- **Status:** Proposed.

## ADR-007 — Commerce and payments stay outside the core

- **Decision:** UCP and AP2 belong in a separate optional layer. `tools.invoke` and any generic grant can never authorize spending.
- **Why:** AP2 exists because agent payments require transaction-bound verifiable intent, not inferred action.
- **Alternative rejected:** A generic "payment" capability in the tool registry.
- **Consequence:** Payment tests must assert a negative: no generic path to a valid mandate.
- **Status:** Proposed; hard rule.

## ADR-008 — Defer UCAN and Biscuit

- **Decision:** Do not make UCAN or Biscuit the primary authorization format in this milestone.
- **Why:** UCAN mandates DIDs and has no confinement; Biscuit's own README asks for a design and crypto audit.
- **Alternative rejected:** Capability-native architecture.
- **Consequence:** Delegation experiments live in a separate package and are labelled experimental.
- **Status:** Proposed.

## ADR-009 — No breaking identity or wire migration without separate approval

- **Decision:** Additive changes only in this milestone, including the MCP 2026-07-28 revision migration.
- **Why:** The current wallet, SDK, wallet consent version and browser/harness integrations depend on the existing wire format.
- **Consequence:** Any migration needs its own compatibility decision, test plan and rollback.
- **Status:** Proposed.

## ADR-010 — Evidence governs claims

- **Decision:** A security or conformance claim is "verified" only when a named test file exists and passed CI. Otherwise label it unverified.
- **Why:** The repository already distinguishes evidence from claims (`docs/evidence.md`, `GENERIC_INTEGRATION_REVIEW.md`).
- **Consequence:** No marketing or design document may claim MCP OAuth conformance, UTCP security or payment safety without a test.
- **Status:** Proposed; aligns with the project copywriting skill.

## ADR-011 — Code Mode is an execution interface, not a fourth protocol

- **Decision:** Keep the existing optional `--code-mode` / `ai_auth_code` path. Code Mode is an optional orchestration interface above MCP, WebMCP and UTCP, never a fourth tool protocol and never an identity or authorization source.
- **Why:** `packages/mcp/bridge.js` and `packages/mcp/code-mode-worker.js` already implement it behind a flag; direct tools stay registered. PR #14 independently reached the same conclusion. Cloudflare and Pi are references for progressive discovery and per-call approval, not infrastructure requirements.
- **Constraint:** The Node `vm` plus Worker design is not a hard isolation boundary. Expanding Code Mode to more providers requires host-side per-call authorization, resource bounds, truthful partial-side-effect reporting, and an independent sandbox red team first.
- **Status:** Proposed. See `docs/CODE_MODE_COMPARISON.md` and `docs/INTEROPERABILITY_CODE_MODE_RFC.md` for the evidence and gates.

## Rejected alternatives

| Alternative                           | Reason                                                      |
| ------------------------------------- | ----------------------------------------------------------- |
| New AI Auth tool protocol             | Mission explicitly forbids competing protocols              |
| Hosted registry or resolver           | Contradicts no-server self-custody                          |
| DID-native primary identity           | Migration risk; offline resolution dependency               |
| UCAN/Biscuit primary authorization    | Community spec / audit outstanding, no confinement          |
| Wrapper MCP servers for UTCP          | Unnecessary middleware; UTCP already calls native endpoints |
| Generic payment capability            | Violates the hard commerce boundary                         |
| Custom signature instead of MCP OAuth | Not conforming where the official framework applies         |

## Unresolved questions

1. Should the unified registry be exported from the root package or only subpaths? `docs/BOUNDARIES.md` pins the root export list (DTC-06).
2. Is the MCP 2026-07-28 revision migration worth its breaking cost for this project's users? No compatibility evidence yet.
3. Which external verifier actually requires VC or DID presentation? None identified.
4. Can UTCP cancellation be adequately emulated above the SDK, or must it remain unsupported?
5. Which A2A or ACP implementation is the interop target, and is there a test harness available?
6. Are there AP2 verifiers that accept an AI Auth identity claim today? Unverified.

## Amendment rule

Amend this file only with a new ADR or a superseding ADR that names the one it replaces. Do not silently rewrite a decision.
