# AI Auth 0.4.0 — agent connection, linking, interaction and participation handoff

**Reviewed:** 2026-11-15. **Baseline:** `main` at `b51956a1125f18b09533c4fb77d7d8e28151c4cc`. **Target:** a reliable, genuinely usable agent-to-site and agent-to-agent collaboration product, with the floating interaction wheel. This is an audit and implementation handoff, **not a claim that the work below is complete**.

## Product invariants

1. AI Auth operates **no central identity, authorization, or collaboration server**. Static hosting, Web Crypto self-custody, optional local adapters, Nostr signaling and direct WebRTC remain the default.
2. A wallet signature proves possession of a key, **not** human identity, trustworthy behavior, site membership, or authorization to modify site-owned data.
3. Bind every consent, site link, peer event and tool call to the **exact origin**, intended wallet, session, room, capability, nonce, and expiration. Keep replay rejection and resource-specific site policy.
4. A room-topic hash is **public discovery metadata**, not an access-control token. Do not put bearer credentials, secrets, private page data, or session keys in copyable connect instructions or public collaboration events.
5. Keep the existing `@enzovezzaro/ai-auth-wallet` browser API stable where possible. Version any incompatible wire-format change explicitly; do not silently change signed protocol semantics.
6. Optional Clerk / existing-account integration is **site-owned**. It may provide an authorization adapter when a site chooses to operate a backend, but the base wallet and P2P SDK must work without it.
7. No TURN by default is a deliberate product constraint. Report direct-ICE failure accurately; do not imply that public Nostr relays carry application messages or guarantee reachability.

## Verified implementation surface versus actual release evidence

- **Identity, consent and grants:** `packages/p2p/index.js`, `connect.js`, `capabilities.js`, `tests/p2p-wallet.test.mjs`. Implemented and unit-covered.
- **Website modal and lifecycle:** `packages/p2p/embed.js`, `agent-connect.js`, `tests/agent-connect.test.mjs`. Signed-origin handshake; panel cleanup proposed in PR #2.
- **Copyable agent connection:** `agent-connect.js`, `examples/body4ai/`. Browser-side instruction/panel, not an installed agent or universal headless connector; capability grammar fix proposed in PR #3.
- **Public room and peers:** `packages/p2p/p2p.js`, `apps/p2p/app.js`, `tests/p2p-transport.test.mjs`. Local P2P coverage; restrictive NATs and cross-network paths remain unverified.
- **Interaction wheel:** `packages/p2p/collaboration-wheel.js`, `collaboration.js`, `scripts/test-browser-e2e.mjs`. Chat, element selection and synthetic media coverage; per-peer delivery not acknowledged.
- **Page WebMCP tools:** `packages/p2p/webmcp.js`, `tests/in-page-agent.test.mjs`. Local tool catalog, scope, approval, cancellation and response tests exist.
- **Local integrations:** `packages/runtime/`, `packages/mcp/`. Host-local APIs; no core hosted service.
- **Release:** `.github/workflows/ci.yml`, `pages.yml`, `release.yml`, `docs/IMPLEMENTATION_PLAN.md`. Tracker reports npm 0.4.0 and static Pages; main CI passed on reviewed SHA, not evidence of six participants.

The browser test uses two isolated wallets and a separate agent wallet in the current machine/network. It does **not** establish cross-NAT, mobile, interoperability with an installed external coding agent, six-participant scale, or persistence across browser restarts.

## P0 — finish the complete agent journey

### A. Separate handshake expiry from usable session lifetime

**Finding:** `createPermissionRequest` in `packages/p2p/connect.js` allows a 1–120 second challenge, and `approvePermissionRequest` uses `request.expiresAt` as the signed consent expiration. Thus a normal site connection lasts **at most two minutes from request creation**, less if the user spends time approving it.

**Work:** Design and version a distinct short-lived, single-use handshake challenge and an independently bounded, explicitly displayed session grant. Define caps (for example, policy-selected session durations), renewal/re-consent, idle timeout, disconnect and expiration behavior. Do not permit requests to arbitrarily extend grants or silently renew scopes. Change `connect.js`, `embed.js`, `apps/p2p/app.js`, public types, `WIRE_FORMAT.md`, `SECURITY.md`, and tests consistently.

**Acceptance:** A user can complete a realistic 15-minute collaboration with two agents without the connection expiring after two minutes. An expired or revoked session cannot publish/receive authorized actions or transfer content. Replays and stale challenges remain rejected. Session duration is visible and bounded. Add clock-controlled unit tests and browser E2E for renew and expire.

### B. Define real site/agent linking, including unlink

**Finding:** A public wallet identity and capability grants exist, but there is no documented, complete **persistent site-account-to-agent link lifecycle** with listing, unlinking, rotation and revocation. A browser consent is not a site-account binding.

