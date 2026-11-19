# Changelog

## Unreleased

### Added

- `@enzovezzaro/ai-auth-wallet/tool-descriptor`, `/tool-registry`, `/provider-adapters`, `/utcp-adapter` and `/unified-tools` subpaths. Together they provide one API for listing and invoking tools from MCP, WebMCP and UTCP without changing existing root exports or wire behavior.
- Protocol-neutral descriptors with namespaced IDs, preserved native definitions, source tracking and a default-deny registry with bounded, privacy-preserving audit (`tests/tool-registry.test.mjs`).
- An optional UTCP adapter that reuses the official SDK when installed, enforces destination and credential policy above it, and fails closed when native cancellation is unavailable (`tests/utcp-adapter.test.mjs`).
- Catalog converters for existing WebMCP, MCP and agent tool catalogs, plus the unified invocation facade (`tests/provider-adapters.test.mjs`, `tests/unified-tools.test.mjs`).
- Additive A2A/ACP interoperability and UCP/AP2 payment-isolation boundaries (`/agent-interop` and `/commerce-boundary` subpaths). They classify protocols, treat Agent Cards and peer data as untrusted, and deny all payment authority from generic tool grants. No protocol state machine, mandate minting or real payment operation is included.
- The interoperability and Code Mode RFC, the Cloudflare/Pi comparison, and a reusable multi-specialist council prompt. The architecture decisions live under `docs/architecture/`.
- The standards-based identity RFC and the user-first Connect Agent end-to-end acceptance plan from the open documentation PRs. The identity RFC cross-links the existing Phase 0 review, which holds the independently verified findings. Both are registered in the docs renderer so `verify:docs` passes.

### Changed

- Optional Code Mode now bounds total and concurrent host calls, caps individual log lines, rejects corrupt shared-buffer replies, forwards abort to sends, and reports truthful partial status after a timeout. Direct tools and the `--code-mode` default are unchanged (`packages/mcp/test/code-mode-hardening.test.mjs`).

### Note

- No npm version was bumped by this entry. UTCP is an opt-in subpath; `@utcp/sdk` is only loaded when a caller supplies it or installs it. Code Mode remains opt-in and is not a security sandbox for hostile code.

## 0.11.1 - 2026-11-18

### Changed

- Landing copy names the connection steps directly: Request, Approve, Connect, Session. The invented minute markers and generic process labels are gone, and each step states what actually happens.
- The headings "From a request to a signed room" and "Open code, no hosted service" are replaced with section names. The hero status readout shows transport and signaling facts instead of made-up event and relay counts.

### Added

- `.agents/skills/copywriting/SKILL.md`, a project-specific copywriting skill grounded in the repository's product, audiences, voice, and verified claims.
- `.agents/product-marketing-context.md`, the authoritative context the skill reads before drafting copy.

### Note

- No npm package versions changed. This release covers landing copy and repository documentation only.

## 0.11.0 - 2026-11-17

### Changed

- Chat: `message/text` is now the canonical wire type. The wheel, headless agents, MCP `ai_auth_send` and the wallet send it with a signed `messageId` and optional `target`. `collab/text` is still accepted from older senders and earns the same signed delivery receipt. Both names are documented in the wire protocol.
- The landing page and every documentation page were rebuilt in one visual system: dark canvas, Funnel Display type, a connected build diagram, and named agents that travel with scroll and assemble each section as they arrive. The visitor keeps the native cursor; reduced-motion and small screens get static final states.
- Docs now render as styled HTML at `.html` URLs and at the existing `.md` URLs. Raw Markdown stays under `docs/raw/` for `llms.txt`, and every linked page, including the changelog and package READMEs, is published.
- The root README keeps its full design and content, with links updated to the current docs structure.

### Added

- `verify:docs` in CI, the Pages workflow and the release workflow. It fails the build when a doc is unstyled, has a dead internal link, or loses its raw Markdown copy.
- `tests/docs-render.test.mjs` and renderer support for images, inline HTML and the README badge block.

### Note

- This release publishes `@enzovezzaro/ai-auth-wallet` 0.11.0, `@enzovezzaro/ai-auth-agent` 0.1.6, `@enzovezzaro/ai-auth-mcp` 0.3.5 and `@enzovezzaro/ai-auth-runtime` 0.1.1.

## 0.10.0 - 2026-11-17

### Fixed

