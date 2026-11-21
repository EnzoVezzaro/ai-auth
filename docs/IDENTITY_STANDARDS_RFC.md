# RFC: Standards-based identity and authorization for AI Auth

**Status:** Proposed for independent agent review — **no implementation approved by this document**  
**Reviewed:** 2026-11-18  
**Scope:** AI Auth SDK, headless runtime, wallet, signed protocol, delegated permissions, discovery  
**Principle:** Preserve self-custody, zero AI Auth-operated identity servers, user approval, and interoperable verification.

> **Verified findings:** an independent Phase 0 review of this RFC is at [IDENTITY_STANDARDS_REVIEW.md](IDENTITY_STANDARDS_REVIEW.md). It confirms RFC 7638/JCS parity and records which library-level claims remain unverified. Where the two disagree, the review's evidence takes precedence.

> This RFC is a research and implementation handoff, not a claim of completed interoperability or a mandate to rewrite the existing protocol. A second agent MUST verify the linked specifications and the repository's current code before choosing dependencies or shipping a migration.

## Executive decision

AI Auth has a real product-level contribution: portable agent identities that can join a website's room, show presence, exchange signed events, and invoke site-authorized tools through MCP/WebMCP with human consent. The project should **keep those experiences**. It should **avoid expanding private identity and authorization standards** when reusable standards and libraries cover the same foundations.

Recommended sequence:

1. **P0 — identity compatibility spike:** Preserve existing P-256 keys and `agent:` identifiers; derive standardized `did:key` aliases, and independently test resolution and signing with existing keys. Consider `did:jwk` as an alternate format.
2. **P1 — standard signing interoperability:** Test RFC 7638 thumbprint compatibility, JCS (RFC 8785), and ES256 JWS using `jose`; introduce separate interoperable signed artifacts rather than replacing room events wholesale.
3. **P2 — authorization bake-off:** Prototype **UCAN vs Eclipse Biscuit**, not both in production. Test real recipient binding, attenuation, local verification, revocation and actual P-256 support in selected libraries.
4. **P3 — selective adoption:** Choose a single authorization approach only if it beats existing grants on interoperability, maintenance burden and enforceable safety semantics.
5. **P4 — optional external attestations and discovery:** Evaluate W3C Verifiable Credentials 2.0 and signed A2A Agent Cards if concrete consumers need them. Avoid bundling heavyweight identity frameworks by default.

Do not merge changes that invalidate an existing wallet, signed session, site scope, peer envelope, or encrypted recovery file. Do not change user approval rules merely to simplify a protocol adaptation.

## 1. Current implementation: code-grounded inventory

Reviewed on `main` as of 2026-11-18. Confirm before implementation since this repo is actively changing.

| Concern            | AI Auth implementation                                                                                      | Evidence                                                                          | Likely reuse                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Key identity       | P-256 JWK, `agent:` + base64url SHA-256 of canonical public JWK members                                     | `packages/p2p/index.js` (`identityFor`)                                           | RFC 7638 thumbprints; `did:key` or `did:jwk` aliases                             |
| Browser custody    | Browser Web Crypto private key stored non-extractably in origin-scoped IndexedDB; separate encrypted backup | `packages/p2p/index.js`, `docs/RECOVERY.md`                                       | **Keep**; optional standard key formats without changing custody                 |
| Headless custody   | Encrypted file, mode 0600; AES-GCM, PBKDF2, P-256                                                           | `packages/agent/keystore.js`                                                      | **Keep**; adapter interfaces only                                                |
| Signed traffic     | Custom typed `SignedEnvelope`, P-256/SHA-256, canonical JSON, timestamps/nonces                             | `docs/protocol.md`, `packages/p2p/index.js`                                       | Test JWS interoperability for new external objects                               |
| Agent descriptor   | Signed, nonce-bound, origin/room-bound agent metadata; model/provider claims not attested                   | `packages/p2p/agent-identity.js`                                                  | DID + verifiable presentation/claim formats where useful                         |
| Capability grants  | Custom signed recipient/resource/capability/expiry proofs                                                   | `packages/p2p/capabilities.js`                                                    | UCAN or Biscuit evaluation                                                       |
| Room authorization | Custom membership, execution grants, issuer rules and site policy                                           | `packages/p2p/membership.js`                                                      | Reusable authorization tokens; **retain site policy and explicit tool approval** |
| Revocation         | Signed records, gossip, epoch invalidation, bounded catch-up                                                | `packages/p2p/revocation.js`, `docs/SECURITY.md`                                  | Keep transport; improve separation of freshness requirements                     |
| Discovery          | Strict unsigned `/.well-known/ai-auth.json` hint                                                            | `packages/p2p/discovery.js`, `docs/DISCOVERY.md`                                  | Optional A2A card adapter; never treat hints as trust                            |
| Transport          | Nostr relays for signaling; WebRTC data channels for signed peer traffic                                    | `packages/p2p/p2p.js`, `docs/ARCHITECTURE.md`                                     | **Keep**; orthogonal to identity                                                 |
| Integration        | Website SDK, WebMCP, local MCP server and runtime                                                           | `packages/p2p/webmcp.js`, `packages/mcp/`, `packages/runtime/`, `packages/agent/` | **Keep**; primary product differentiator                                         |

