# AI Auth — Director: Identity Connection UX Rewrite

**Status: implement this audit, not a proposal to start another research loop.**  
**Source of truth:** `docs/AGENT_IDENTITY_UX_AUDIT_2026_11_20.md`.  
**Domain:** AI Auth itself. Do not make this feature a Body4AI application, rebrand wallet identity as a human account, or introduce a hosted custodian.

## /goal

Turn AI Auth into the simplest reliable way to **attach an identity to an AI agent, cryptographically prove that the running agent controls that identity, authorize it for a site, and display an accurate live connection status**. Remove setup complexity from the default experience without removing security controls. Your output must be working code, not another documentation-only PR.

## Critical guardrails

1. **Never call an agent Connected on key creation, import, saved grant, discovery, room registration, message from a different peer, endpoint reachability or wallet consent alone.** It requires a live authenticated transport for the **expected agent wallet and instance**, with current session/generation and authorization.
2. **Never label requested/default capabilities as approved.** Only display verified effective scopes for the intended site/session.
3. **Do not rewrite cryptography or replace existing standards out of convenience.** Reuse signed instance bindings and descriptors, nonce verifier, session and connection state. Preserve transport boundaries and existing MCP/WebMCP/UTCP adapters.
4. **Do not broaden access or do silent irreversible actions.** Never auto-approve tools, reset a keystore, overwrite a key, upload recovery material, export secrets or enable public presence without explicit permission.
5. **Do not promise generic one-click browser installation.** Use a trusted, permissioned local adapter where one exists; otherwise supply one clear manual path.
6. **Do not assert model/vendor or physical-device authenticity from a wallet signature.** Prove active control of the signing key and its expected instance/session only; runtime metadata is a claim.
7. **Respect honest architectural limitations:** no mandatory AI Auth server, no TURN guarantee, no automatic browser reconnection on refresh unless implemented with user approval and verified, and no claims of compatibility before testing.
8. **Do not merge partial P0 UI fixes** that preserve a false success state. If a secure pairing path is not ready, show Pending/Not verified instead.

## Council / worker allocation

- **Director (you):** owns user contract, prioritization, cross-worker interfaces, PR integration, regression gate and decision log.
- **Identity & Security worker:** P0-01, P0-02, P0-06: signed pairing challenge, expected wallet + instance, exact origin/room, anti-replay, effective scopes, negative tests and threat model.
- **Connection & Runtime worker:** P0-03, P0-04, P0-05: lifecycle correctness, clean keystore bootstrap, local adapter/P2P/MCP and deployment/discovery behavior.
- **Product UX worker:** P1-07 through P1-12, P1-14: IA, plain copy, flow, approval sheet, status/proof card, advanced disclosure, key recovery and grant management; wireframes → components.
- **Interoperability worker:** P1-13: support matrix and adapter contract for harnesses; no guessed support.
- **QA & Accessibility worker:** test fixture, browser automation, 320px mobile, keyboard, focus, screen reader smoke, screenshot artifacts, scope security and a real integration session.
- **Docs/Release worker:** P1-15 and P2: scope lifetime design decision, version consistency, docs, changelog, migration instructions and compatibility evidence.

Use multiple workers when tools allow. Every worker must reference concrete source files and return a diff, tests, risks and evidence. Avoid competing edits to the same file.

## Branch / PR sequence (separate if needed)

### 0. Repro + failing regression tests

- Capture actual current screens and log behavior without keys/secrets.
- Create minimal negative tests for P0-01 through P0-06 **before** making them pass.
- Establish baseline of existing `npm run test:all`, `npm run build`, `npm run test:connect-agent` and screenshot/real-network suites, distinguishing tested vs blocked.

### 1. Identity proof and truthful state (blocker)

- Introduce a typed pairing coordinator or equivalent with expected identity and instance; verifier-issued, single-use nonce and signed proof; exact origin/room/session scope.
- Use existing `verifyAgentDescriptor` and `verifyInstanceBinding` rather than ad hoc comparisons of event labels.
- Join verified local installation and remote proof without conflating them.
- Update `apps/connect-agent/app.js` to ignore unsolicited unrelated peers, derive UI from genuine lifecycle transitions and show only verified grant scopes.
- Add negative tests: wrong peer, wrong key, wrong instance, replay, expiry, revoked, dropped channel, stale generation, unknown scopes.