**Work:** Specify a signed, origin-bound link challenge and proof with one-use nonce, wallet identity, site resource, capability scopes, creation/expiry and optional account subject. Keep local link records in the wallet; site-specific account mapping belongs to each site. Expose `requestLink`, `verifyLink`, `listLinks`, and `unlink` or equivalent versioned APIs with explicit storage boundaries. Do not claim global revocation without a shared revocation source: bounded grant expiry and live signed revocation events are honest serverless mechanisms. Keep identity recovery/rotation behavior explicit.

**Acceptance:** Link an agent to an example site, refresh/reopen, see the same site link, use only approved scopes, unlink it, and confirm it no longer authorizes new operations. A malicious origin, old nonce, changed site, forged wallet ID, expired proof, or reordered resource cannot create a valid link. An optional Clerk demo verifies site-account membership without requiring Clerk for core wallet functions.

### C. Make the copyable instruction a usable connection for real agents

**Finding:** `createAIAuthConnectInstruction` emits JavaScript to execute in an agent's browser page. That is helpful, but copying text into Codex, Claude Code, OpenCode or an agent framework does not by itself grant browser access or produce an established P2P session.

**Work:** Document and implement a supported workflow from a site connect button or URL/QR to an actual agent runtime. Start with a browser-hosted adapter and an opt-in local MCP/CLI adapter, reusing wallet approval rather than bypassing it. Provide a stable, public, nonsecret site manifest (if needed), exact-origin proof, capability preview, clear reconnect/unlink instructions, and an example integration demo with actual application hooks. A static URL can initiate discovery, **not** stand in for signed consent.

**Acceptance:** In a fresh browser profile, a human links an agent to a site using only documented steps; the agent appears as the correct verified identity on the site, receives a real P2P event, completes a human-approved WebMCP read-only action, can disconnect, and cannot act after disconnection. Test with at least one actual external agent harness, not a test-only browser mock.

### D. Distinguish consent, discovery, peer connectivity and delivery

**Finding:** `connectAIAuthModal` can report a signed wallet connection before any direct peer exists. `onRoomReady` signals a local room/session, not successful remote WebRTC pairing. `NostrWebRTC` tracks direct peer joins internally, but this status is not consistently exposed to the site connection panel and interaction wheel.

**Work:** Add a typed, observable connection state with explicit transitions: `approval-pending`, `wallet-authorized`, `signaling`, `waiting-for-peers`, `direct-peer-connected`, `degraded`, `expired`, and `disconnected` (names may change). Expose direct peer count, ICE/reachability diagnostics, per-peer presence and bounded retry. Keep the signed identity display independent from connectivity state. Never represent “submitted to transport” as “peer received”.

**Acceptance:** UI accurately shows zero peers and a network diagnostic on blocked-ICE tests, then becomes directly connected only after a data channel is actually established. Disconnect, expiry and network loss update the panel and wheel. Browser E2E asserts each transition without relying solely on text/log messages.

### E. Establish enforceable participation rules

**Finding:** Signed P2P envelopes prove an issuer key and a valid room/origin, but the hashed room topic is publicly discoverable. A signature alone cannot prove that a particular peer was **admitted by the site** or approved by the same person.

**Work:** Explicitly choose between an open public room and a site-authorized participant room. For restricted participation, require a locally verifiable, short-lived site-issued or host-issued membership proof / invitation with role, scopes, target room, expiry and issuer trust policy. Validate membership before exposing remote actions, lists and transfers. Preserve open public rooms as an opt-in mode with prominent disclosure. Define participant roles (human/agent display is a claim unless independently attested), join/leave, remove/block, and delegated capabilities.

**Acceptance:** A third uninvited wallet that knows the origin and room name cannot invoke a protected action or see restricted room content. Join/leave/reconnect preserves stable verified identity, prevents replay/cross-room privilege, and never treats a nickname as identity. Add adversarial transport tests and site-side policy tests.

## P0 — make the interaction wheel genuinely useful

Today `mountCollaborationWheel` can send text, selected element metadata, screenshots and recordings. Keep these working, but implement:

1. **Participation/recipients:** show connected peers with verified short fingerprints, online/offline state, and who will receive content. Clearly distinguish public broadcast from a targeted message, and enforce any target on the receiver.
2. **Feedback:** message states `composing`, `queued`, `sent-to-transport`, `received-by-peer` (only after a signed receipt), `failed`, and `expired`. Acknowledgment is not proof a human read the content. Retain bounded history and avoid invented delivery status.
3. **Privacy and intent:** preview selected element metadata and media before sending; explicitly warn that recipients can save public-room content. Block/redact sensitive inputs and editable/private regions by default. Keep the browser's explicit `getDisplayMedia` consent and media-size restrictions; never auto-capture in the background.
4. **Control and accessibility:** clear session/recipient status, disabled controls with explanations, keyboard and Escape handling, screen-reader roles, focus management, mobile-safe positioning, stop/cancel recording, and reconnect behavior. Do not let screen capture remain live after close.
5. **End-to-end tests:** two users and at least two agent peers send text, element selection, screenshot and recording; verify receipt, rejection, cancellation, no-peer state, oversized file, expired grant, network disconnect, cross-origin isolation, and wheel unmount cleanup. Keep synthetic capture in CI, then record a separate manual real-browser capture validation.