**Important distinction:** AI Auth is **serverless for identity custody/verification**, not independent of all infrastructure. Public Nostr relays and STUN help peers find a direct WebRTC path; no TURN fallback exists. A connected website still controls its own resources. None of these facts imply a central AI Auth identity registry.

### Notable existing protocol contracts

- Signed room envelopes have issuer, type, nonce, origin, room and expiry checks; changing the serialized signed bytes or identifier meaning breaks compatibility.
- Membership, short-lived execution grants and explicit site approval are separate security decisions. A verified signature alone must never authorize a tool.
- Browser recovery can recreate the existing key; key rotation currently changes identity and forces re-trust.
- There is no global instantaneous revocation; gossip only affects peers that have applied relevant records.
- `provider`, `model` and runtime claims in descriptors are self-declared, **not attestation of the actual model or owner**.
- SDK must remain site-neutral: `docs/BOUNDARIES.md` forbids embedding a particular site's identity, branding, room rules or data in package source.

## 2. Main finding: the fingerprint is close to an existing standard

`identityFor(publicKey)` reads exactly public EC JWK members `crv`, `kty`, `x`, `y`, sorts them via the canonicalizer, hashes their UTF-8 JSON serialization with SHA-256, and encodes the digest as base64url with a private `agent:` prefix.

This strongly resembles **RFC 7638 (JWK Thumbprint)**. For standard public EC JWKs, those four required member names and serialization rules produce the same digest. This equivalence has been independently confirmed for valid P-256 JWKs by four test vectors in [the identity standards review](IDENTITY_STANDARDS_REVIEW.md); the prefix itself is not a DID and a key-derived DID will use different bytes. The current `canonicalize` is a project implementation that should also be tested against independent RFC 8785/JCS fixtures rather than assumed fully compliant.

**Migration consequence:** Existing keys can be reused. Preserve `agent:<old-digest>` as a stable legacy alias in persisted sessions and verification while deriving standards-based aliases from the same key. **Do not** replace the stored ID string with a DID or assume that `did:key` embeds the RFC 7638 thumbprint. Resolve aliases to the same verified key and refuse ambiguous mappings.

Sources:

- RFC 7638: https://www.rfc-editor.org/rfc/rfc7638.html
- RFC 8785: https://www.rfc-editor.org/rfc/rfc8785.html
- W3C DID Core 1.0 (Recommendation): https://www.w3.org/TR/did-core/

## 3. Standards and implementation shortlist

This table distinguishes **standard** from **implementation**. A method that conforms to W3C DID syntax is not itself a W3C Recommendation, and project README claims are not interoperability evidence.