### 2. Working bootstrapping (blocker)

- Make browser identity creation → target agent installation → proof verification a **single, documented, reproducible path**.
- The page's current `--connect` command cannot consume the generated installation package as-is. Solve through explicit importer/provisioner or replace it with a path that actually initializes the MCP keystore with user approval.
- Fix GitHub Pages subpath discovery and the URL/text instruction mismatch. No query string or public page URL should act like private credential.
- Preserve an explicit escape hatch for unsupported clients.
- Prove a clean local harness setup, no-keystore recovery and existing-keystore reuse.

### 3. Human-centered UI

- One default CTA: **Connect an agent**.
- Three visible chapters: **Choose → Approve/Install → Verify & Connect**.
- Status card distinguishes **Identity verified**, **Access approved** and **Connected now**, with no green badge for unrelated peers.
- Restore/back up securely via contextual flow; raw install JSON and MCP config live under Advanced.
- Owner approval sheet is contextual; `Overview / Owner identity / Site requests / Grants / Shared room / Activity` is not the normal start path.
- Connect/reconnect/disconnect/revoke should work and explain immediate vs eventually propagated effects.

### 4. Platform coverage and release

- Harness matrix with tested versions and clear unsupported/blocked categories.
- CI regression coverage + real browser/transport verification and sanitized screenshots.
- Review security/performance/accessibility, update API/copy/docs and version labels.
- Merge only when the definition of done in the audit is met; otherwise leave changes as a draft and report precise blockers.

## Expected user-visible demo

With a supported, authorized local agent adapter:

1. User presses **Connect an agent**, chooses a target agent and reuses or creates an identity.
2. Agent installation happens with explicit local permission, not a raw JSON copy.
3. Target runtime signs a fresh challenge; the user sees **Identity verified** only for that expected wallet and instance.
4. Owner allows a scoped site connection and chooses a duration; UI uses **effective** capabilities, not defaults.
5. A real authenticated data channel opens; user sees **Connected now** and can run a safe **Test connection**.
6. Agent process stops; UI immediately reports **Agent offline**, preserving historical identity verification without asserting presence.
7. User reconnects using the same identity or revokes access. A different agent can never hijack the displayed success state.

Browser-only/unsupported clients get accurate steps and an explicit proof verification action, not a fake one-click promise.

## Definition of evidence for each change

Every implementation PR must include:

- The findings addressed by ID from the audit and files changed.
- Before/after UX screenshots (desktop, mobile, key failure states) without sensitive data.
- Exact test commands and PASS/FAIL/BLOCKED results.
- At least one real signed remote proof and real live peer connection for the success path; mocks may cover negative deterministic cases.
- Security review of consent, origin, nonce/replay, instance, key storage, link contents and revocation.
- Clear supported-vs-unsupported harness table and migration notes.

**Director completion message:** report what shipped, what is merely designed, what is unsupported and which high-risk issues remain. Do not report completion based on a pretty screen, signed receipt without a live peer, or green test names alone.

## Existing implementation references

- `apps/connect-agent/` — primary onboarding surface and current false-positive success paths.
- `apps/p2p/` — owner wallet and signed permission UX.
- `packages/p2p/agent-identity.js` and `connection-state.js` — proof and lifecycle primitives.
- `packages/agent/install.js` — encrypted installation format, distinct from the MCP keystore bootstrap path.
- `packages/mcp/connect-input.js`, `cli.js`, `approval.js` — discovery, bootstrap and local owner approval.
- `docs/CONNECT_AGENT_E2E_ACCEPTANCE.md` — complementary generic cross-agent E2E specification; extend it, do not replace it.
- `docs/IDENTITY_STANDARDS_RFC.md` and `docs/INTEROPERABILITY_CODE_MODE_RFC.md` — future interoperability context; do not merge incompatible changes opportunistically.
- `docs/lifecycle.md` and `docs/DISCOVERY.md` — hard constraints on truthfulness and hosting.

**Do not create more RFCs in place of code. Build small tested PRs toward the above demo.**