- Renewed sessions: a renewed session that ends is no longer resumable. Its grant is tracked under the stable session id for save, touch, end and resume.
- Resume: tool requests and room-ready are accepted after a resume; a second renewal can resume; a failed persistence write no longer blocks ending a session.
- Renewal copy matches the granted lifetime; a Never grant says so and shows no end time.
- Tool error codes reach the agent end to end (invalid input is TOOL_UNAVAILABLE, not DENIED). A tool returning nothing counts as success. Oversized results have their own code.
- Cursors: correct placement on pages taller than the viewport; human cursors are page-scoped; departed participants' cursors are removed; the final position is always sent; scroll before any pointer move no longer jumps to the corner.
- Chat: the wallet's chat list shows collab/text messages from agents.
- Wallet privacy: the ready signal is addressed to a verified origin, not "*"; removing a wallet clears its grants and connection; a timed-out resume keeps the saved session and offers a retry.
- Errors: wallet error messages say what the person can do next.
- The copyable connect instruction pins the SDK version.
- Session binding: a peer's hello or heartbeat cannot rebind another issuer's session.

### Note

- The Code Mode sandbox fix and the tool fixes that live in the agent and MCP packages are not in this release. They ship when those packages can be published (their dependencies on the wallet are local links today).

## 0.9.1 - 2026-11-17

### Fixed

- A visitor's Disconnect now reaches the agents at once. Peers receive a signed `peer/goodbye` and drop the visitor, instead of waiting for the presence lease to expire. Two things were broken: the wallet closed its WebRTC channel before the goodbye was sent, and the site removed the wallet frame before the session-ended message arrived. The wallet now sends the goodbye first, and the site keeps the frame for a short grace period.
- The CI test for the disconnect goodbye waits for the signed goodbye instead of a fixed number of event-loop ticks, so it no longer fails on a slow runner.

## 0.9.0 - 2026-11-17

### Changed

- The site's saved session record moves from `sessionStorage` to `localStorage`. It survives a tab close, a tab change, and a browser restart, for as long as the browser profile keeps it. It holds public data only.
- The wallet keeps approved grants and ended-session flags in IndexedDB. After a wallet reload it can still confirm a session, and a session that was ended is refused.
- Resume is one click after a refresh: the page offers Resume, and the wallet confirms the session. Automatic restore on load is not yet available. Browsers partition storage for an embedded wallet, so a silent check cannot read the grants.

### Fixed

- The "ended sessions" list in the wallet is no longer capped at 100 entries, so an old ended session cannot become resumable again.

### Added

- The landing page has a canonical URL, a social preview card, structured data, `robots.txt`, a sitemap, and `llms.txt`. The wallet and the demo are marked `noindex`.
- The GitHub Pages hosting policy is enforced in CI: the only deployment target is GitHub Pages, and a Vercel configuration fails the build.

## 0.8.0 - 2026-11-17

### Added

- WebMCP tools publish a `consequentialHint` for protected actions and an `untrustedContentHint` for results that come from peers or agents. These hints are advisory; the approval gate is still the only check.
- WebMCP tools publish an optional human-readable `title`.
- The page re-discovers its WebMCP tools when the page's tool set changes (`toolchange`), and re-publishes the catalog.

### Changed

- Tool names follow the WebMCP draft: 1 to 128 characters from `A-Z a-z 0-9 _ . -`. Non-object JSON Schemas are accepted for tool input.
- The landing page is rebuilt with ThreeUI.

### Fixed

- Peers that keep sending heartbeats stay online in the collaboration wheel. Before, an active agent could show as offline.
- An addressed message to a fresh peer is no longer blocked as "offline".
- A visitor's disconnect sends a signed goodbye, so peers drop the visitor at once instead of after the lease expires.
- Agent-side tests (tool provider and agent scenarios) allow longer for the first catalog or presence announcement under a loaded run.

## 0.7.0 - 2026-11-16

### Added

- Sessions persist per agent in the site origin's `sessionStorage`. The stored record holds public data only: the signed consent, identifiers, capabilities and times. No key material is stored on the site.
- `listResumableSessions` lists the records that can still be resumed, and `resumeAIAuthSession` resumes one. Resume happens only after the visitor clicks it. The wallet confirms the session still exists and never grants a new scope.
- Inline wallet creation on the request screen, so a visitor with no wallet does not have to leave the page to create one.
- Type declarations for `recordFromConsent`, and for the resume and connect options `storage`, `sessionStore`, `resumeRecord` and `resumeTimeoutMs`.

### Changed

- `connectAIAuthModal` never resumes on its own. After a page reload, a site that wants to resume must call `resumeAIAuthSession`.

### Fixed