| Option                             | What it solves                                                             | Offline/self-custody fit                                                           | Tradeoffs / recommendation                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W3C DID Core + did:key**         | Portable identifier and publicly resolvable verification key               | **Excellent:** identifier encodes the public key; no registry                      | **Top identity spike.** `did:key` is a community method, not the DID Core standard itself; key-derived ID changes on rotation                                       |
| **did:jwk**                        | Key-derived DID from a public JWK                                          | **Excellent:** deterministic and locally resolvable                                | Simpler mapping from current JWK; validate target interoperability/ecosystem rather than assume broad acceptance                                                    |
| **key-did-resolver**               | JavaScript `did:key` resolution                                            | **Excellent**; docs include secp256r1/P-256                                        | Resolver, **not key generator**: separately choose and test P-256 multikey encoding/derivation                                                                      |
| **jose**                           | JWK/JWS/JWT/ES256 standard primitives                                      | **Excellent** in browser and Node                                                  | **Adopt for interoperable artifacts**, not automatically for custom realtime room messages                                                                          |
| **UCAN spec + ucanto**             | Audience-bound, attenuated delegation proofs/invocations                   | **Strong at spec level**, offline verification possible with complete proof chain  | **Candidate A**; spec permits P-256; verify that exact `ucanto` signer/verifier APIs support importing _existing_ P-256 keys or can be adapted safely               |
| **Eclipse Biscuit + biscuit-wasm** | Offline-verifiable bearer authorization with offline attenuation and rules | **Strong**, but revocation requires external state                                 | **Candidate B**; current Biscuit spec supports **Ed25519 and ECDSA P-256**. Evaluate actual release/API, policy semantics and proof-of-possession for agent binding |
| **Credo (OpenWallet Foundation)**  | DID, credential exchange, agents and verifiable credentials                | Partial/lightweight possible, but broad framework                                  | Evaluate for credential lifecycle only if needed; not a default dependency for simple DID identity                                                                  |
| **Veramo**                         | Modular DID and verifiable-data SDK                                        | Depends on selected plugins/storage                                                | Alternative to Credo for future VC work; avoid adopting both                                                                                                        |
| **W3C VC Data Model 2.0**          | Third-party verifiable statements about an identity                        | Verification may be local with available issuer keys/proof data                    | Optional provenance layer, **not** proof of key ownership or authorization by itself                                                                                |
| **A2A signed Agent Cards**         | Standard way to publish an agent's advertised capabilities/interfaces      | Discovery usually has a hosted endpoint; signed card can be verified independently | Optional interoperability adapter; a signed card is **not a substitute** for trust bootstrap or tool consent                                                        |
| **OpenA2A AIM**                    | Agent identity/capabilities and audit, including TypeScript local mode     | Local SDK fits one machine; broader fleet IAM is server-backed                     | Reference/possible building block; not a drop-in replacement for P2P rooms and browser consent                                                                      |
| **Alien Agent ID**                 | Portable Ed25519 identity, vault, signed provenance                        | Local key is independent; optional human-binding uses external SSO                 | Competitor/reference; different key format and product scope                                                                                                        |
| **Agent Network Protocol (ANP)**   | Agent discovery, DID-based interaction, agent networking                   | Some modes (e.g. `did:wba`) depend on web hosting                                  | Reference for discovery; do not substitute its network semantics for current WebRTC without a concrete reason                                                       |
| **HelixID**                        | Agent identity and policy service                                          | Self-hostable does not mean service-free                                           | Consider an integration target, not core dependency                                                                                                                 |

Primary implementations and specs:

- did:key community spec: https://w3c-ccg.github.io/did-key-spec/
- did:key JS resolver: https://github.com/decentralized-identity/key-did-resolver
- did:jwk community spec: https://github.com/quartzjer/did-jwk/blob/main/spec.md
- JOSE library: https://github.com/panva/jose
- UCAN spec: https://github.com/ucan-wg/spec
- UCAN JavaScript implementation: https://github.com/storacha/ucanto
- Biscuit specification: https://doc.biscuitsec.org/reference/specifications
- Biscuit cryptography (P-256 as well as Ed25519): https://doc.biscuitsec.org/reference/cryptography.html
- Biscuit WASM: https://github.com/eclipse-biscuit/biscuit-wasm
- Credo: https://github.com/openwallet-foundation/credo-ts
- Veramo: https://github.com/decentralized-identity/veramo
- VC Data Model 2.0 (W3C Recommendation, 2025-05-15): https://www.w3.org/TR/vc-data-model-2.0/
- A2A Agent Card spec: https://a2a-protocol.org/latest/specification/agent-card/
- OpenA2A AIM: https://github.com/opena2a-org/agent-identity-management
- Alien Agent ID: https://github.com/alien-id/agent-id
- ANP: https://github.com/agent-network-protocol/AgentNetworkProtocol
- HelixID: https://github.com/helixid/helixid

