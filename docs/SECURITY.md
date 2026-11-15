# Security boundaries

## What signatures establish

An ECDSA signature verifies that the holder of a particular private key signed a specific canonical JSON record. It does not establish a legal or human identity, prove that a person read the request, authorize a website resource, or guarantee that an agent is safe.

Websites are the authorization authority for their own resources. They must verify the signer, exact audience/origin, nonce, expiry, requested and approved capabilities, recipient, resource, and any applicable revocation policy before taking an action. Never trust a client-supplied `authorized: true` flag.

## Key storage and recovery

The private key is imported as a non-extractable Web Crypto key and stored in origin-scoped IndexedDB. During first creation, the browser briefly generates an extractable key pair so it can create the encrypted recovery file; the private JWK is encrypted before the non-extractable key is persisted. Same-origin JavaScript can still ask the wallet to sign, so protect the wallet origin against XSS, compromised dependencies, and malicious extensions.

The recovery file contains encrypted key material, not plaintext private JWK. Use a unique strong passphrase and store the file offline. There is no password reset service. Clearing browser data without the file permanently loses the wallet. Removing a wallet clears its local signed activity too.

## Signed data and freshness

Signed records use the `ai-auth-wallet` protocol marker, version, type, issuer, creation time, payload, and ECDSA P-256/SHA-256 proof. Canonicalization follows RFC 8785 for supported JSON values. Verifiers reject malformed keys, changed payloads, expired or future-dated events, incorrect audiences, and replayed nonces where a nonce guard is supplied. A room permits at most 16 active direct peer connections and at most 16 new peer connections per ten seconds, up to four data channels per connection, and eight inbound frames per peer connection before signature verification. Verified events are limited to 32 per signing identity and 256 per room in each fixed ten-second window. Since signed events expire within 125 seconds, at most 14 room windows can contribute live entries (3,584), below the 4,096-entry replay-cache capacity. The room-wide limit also prevents identity or channel rotation from exhausting that cache.

## Peer network

Same-origin BroadcastChannel events are visible to other tabs on the same origin. Manual SDP may include IP/network candidates; exchange it only through a private channel. Direct WebRTC data channels are encrypted in transit, but message signatures and identity do not prevent a user from receiving unsafe content. No relay is configured. A network that requires TURN will fail to connect in this MVP.

Private mode stops this app's public presence and shared messages. It does not hide activity from browser extensions, operating-system software, the hosting provider, or another site, and it does not erase already received data on another peer.

## Popup consent and site enforcement

The external popup flow accepts a request only from `window.opener`, binds its audience to the sender origin, and returns only a wallet-signed consent envelope to that exact origin. The relying page must still verify the signature, request nonce, audience, expiry, and approved scope. The wallet page uses `Cross-Origin-Opener-Policy: unsafe-none` so cross-origin sites can retain the popup relationship; this does not grant same-origin DOM access, and the receiver checks both the popup's origin and window source before accepting a response. Public SDK module files alone allow cross-origin GET/OPTIONS requests.

A verified browser proof is not server-side authorization. Do not use the static wallet flow alone to protect real accounts, private data, or tools. A production resource owner must verify proof and enforce its own policy server-side, with replay storage, revocation, audit retention, and a security review.

## Optional shared-state service

The local Worker prototype adds origin-bound wallet challenges, short-lived opaque sessions, server-verified capability grants, tenant-scoped Durable Object storage, and authenticated WebSockets. It never receives the wallet private key. Session tokens are sent in HTTP authorization headers or in the first WebSocket frame, not URLs. The Worker verifies a session and workspace membership again for protected operations.

Challenge issuance, active sessions, tenant registration, lifetime tenant creation, messages, audit events, invitations, and sockets have local caps. WebSocket upgrades are limited to 4 per client IP in each 10-second window. Each tenant member may publish 30 presence updates and write 60 messages per minute, with tenant-wide ceilings of 300 presence updates and 600 message writes per minute. These fixed-window limits are enforced in durable objects. Tenant creation is limited to 10,000 workspaces over the service lifetime and 100 per wallet identity; deletion does not reset those quotas. Browser activity history keeps at most 100 entries, pruning the oldest first. Message and audit retention are bounded and are not backups. Invitation replay tombstones remain until the signed grant expires. The Worker has only been verified in the local Cloudflare test harness; it is not deployed, has no managed-runtime or backup evidence, and must not be treated as production-ready.

The MCP adapter runs locally over stdio. A host application supplies the wallet, service client, and explicit approval callback. The adapter exposes only tools covered by the authenticated session and redacts bearer tokens from tool errors. It does not persist keys or tokens. Protect the MCP host and its wallet storage as local credentials.