- A site that ends a session tells the wallet, so the wallet records it as ended and it cannot be resumed.
- The wallet checks the origin of resume requests and bounds the activity time a site supplies on resume.
- Resume applies the consent version check and the agent-descriptor check, as a fresh connect does.
- A resume record supplied to `resumeAIAuthSession` must match the origin before any handshake starts.
- Capability chips in the connect panel show plain titles instead of raw permission IDs.
- On touch devices, element sharing explains that it is unavailable, instead of showing a picker that cannot be used.

## 0.6.2 - 2026-11-16

### Fixed

- An agent re-sends its current cursor and last activity to a peer that says hello (throttled to once per 5 s per peer). Before, a visitor who arrived after the agent last moved never saw its cursor until it moved again. This is the state sync that lets agents stay visible to people who come and go.

## 0.6.1 - 2026-11-16

### Fixed

- A connected page now re-announces its WebMCP tool catalog every 45 seconds (`catalogRefreshMs` on `mountAIAuthInPageAgent`). A signed catalog expires after 120 seconds, so agents that stayed in the room used to lose the site's tools until someone new joined.
- An agent's cursor is labeled with its name (from the agent runtime's descriptor) instead of its wallet id when the room carries one.

## 0.6.0 - 2026-11-16

### Changed

- Session length defaults to Never. A site that names no limit gets a grant with no fixed end and no idle end; the session lasts until the owner ends it, the site ends it, or it is revoked. `sessionTtlMs` and `idleTimeoutMs` accept `null` for Never. A numeric site cap rules out Never, and the wallet honors it.
- The wallet's "Session lasts" choices are 5, 15, 30 and 60 minutes and Never, with Never pre-selected when the site allows it.
- Consent version 2 may carry `expiresAt: null` and `sessionTtlMs: null` (and `idleTimeoutMs: null`) for Never. Verifiers accept those only when the request allows Never.
- Requests that name no lifetime carry `sessionPolicy: "never"`. Requests from SDKs that predate Never have no such field and keep the 30 minute default, so existing sites (for example BODY4AI on 0.5.x) still verify their consent.

## 0.5.3 - 2026-11-16

### Fixed

- Agents drop a site's tool catalog once the site leaves the room. Before, a stale catalog stayed for up to a minute, and calls to a gone site timed out after 30 seconds. Calls to a site that has left now fail at once with "The site is no longer connected to this room". A room that tracks no presence for a site keeps its catalog, as before.
- The static wallet shows its release version in the footer, and its stylesheet and script URLs are versioned per release, so a deploy is never served from a stale browser cache.

### Changed

- The agent runtime's room facade exposes live presence (`peers`), which the agent client uses. `@enzovezzaro/ai-auth-agent` 0.1.1.

## 0.5.2 - 2026-11-16

### Fixed

- The connect dialog places Cancel in its own 44px row above the wallet, instead of over the wallet header.
- The wallet stacks its request and key panels below 900px, so the request text stays readable inside the 720px connect dialog.
- Documentation matches the code: the session idle rule (local page activity counts), `resume()` on the agent runtime, the protocol section status labels, and the `degraded` state, which no code path enters yet.

### Fixed

- Presence no longer starves chat. Heartbeats, hello, goodbye and cursor events have their own inbound budgets per source, per identity and per room. Cursor movement can no longer drop a site's messages, actions or receipts.
- Delivery is per recipient. A broadcast used to skip a peer whose channel was briefly not open, with no error and no retry, so a message could stay "waiting for a receipt" forever. Each send now targets one peer, and a missed send is retried until the peer reopens or the signed event expires.
- Tool traffic is addressed. Tool requests and cancellations go to the serving site, and tool responses go to the requesting agent, instead of to every peer in the room.

### Changed

- Content budgets (messages, actions, receipts, tool traffic) per source and per identity rise from 32 to 64 events per 10 seconds. Bursts from a host serving several agents were being dropped. The room-wide content cap stays at 256 per 10 seconds.

## 0.5.0 - 2026-11-15

### Breaking changes

- `registerAIAuthPageActions` throws unless an `authorize` function is supplied. Page actions never run without a human approval step.
- Denied and failed WebMCP tool calls now reject on the agent side. Previously they resolved as success with an error payload.
- Private presence replaces the old refusal: `privateMode` joins a room silently (no presence or cursor) and its actions are still signed and audited. `NostrWebRTC` no longer throws for private rooms.
- Default session length is 30 minutes (60 minute cap, 10 minute idle timeout). Version 1 consents keep the old two-minute handshake-bound session.
- Deploy the SDK and wallet together: an older SDK cannot verify a version 2 consent.

### Added