**Evidence level:** public specs/readmes and source inspection, **not** an audited or benchmarked dependency proof. Recheck maintained versions, licenses and compatibility before adoption. Some spec links and libraries evolve independently.

## 4. Target separation of responsibilities

The product should expose independent concepts:

1. **Identity:** a self-custodied public key, an optional DID alias, and proof of possession of the private key.
2. **Authority:** owner/site-issued capability proofs for resource + action + audience + constraints + expiry, evaluated against local policy. An identity is never automatically authorized.
3. **Attestations:** optional signed statements by _trusted external issuers_ about ownership, organization, runtime provenance, etc. Self-declared model/provider strings are still untrusted.
4. **Connection:** Nostr discovery, WebRTC event exchange and MCP/WebMCP integration; this layer cannot become the identity authority.
5. **Human and site controls:** explicit owner consent, scope intersection, short-lived grants for sensitive operations, per-tool site authorization and audit metadata.

Illustrative, non-normative integration flow:

- Agent wallet derives `did:key` from its _existing_ P-256 key.
- Agent signs a challenge binding DID/key, nonce, exact origin, room, audience and expiration.
- Site verifies signature + trust policy; if capability proof is present, validates **the complete delegation chain** and site-owned resource policy. A capability proof is insufficient without authorization.
- The existing signed room transport carries messages once peer policy is satisfied.
- Any remote tool invocation still passes existing site-side authorization and, where required, human approval.

For compatibility, the internal API may return `{ legacyId, did, publicJwk }` **only after** verifying that aliases correspond to the same key. The concrete interface should be decided in an implementation PR, not dictated here.

## 5. UCAN versus Biscuit — required controlled bake-off

**Do not pick a production scheme solely on popularity or conceptual similarity.** Implement a small evaluation harness for identical scenarios.

| Dimension     | UCAN                                                                      | Biscuit                                                 | Required AI Auth question                                                |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| Delegation    | Signed proof chains, explicit audience/issuer and attenuated capabilities | Bearer token with signed blocks and offline attenuation | How is the **actual presenter** bound to the intended agent?             |
| Root of trust | Resource owner / delegated issuer key                                     | Issuer root public key and local authorizer             | Who can issue membership for this exact origin/resource?                 |
| Crypto        | Spec lists Ed25519, P-256, secp256k1; JS support must be tested           | Spec supports Ed25519 **and P-256**, default may vary   | Can existing **non-extractable browser** P-256 key sign?                 |
| Policy        | Resource and ability attenuation + application semantics                  | Policy engine / logic rules                             | Can `tools.invoke`, room membership and per-tool approval stay separate? |
| Verification  | Local if all proof data and trusted keys available                        | Local if token, trusted keys and policy available       | Offline verifier test with **zero network**                              |
| Revocation    | Application-defined/freshness constraints, depending on profile           | External state; optional expiry/revocation IDs          | How to deny stale or revoked authority while offline?                    |
| Distribution  | Signed delegation material distributed to audience                        | Bearer possession is sufficient absent extra binding    | Replay, forwarding, stolen tokens, audience replay, scope escalation     |
| Integration   | Potential `ucanto` principal adapter work                                 | Browser WASM footprint and issuer-key adapter work      | Bundle size, startup, Node 22, browser compatibility                     |
| Maturity      | UCAN working group spec, JS implementation                                | Eclipse project, multi-language libraries               | Package maintenance, audits, license and API stability                   |

**Security requirement:** Capability proofs and peer identity must be **strongly linked**. If a Biscuit bearer token is accepted from any peer, a stolen/forwarded token may be exercised by a different identity despite valid P-256 room signatures. Never treat signed transport alone as audience binding. UCAN invocation proof validation also must verify signer and audience, not only delegation syntax.

**Fair correction to an earlier comparison:** Biscuit **does** document ECDSA P-256 support; do not reject it because older documentation or examples focus on Ed25519. Confirm that the selected JavaScript/WASM release exposes the exact functionality before recommending a migration.

