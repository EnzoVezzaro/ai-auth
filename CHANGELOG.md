# Changelog

## Unreleased

- Separate the handshake challenge from the usable session. The permission request stays a single-use 1–120 second challenge (now `version: 2`, with optional `sessionTtlMs`, `idleTimeoutMs`, and `renews`); the signed `connect/consent` payload (`version: 2`) now carries `issuedAt`, `challengeExpiresAt`, `sessionTtlMs`, `idleTimeoutMs`, and an `expiresAt` that is the bounded session grant instead of `request.expiresAt`.
- Default session is 30 minutes with a hard 60 minute cap and a 10 minute idle timeout. A request can only ask for less than the cap; verifiers reject any consent that exceeds the cap or the request's own hint.
- Add explicit renewal: `connection.renew()` asks the wallet owner to approve again. Renewal can keep or narrow capabilities, never widen them, and is only possible while the session is still active.
- Add idle timeout, wallet "End session" (reported to the site as `revoked`), and a visible session expiry countdown in the wallet. Expired, idle, or revoked sessions stop authorized publish, receive, transfer, and WebMCP tool calls.
- Add `sessionTtlMs` and `idleTimeoutMs` options to `connectAIAuthModal`, the `renewed` lifecycle event, `idle` and `revoked` disconnect reasons, and the exported `SessionLease`, `sessionLimits`, and session constants.
- Sites must upgrade their SDK to get long sessions. The wallet answers a version 1 request (older SDKs) with the legacy consent exactly as 0.4.1 did, so existing sites keep working but retain the two-minute handshake-bound session, and the wallet says so.
- Compatibility: version 1 consents still verify but keep their handshake-bound expiry. An older SDK cannot verify a version 2 consent, so deploy the SDK and wallet together.

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

## Unreleased

- Add the site/agent link lifecycle: `createLinkChallenge`, `approveLink`, `verifyLink`, `listLinks`, `unlink`, `verifyLinkRevocation`, plus in-memory `createLinkNonceStore` and `createRevokedLinkSet`. Document the wire formats and the absence of global revocation.

- Add participation modes: `open` rooms with an explicit disclosure and `restricted` rooms that require a site-issued `ai-auth-membership` proof. New exports: `issueMembership`, `verifyMembership`, `createParticipationPolicy`, and related constants. `P2PRoom` accepts an optional `participation` option and `send(..., { to })`; restricted rooms drop events from non-members and never deliver non-presence events to them.