- Separate the handshake challenge from the usable session. The permission request stays a single-use 1–120 second challenge (now `version: 2`, with optional `sessionTtlMs`, `idleTimeoutMs`, and `renews`); the signed `connect/consent` payload (`version: 2`) now carries `issuedAt`, `challengeExpiresAt`, `sessionTtlMs`, `idleTimeoutMs`, and an `expiresAt` that is the bounded session grant instead of `request.expiresAt`.
- Default session is 30 minutes with a hard 60 minute cap and a 10 minute idle timeout. A request can only ask for less than the cap; verifiers reject any consent that exceeds the cap or the request's own hint.
- Add explicit renewal: `connection.renew()` asks the wallet owner to approve again. Renewal can keep or narrow capabilities, never widen them, and is only possible while the session is still active.
- Add idle timeout, wallet "End session" (reported to the site as `revoked`), and a visible session expiry countdown in the wallet. Expired, idle, or revoked sessions stop authorized publish, receive, transfer, and WebMCP tool calls.
- Add `sessionTtlMs` and `idleTimeoutMs` options to `connectAIAuthModal`, the `renewed` lifecycle event, `idle` and `revoked` disconnect reasons, and the exported `SessionLease`, `sessionLimits`, and session constants.
- Sites must upgrade their SDK to get long sessions. The wallet answers a version 1 request (older SDKs) with the legacy consent exactly as 0.4.1 did, so existing sites keep working but retain the two-minute handshake-bound session, and the wallet says so.
- Compatibility: version 1 consents still verify but keep their handshake-bound expiry. An older SDK cannot verify a version 2 consent, so deploy the SDK and wallet together.

- Add the site/agent link lifecycle: `createLinkChallenge`, `approveLink`, `verifyLink`, `listLinks`, `unlink`, `verifyLinkRevocation`, plus in-memory `createLinkNonceStore` and `createRevokedLinkSet`. Document the wire formats and the absence of global revocation.
- Add participation modes: `open` rooms with an explicit disclosure and `restricted` rooms that require a site-issued `ai-auth-membership` proof. New exports: `issueMembership`, `verifyMembership`, `createParticipationPolicy`, and related constants. `P2PRoom` accepts an optional `participation` option and `send(..., { to })`; restricted rooms drop events from non-members and never deliver non-presence events to them.
- Add `docs/PROTOCOL.md`: versioned contracts for agent identity, instance identity, agent descriptor, membership, session, presence, room, cursor, revocation, authorization epoch, tool authorization and the runtime adapter, with 0.4.x migration rules. Self-declared fields are documented as claims, not attestations.
- Add `createAgentDescriptor`, `verifyAgentDescriptor`, `createInstanceId`, `bindInstance`, `verifyInstanceBinding` and `createCloneDetector` (`clone-suspected` diagnostics).
- Add membership `duration` kinds (`short`, `configured`, `long`, `until-revoked`), the authorization epoch (`bumpEpoch`, `observeEpoch`), short-lived execution grants and the fail-closed `authorizeProtected`.
- Add signed `ai-auth-revocation` records and `createRevocationGossip(room)` for peer-to-peer propagation. Document the offline consistency limits in `docs/SECURITY.md`.
- Interaction wheel: choose "everyone in public room" or one verified recipient (short fingerprint derived from the wallet public key, online/offline from connection state). Targeted messages carry a signed `target`; receivers drop messages addressed to another wallet.
- Add signed `ai-auth-receipt` v1 delivery receipts and message states `composing`, `queued`, `sent-to-transport`, `received-by-peer` (only after a valid signed receipt), `failed`, and `expired`, with bounded history. A receipt does not prove a human read the message.
- Wheel privacy: preview before sending, public-room warning, and default blocking of password, credential-autocomplete, `contenteditable`, `[data-private]`, and `[data-ai-auth-private]` regions.
- Wheel accessibility: dialog role and labels, focus trap and restore, Escape to close, disabled controls with explanations, cancel-recording control, all capture tracks stopped on close, and safe-area aware positioning.
- New additive exports: `verifyReceipt`, `createDeliveryLedger`, `buildReceiptPayload`, `isAddressedTo`, `isSensitiveElement`, `extractSafeText`, and related constants and types.
- Attach a signed agent descriptor to the connect consent (`approvePermissionRequest(..., { agent })`); `connectAIAuthModal` verifies it and exposes `connection.participant` (verified identity plus claims, labelled as claims) and clone diagnostics. 0.4.x consents and the legacy v1 path are unchanged.
- Gossip signed epoch announcements and wallet-signed link revocations; add bounded, verified catch-up (`revocation/sync`) so peers that were offline converge.
- Add `connectAIAuthModal({ participation })`: remote tool requests must pass `authorizeProtected` or are dropped; `connection.participation` exposes the check.
- Private presence: `privateMode` now joins a room silently (no presence or cursor, signed and audited actions) instead of being refused; `NostrWebRTC` no longer throws for private rooms. Behavior change: a private `P2PRoom` used to refuse to send or receive anything.
- Forward `target` and `messageId` through the embed proxy (validated, bounded), forward bounded receipts, and expose `supportsTargets`/`supportsReceipts` only when the wallet reports them.