**Selection gates** (must all pass):

- same existing key with no export of private material from browser wallet;
- local verification of identity and authorization with no third-party service;
- proof never increases granted scopes, crosses origin/room unexpectedly, or authorizes itself;
- test pass for recipient-bound invocation, replay prevention, expiry and issuer authority;
- existing site-side per-tool human approval preserved;
- operationally bounded revocation freshness, measured token sizes and latency;
- available documentation, compatible license, repeatable independent test vectors.

If neither candidate passes: **retain custom grants temporarily** and pursue only DID/JWS interoperability. No forced rewrite.

## 6. What must remain deliberately custom

Keep until compelling interoperability evidence appears:

- Browser wallet UI, passphrase/backup UX, custody choices and local headless keystore.
- Site integration APIs, permission prompts, session state transitions and resume semantics.
- Real-time P2P presence, cursors, targeted messages, delivery receipts and transport diagnostics.
- MCP/WebMCP bridge and site-local authorization callbacks.
- Nostr signaling/WebRTC data channels (transport and identity are separate decisions).
- AI Auth discovery as an **unsigned hint**; optionally expose a separate A2A-compatible card.
- Domain-specific room rules and explicit human approval, which generic authorization token formats cannot supply.

Do not adopt OAuth servers, a blockchain, a hosted DID registry, or mandatory biometric identity. None is needed to prove possession of an existing P-256 key.

## 7. Security, recovery and failure semantics

1. **Signer != owner != trusted runtime.** A valid key signature proves key possession. Verified ownership/organization requires issuer trust, not a self-signed provider/model claim.
2. **Legacy identifier compatibility.** `agent:` is not globally meaningful as a DID. Preserve old ID exact bytes and signed-message verification; do not rewrite old records to a DID string.
3. **Algorithm confusion and canonicalization.** Require explicit ES256, strict public JWK curve/fields and exact origin/room/audience/nonce checks. Compare JWS and legacy signature encodings with known-good vectors. Never accept tokens with unexpected algorithms or untrusted `jku`/issuer-supplied key URLs.
4. **Key rotation.** `did:key` and `did:jwk` identify the key, not a rotation-stable principal. A new key creates a new DID; only a verified key-rotation link under site policy can establish continuity. Never silently transfer all permissions.
5. **Revocation freshness.** No offline verifier can know an unseen revocation. A privileged offline action must fail closed when its required freshness proof is unavailable, or rely on sufficiently short expiry under an explicit risk policy. Keep room epoch and gossip handling distinct from token signature validity.
6. **Trust on first use.** A resolved DID is not an established trust relationship. The site must determine issuer trust and acceptable owner bindings. A signed A2A card is similarly not a substitute for trusted key discovery.
7. **Cross-origin/replay.** Include exact intended origin and audience in every handshake; use bounded, single-use nonces and expiry. Do not implicitly extend grants between websites or rooms.
8. **Secrets and custody.** Never export a browser's non-extractable signing key as part of a normal invocation. Migration must not log JWK private fields, recovery passphrases, encrypted files, access tokens or private page contents.
9. **Offline privacy.** DIDs and stable public keys can correlate an agent across sites. Consider pairwise identities where privacy requirements demand it, at the cost of portability. Document metadata visible to relay operators.
10. **UI and approvals.** Standard signed tokens do not justify bypassing the existing site authorization callback. Explicit human approval is a product security requirement independent of proof format.

## 8. Implementation plan for another agent (small PRs, review gates)

### Phase 0 — reproduce and document baseline (research PR)

Files to inspect: `packages/p2p/index.js`, `packages/p2p/agent-identity.js`, `packages/p2p/capabilities.js`, `packages/p2p/membership.js`, `packages/p2p/revocation.js`, `packages/p2p/codec.js`, `packages/agent/keystore.js`, `docs/protocol.md`, `docs/BOUNDARIES.md`.