The wheel is an interaction entrypoint; it must not become an authorization bypass for WebMCP or the site.

## P1 — agent tools, adapters and integrations

- **WebMCP:** Preserve catalog bounds, per-action schema, owner approval, wallet/session-targeted cancellation, timeout and abort. Add a real example integration contract: required capabilities, tool discovery, read-only defaults, human confirmation, result visibility and failure handling. Test catalog update after reconnect, duplicate request IDs and mixed-permission peers.
- **MCP/CLI/harness adapter:** Publish a minimal agent connection example usable from Codex, Claude Code, OpenCode or another coding harness, without making AI Auth a centralized agent host. An agent must still obtain human-granted capabilities. Do not conflate local MCP stdio with cross-network P2P connectivity.
- **Optional account-backed adapter:** A documented `clerk` integration may map a signed wallet identity to the site's own authenticated user and permissions. Clerk, storage and server routes remain optional site dependencies and are not imported by the core bundle. Add contract tests with mocked site verification and a working opt-in example.
- **Plugin system:** Keep the `packages/runtime` slot versioning/host contract; publish small adapter interfaces rather than hard-coded provider dependencies. Add compatibility checks for browser bundle, ESM, npm subpaths, local runtime and MCP.
- **Release UX:** Provide a truthful status dashboard, connection traces safe to disclose, understandable NAT/relay errors, docs for recovery, and a minimal quickstart from fresh install to peer event.

## Verification matrix / definition of done

- **Unit:** signatures, canonicalization, challenge/session separation, capabilities, link/unlink, revocation/expiry, replay, sender/target binding, membership, cancellation, lifecycle races, receipt validation, media size and validation.
- **Browser E2E in CI:** two isolated wallet profiles, site origin A, negative origin B, WebMCP tool approval and denial, signed peer messaging, wheel events, expiry/reconnect, actual direct WebRTC assertions and screenshot traces.
- **Manual cross-device/network:** desktop Chrome/Firefox/Safari where supported, iOS/Android where supported, two different residential networks, restrictive NAT/firewall negative case, background tab and browser restart. Do not report six-participant success without a recorded test with **two humans plus four independent agents**, timestamped results and failures.
- **Security:** peer joining without consent, intercepted/replayed packet, forged site and issuer, cross-room tool call, unauthorized target, malicious/oversized attachment, contenteditable/secret element share, stale session, deleted/unlinked identity.
- **Packages/release:** `npm ci`, `npm run test:all`, `npm run build`, `npm run verify:packages`, `npm run format:check`, `npm run test:browser:e2e`, smoke-test published package exports and deployed static pages. Also verify documented examples against actual shipped package. Do not publish until CI and release evidence are green.
- **External checks:** The repo no longer uses Vercel for the core static P2P product. A legacy Vercel PR status may still report failure. Remove or intentionally document that external integration separately from the actual GitHub Actions result; never claim a failed required status is green.

## Proposed PR sequence

1. **Already opened:** PR #2 fixes connect-panel session disposal, pending-handshake races, and replacement cleanup; PR #3 aligns copyable instruction capability grammar with signed requests. Review/merge only after CI.
2. **Protocol PR:** Separate short handshake TTL from renewable bounded session TTL, with wire versioning, type changes, tests and docs.
3. **Linking PR:** Site/agent link proofs, local storage, unlink/revoke behavior and a minimal API; preserve no-server operation.
4. **Participation PR:** membership model, role/capability enforcement, public-vs-restricted disclosure, join/leave and verification tests.
5. **Connection status PR:** expose direct-peer count / connection lifecycle, diagnostics, and testable state in UI/SDK.
6. **Wheel PR:** recipients, safe previews, signed delivery receipts and accessibility/mobile behavior.
7. **Integration PR:** full E2E on the example site plus an actual coding-agent adapter and optional Clerk demonstration.
8. **Release PR:** complete multi-network / six-participant evidence, troubleshoot edge cases, validate npm and GitHub Pages, close tracker with truthful check results.

Keep PRs independently reviewable, update changed public types/docs, and preserve unrelated work. Avoid silently introducing a backend or relay-mediated application-data transport.

## Coding-agent execution directive

> Start from the latest `main` and inspect current open PRs before changing files. Preserve unrelated changes. Treat the P0 tasks and acceptance criteria above as release gates, not speculative features. Implement the smallest safe slice per branch, write negative/security tests first where possible, run the full test/build/browser suite, collect actual evidence, open focused PRs, and resolve review/CI failures. Never mark peer connectivity or content delivery successful merely because consent was signed or a transport call returned. Never claim real-world multi-network/six-participant verification unless performed. Keep the core wallet serverless, self-custodied and fully usable without Clerk.
