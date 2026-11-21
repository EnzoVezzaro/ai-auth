# Threat model

> Status: proposed threat model for the architecture in `REFERENCE_ARCHITECTURE.md`. As-is controls cite files at `v0.11.1`. "Control" rows marked proposed are not implemented. Every security claim must have test evidence or be labelled unverified.

## 1. Assets

| Asset               | As-is protection                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing private key | Non-extractable IndexedDB in browser; encrypted mode `0600` file keystore for headless agents (`docs/ARCHITECTURE.md`, `packages/agent/README.md`). |
| Consent and grants  | Signed, origin-bound, bounded lifetime, stored as public data (`packages/p2p/capabilities.js`, `grant-store.js`).                                   |
| Agent identity      | `agent:` thumbprint of public JWK; signature proves key control only (`packages/p2p/index.js`, `docs/SECURITY.md`).                                 |
| Tool catalogs       | Bounded, signed, 120 s expiry, 45 s refresh (`packages/p2p/webmcp.js`).                                                                             |
| Approval decisions  | Human `authorize` callback; `authorizeProtected` fails closed (`packages/p2p/webmcp.js`, `membership.js`).                                          |
| Audit metadata      | Bounded local logs: 256 `P2PRoom.audit` entries, 100 activity entries (`packages/p2p/p2p.js`, `index.js`).                                          |
| User data in a page | Page owns its data; WebMCP results marked untrusted; no secrets in room (`docs/SECURITY.md`).                                                       |

## 2. Attackers and entry points

| Attacker                               | Entry points                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Malicious peer in a room               | Signed events, chat, cursors, tool requests and results.                                   |
| Malicious or compromised tool provider | Tool name, description, schema, result payload, error text.                                |
| Malicious website                      | Connect request, capability list, WebMCP registration, tool annotations, iframe embedding. |
| Relay operator                         | Timing, participation and hashed room topic.                                               |
| Stolen credential holder               | MCP HTTP secret URL, UTCP provider token, wallet backup file.                              |
| Malicious dependency                   | npm updates in any package, especially adapters.                                           |
| Network attacker                       | DNS rebinding, redirect chains, private-network addressing, replayed requests.             |

## 3. Attacks, controls and evidence