## 0.4.1 - 2026-11-15

- Dispose wallet sessions when a connection ends and prevent orphaned handshakes from leaving pending wallet state behind.
- Normalize capabilities consistently with signed requests.

## 0.4.0 - 2026-11-15

- Add the site connect surface: `createAIAuthConnectInstruction` builds the canonical copyable connect instruction for any agent, and `mountAIAuthConnectPanel` renders a self-contained panel that copies the instruction, runs the wallet handshake, and reflects idle, connecting, connected, and disconnected states with the verified identity, approved capability chips, and an expiry countdown.
- Mirror the panel state onto its host element as `data-status` so a site header badge or page CSS can reflect the connection without reading the closed shadow root.
- Export the connect surface from the package root and the `@enzovezzaro/ai-auth-wallet/agent-connect` subpath, and verify the packed subpath resolves in the release checks.
- Add the BODY4AI end-to-end integration example under `examples/body4ai/` with the WebMCP in-page section, connect panel wiring, and catalog tool actions.

## 0.3.0 - 2026-11-15

- Connect the wallet from the target site using an in-page modal and expose connection, session, and disconnect lifecycle hooks.
- Add the bottom-right collaboration action wheel for public room chat, element sharing, screenshots, and screen recordings.
- Add a signed in-page agent bridge that discovers WebMCP tools, advertises a bounded public catalog, requests human approval, returns results, and propagates abort, timeout, and disconnect cancellation.
- Bind remote tool cancellation to the requesting wallet identity and P2P session; reject unregistered wallets and wrong-session cancellation.
- Keep site and agent presence, cursor, scroll, action, and transfer events on direct WebRTC; public Nostr relays provide discovery and signaling only. TURN remains disabled.
- Clarify that tool catalogs, requests, results, and collaboration transfers are visible to peers in the site's public space; keep secrets and private page data out of that channel.
- Continue static hosting and local MCP/runtime adapters without an AI Auth backend. The six-participant human scale test remains post-release validation.

## 0.2.0 - 2026-11-15

- Release the self-custodied wallet, default site-space collaboration, direct WebRTC SDK, optional WebMCP, and local adapters.
- Remove the hosted Worker, service SDK, Docker, and Vercel deployment surface.
- Verify local two-context browser delivery and delegated Ego Lite-to-Chrome messaging; cross-network reachability remains unverified.

Versions below record the previous preview line. The server client and Worker were removed from the current product tree.

## 0.2.0-beta.4 - 2026-11-15

- Validate permission-request nonce shape and timestamps before consuming a replay guard.
- Bound replay-guard entries, nonce length, and nonce lifetime; throttle expiry cleanup work.
- Add regression coverage for malformed-request replay-guard poisoning and capacity limits.

## 0.2.0-beta.3 - 2026-11-15

- Clarify the active peer-connection cap and inbound connection rate limit in the security guide.
- Document the isolated Chromium browser E2E and CI installation command.
- No wallet API or wire-format changes.

## 0.2.0-beta.2 - 2026-11-15

- Bound local signed activity history to the latest 100 entries.
- Limit direct peer connections and throttle inbound P2P events per connection, signing identity, and room.
- Add cumulative tenant creation quotas that remain consumed after workspace deletion.
- Add regression coverage and document the new limits.

## 0.2.0-beta.1 - 2026-11-15

- Add `connectPresenceResilient` for bounded exponential reconnects, first-frame session reauthentication, and fresh presence snapshots after reconnect.
- Stop reconnecting when the session expires or the server revokes authorization; expose explicit close, presence, and message controls.
- Keep the existing single-socket `connectPresence` API unchanged.

## 0.2.0-beta.0 - 2026-11-15

- Add the `@enzovezzaro/ai-auth-wallet/service` client for wallet-approved sessions, workspace operations, and authenticated presence connections.
- Add the preview `@enzovezzaro/ai-auth-mcp@0.1.0-beta.0` local stdio adapter with capability-scoped workspace tools.
- Reject signed P2P envelopes with non-numeric expiry claims before replay-cache insertion.
- Preserve the existing wallet, connect, capability, and P2P entry points.
- Document the optional Worker/MCP architecture and the current limits of the local shared-state service.

This release adds a source client for the local Worker prototype. It does not imply that the shared-state service is deployed or production-ready.