- [ ] Record exact current exports, package versions and supported curves.
- [ ] Capture a valid legacy P-256 wallet's **public** JWK and `agent:` ID as a deterministic fixture. No private user keys.
- [ ] Independently verify the RFC 7638 thumbprint matches `identityFor()` for that fixture and several generated P-256 keys.
- [ ] Run baseline `npm run test:all`, `npm run test:types`, `npm run build` and `npm run verify:packages`; record results, not implied success.
- [ ] Record browser/headless recovery, signing and room event behavior before migrating.
- [ ] Review licensing, release cadence, transitive dependencies, security advisories and browser bundle costs of candidate libraries.

**Exit:** Baseline evidence and a written decision record; no protocol changes.

### Phase 1 — DID identity adapter (separate code PR)

- [ ] Build a self-contained `did:key` derivation/resolution adapter from the existing public P-256 JWK, backed by a maintained package where possible. Test compressed-SEC1-to-multicodec correctness using independent vectors.
- [ ] Ensure the same existing signing private key is used; browser key stays non-extractable.
- [ ] Expose **additive** public identifier(s) without mutating the canonical legacy `agent:` ID, stored sessions or proof fields.
- [ ] Resolve DID back to the exact original public key; refuse mismatched alias-to-key claims.
- [ ] Verify the DID with an implementation **outside AI Auth** and without network access.
- [ ] Add types, unit tests and documentation; keep the public API generic and site-neutral.
- [ ] Decide whether optional `did:jwk` is worth supporting; document which identifier is the primary exported alias.

**Exit:** Other software can identify the same key locally. Old peers and sessions still work.

### Phase 2 — JWS adapter (separate code PR; opt-in)

- [ ] Benchmark `jose` ES256/JWS on browser and Node 22 using existing P-256 keys.
- [ ] Define one **new externally interoperable artifact** (e.g. agent descriptor or a challenge response), with `iss`/key reference, audience, origin, room, nonce and expiry.
- [ ] Apply explicit algorithm allowlist and independent verification; no unauthenticated remote key fetch.
- [ ] Verify exact signature encoding and canonicalized payload treatment; do not confuse JSON canonicalization with what standard JWS signs by default.
- [ ] Retain every existing v1 `SignedEnvelope` reader/writer during migration; avoid an ambient downgrade to an unsigned or less constrained format.

**Exit:** Independent verifier accepts new signed artifact; old room traffic is unchanged.

### Phase 3 — authorization proof spike (benchmarks, no deployment)

- [ ] Implement UCAN and Biscuit adapters **in test fixtures only**, for the same issuer, recipient, resource, scope and expiration.
- [ ] Confirm actual P-256 signing/verifying library support and **non-extractable** Web Crypto integration.
- [ ] Test delegated agent A to B with narrower scope, then a denied attempt to widen scope.
- [ ] Test stolen/forwarded proof from C, wrong site, wrong room, replay, expired proof and revoked issuer.
- [ ] Test unrelated site rules and mandatory human approval still deny calls even with valid proof.
- [ ] Verify offline behavior, proof size, worker/browser bundle size, speed and failure diagnostics.
- [ ] Publish a short ADR selecting UCAN, Biscuit, or **neither** with measured data. Do not add both dependencies to the shipped SDK.

**Exit:** Architecture decision based on reproducible code/tests, not a guess.

### Phase 4 — gated authorization migration (only if Phase 3 passes)

- [ ] Introduce explicit proof versions and an adapter boundary; retain legacy validation for previously approved, bounded-lifetime grants.
- [ ] Separate issuer trust, cryptographic proof verification, revocation freshness, site policy and human approval into independently testable stages.
- [ ] Migrate capability and membership logic incrementally, without widening permissions.
- [ ] Keep short-lived execution grants and epoch behavior until independently equivalent guarantees are demonstrated.
- [ ] Add negative and cross-version tests; document rollback and cutoff policy.

**Exit:** No additional authority under new proofs, no lost existing consent records, and clear interop gain.

### Phase 5 — optional credentials, A2A and privacy (not blocking)

- [ ] Identify a concrete consumer needing owner/organization assertions, rather than shipping generic attestation features by default.
- [ ] Choose **one** VC library (Veramo or Credo, if needed), with trusted issuer rules; avoid interpreting a credential as an action grant.
- [ ] Offer a compatible signed A2A Agent Card separately from unsigned AI Auth site hints; validate signature and trust policy.
- [ ] Evaluate pairwise DIDs, rotating app-facing identifiers and correlation disclosures.
- [ ] Add end-to-end example with an **independent verifier** and offline key proof.