| Attack                                     | As-is control                                                                                 | Proposed control                                                                                              | Evidence / status                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Forged identity claim                      | `verifyEnvelope` checks signature, issuer, audience, freshness                                | Keep; add standardized proof verification additively                                                          | `tests/did.test.mjs`, `tests/webmcp-contract.test.mjs`                         |
| Replayed request                           | Nonce, `createdAt`, 120 s freshness, signed session binding                                   | Keep; UTCP/MCP requests must be bound to the same context                                                     | `packages/p2p/index.js`; test needed for cross-provider replay                 |
| Unauthorized tool invocation               | `tools.invoke` plus owner/site approval; protected operations need membership and short grant | Registry-level capability match and deny-by-default policy before adapter call                                | `tests/webmcp-contract.test.mjs`, `packages/agent/test/tool-provider.test.mjs` |
| Stolen MCP URL credential                  | Path secret mode `0600`, loopback only                                                        | Keep; never treat the URL as an AI Auth grant                                                                 | `packages/mcp/http.js`; no authentication bypass test yet                      |
| Custom signature substituted for MCP OAuth | Not applicable to local-only adapter                                                          | Pass native OAuth through; never send AI Auth signatures as bearer tokens                                     | No test yet; conformance plan item                                             |
| Tool description prompt injection          | Descriptions advisory; untrusted content hints                                                | Description text never enters policy or instruction channel                                                   | `webmcp.js`; adversarial test required                                         |
| Malicious tool metadata                    | Name pattern, size caps, bounded catalog                                                      | Registry validates provenance and preserves native descriptor                                                 | `tests/tool-catalog-validation.test.mjs`, `tests/catalog-flood.test.mjs`       |
| Cross-origin WebMCP call                   | Native draft gates; `exposedTo`, `fromOrigins`, embedder `allow`                              | AI Auth records source origin; no emulation of browser privileges                                             | WebMCP draft §4.4; no cross-origin browser test yet                            |
| Tool invoked after page destruction        | Catalog expiry, presence checks, `CATALOG_EXPIRED`                                            | Immediate withdrawal on lifecycle signal where available                                                      | `tests/tool-expiry.test.mjs`, `agent-client-presence.test.mjs`                 |
| UTCP SSRF to private networks              | Optional adapter: HTTPS/literal-loopback rule, endpoint allowlist                             | Resolve-and-check plus redirect preflight above the SDK                                                        | `tests/utcp-adapter.test.mjs`; limitations in §4                               |
| DNS rebinding                              | Resolve before connect and re-check at call time                                             | Adapter rechecks DNS; SDK connection is not pinned                                                            | `tests/utcp-adapter.test.mjs`; residual gap in §4                               |
| Credential leakage across providers        | AI Auth grants are never provider credentials; adapter namespaces secrets                     | No secrets in audit or room                                                                                   | `tests/utcp-adapter.test.mjs`                                                  |
| Cross-provider data leakage                | Registry with source and protocol fields ships as an optional subpath                         | Registry enforces audience and source restrictions on every call                                              | `tests/tool-registry.test.mjs`, `tests/unified-tools.test.mjs`                 |
| Privilege escalation via delegation        | Grants are subsets; renewal cannot add scopes; execution grants max 15 min                    | Never derive a broader native credential from a narrower grant                                                | `docs/SECURITY.md`, `membership.js`                                            |
| Revocation under partition                 | Gossip + bounded 7 day catch-up; epoch bumps                                                  | Keep; document eventual consistency honestly                                                                  | `tests/revocation.test.mjs`, `docs/limits.md`                                  |
| Protocol version downgrade                 | Freshness and consent version checks                                                          | Require explicit supported-version sets per adapter                                                           | `CHANGELOG.md` 0.5.0; adapter tests required                                   |
| Malicious dependency update                | Version ranges in manifests, resolved versions pinned by lockfiles                            | Review adapter dependencies, verify packed tarballs                                                           | `npm run verify:packages`, CI `npm audit`                                      |
| Financial action through generic tools     | Additive deny-by-default `./commerce-boundary` guard; no payment operations                   | Hard separation; `tools.invoke` cannot mint mandates                                                          | `tests/commerce-boundary.test.mjs`, `COMMERCE_PAYMENTS.md`                     |
| Confused deputy in MCP OAuth               | Not implemented locally                                                                       | Do not forward tokens not issued to this server; never proxy a client token upstream                          | MCP security best practices; test required                                     |

## 4. Residual risks

1. **No TURN.** A restrictive NAT can keep a peer in `waiting-for-peers`. Relays see timing and participation metadata. (`docs/limits.md`)
2. **Revocation is eventually consistent.** A peer offline beyond the catch-up window may not converge.
3. **Signature is not identity.** It proves control of a key, not a human or a trustworthy agent.
4. **Private mode is not anonymity.** Relays and direct peers still see metadata.
5. **UTCP cancellation and DNS rebinding** are not verified in the official SDK; an AI Auth-side wrapper is proposed.
6. **WebMCP is a moving draft.** Browser implementations are experimental; feature detection and versioned adapters are required.
7. **AP2 is pre-1.0** with a known signature-algorithm inconsistency (issue #268).
8. **MCP 2026-07-28 migration** is breaking and unplanned in this milestone; the current adapter targets an older revision.

### Implementation note (2026-11-19)

The optional UTCP adapter now enforces HTTPS/literal-loopback rules, private and link-local blocking, endpoint allowlists, a redirect preflight, credential namespace isolation and a resolve-and-re-check. Two limitations remain and must not be claimed as solved: the redirect check is a separate GET probe, not control of the official SDK transport, and the DNS check does not pin the SDK's connection (no resolver hook is exposed). Code Mode is not yet routed through the UTCP adapter.

## 5. Sign-off rule

A security-sensitive change is complete only when an independent reviewer who did not author it has checked the tests and the Security Supervisor has recorded a decision. An unverified claim must be labelled as such in the code, doc or release note that carries it.