**Exit:** Feature driven by interoperability use case, not feature parity.

## 9. Acceptance criteria and negative tests

A new standards adapter is not complete until:

- [ ] **Interoperability:** independent third-party tooling resolves the DID and verifies a test signature without AI Auth-specific code.
- [ ] **Offline identity:** cold-start local verification succeeds with networking disabled and a previously known public key/trust anchor.
- [ ] **Backward compatibility:** legacy `agent:` ID, stored sessions, old peer events, key backups and headless keystore continue working.
- [ ] **Scope safety:** no proof crosses origins/resources/rooms, exceeds an approved subset, or turns a membership into tool authorization.
- [ ] **Replay safety:** nonce reuse, audience mismatch, expired signatures and incorrect algorithms fail closed.
- [ ] **Delegation safety:** recipient mismatch and attempted privilege expansion fail.
- [ ] **Revocation safety:** online gossip and offline freshness rules are explicit and tested.
- [ ] **Tool approval:** existing per-call site authorization remains required, including via MCP and WebMCP.
- [ ] **No new identity service:** no AI Auth hosted identity/authorization control plane or mandatory public registry is introduced.
- [ ] **Browser and headless:** verified in browsers, Node 22 and the packaged clean-install tests. Existing build and E2E flows still work.
- [ ] **Site neutrality:** no Body4AI-specific policy, branding or catalog logic appears in shared package source.
- [ ] **Docs and migration:** versioned wire changes, rollback plan, threats, package tradeoffs and exact compatibility guarantees documented.

Suggested baseline commands (actual E2E network tests depend on relay/ICE reachability):

    npm run test:all
    npm run test:types
    npm run build
    npm run verify:packages
    npm run test:browser:e2e

## 10. Open decisions for reviewer / implementing agent

1. Should the first public DID alias be `did:key` or `did:jwk`? Which one is supported by independent consumers while preserving an existing P-256 signing key?
2. Is the existing `identityFor` byte-for-byte an RFC 7638 SHA-256 thumbprint for all valid P-256 JWKs, or only for the tested subset?
3. Are UCAN and Biscuit both practical with current browser **non-extractable** P-256 keys? What extra binding is needed to prevent stolen-token use?
4. Is there any concrete interoperability problem that requires replacing the real-time message envelope now? If not, leave it untouched.
5. What is the accepted revocation/freshness failure mode for disconnected peers and sensitive operations?
6. How will key rotation and wallet recovery preserve continuity without silently migrating trust?
7. How will app-facing stable identity balance portability versus cross-site tracking risk?
8. Is a universal A2A card necessary when the current discovery manifest is an unsigned site connection hint?
9. Which dependencies meet project license, browser startup, bundle size and maintenance constraints?
10. What minimal implementation PR provides the strongest _independently demonstrated_ interoperability improvement?

## 11. Agent handoff instructions

**First task for an implementing agent:**

> Audit this RFC against the current `main` branch and primary linked specifications. Correct mistaken claims in a separate review commit/comment; do not trust the recommendations blindly. Produce a short decision record and tackle **Phase 0 + Phase 1** in the smallest independently testable PR. Preserve existing key material, consent boundaries, public exports, v1 wire formats and no-server custody. Never merge an authorization rewrite without a UCAN-vs-Biscuit proof-of-concept and failing/negative security tests.

**Out of scope for this documentation PR:** changing dependency manifests; altering the wallet or identity format; changing any consent, transport, membership, revocation or MCP behavior; shipping a new authorization token; merging code or removing legacy APIs.

### Source of truth and evidence priority

1. Actual AI Auth implementation and tests at the commit under review.
2. Published normative standards (W3C Recommendations, RFCs) and exact versions of relevant DID method/community specs.
3. Actual source and integration tests for a candidate library/release.
4. README/vendor claims as leads **only**.

A library's public repository and conceptual suitability are not evidence that it passes AI Auth's cryptographic requirements. Record independent compatibility tests before final design selection.
