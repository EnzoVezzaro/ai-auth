# Security boundaries

## Identity and consent

An ECDSA signature proves that the corresponding private key signed a specific canonical record. It does not establish a human identity, prove a person read the request, make an agent trustworthy, or grant access to a site's resources.

The wallet stores a non-extractable Web Crypto key in origin-scoped IndexedDB. First-time creation briefly generates exportable key material so it can create an AES-GCM encrypted recovery file before storing the non-extractable key. Same-origin JavaScript can still ask the wallet to sign. Protect the wallet origin from XSS, compromised dependencies, and malicious extensions.

The site must verify the consent signature, expected wallet, exact audience, one-use nonce, expiry, and requested capability subset. It must enforce authorization for its own resources. Do not treat client-side consent as server-side authorization.

## Signed collaboration events

Signed events include protocol version, type, issuer, creation time, origin, room, wallet session, nonce, and expiry. Receivers verify the public-key identity, signature, expiry, room, origin, and replay state. Room limits cap active peers, channels, and accepted inbound event rates. Events with a known capability are rejected unless that capability was approved for the session.

WebRTC encrypts the data channel in transit. Signatures authenticate event authorship; they do not make message contents safe. Validate each action payload before using it. Never execute received content as code or interpret an action event as an authorization grant.

## Discovery and privacy

Public Nostr relays carry discovery and signaling metadata, not the signed collaboration event stream. Relay operators can observe participation, timing, and room-topic hashes. The hash is not a secret, and knowing a room name does not grant permission. Do not put private information in room names or labels.

Direct WebRTC uses public STUN servers to discover possible network paths. No TURN service or third-party data relay is configured. Some NATs and firewalls will prevent a direct connection; this MVP reports the failure and does not route application data through a relay.

Private mode stops this wallet session from joining the public room. It cannot erase events already received by another peer or hide activity from the browser, extensions, operating system, or hosting provider.

## Recovery and WebMCP

Store the encrypted recovery file separately from the browser profile and use a strong unique passphrase. AI Auth has no password reset service. Clearing browser data without the recovery file permanently loses the wallet.

WebMCP is the primary in-page tool surface and is feature-detected. Page tools require the active connection object returned by `connectAIAuthModal`; a plain consent-shaped object is not accepted. The connection enters a private in-memory trust map only after its wallet signature, origin, nonce, and expiry have been verified. Tool registration requires `tools.invoke`; other scopes do not authorize page-tool invocation. Closing or expiring the connection aborts registered tools, and execution rechecks the active wallet approval. Every remote tool call also requires an explicit human approval callback supplied by the site. Keep the JavaScript API available for browsers without WebMCP. Tool catalogs, requests, results, and activity events are visible to connected peers in the public room; never include credentials, private page data, or secrets.

The modal connection automatically closes when its signed consent expires. Sites must start a new request and obtain a new wallet approval to continue collaboration.

## Connect instructions and panel

The copyable connect instruction produced by `createAIAuthConnectInstruction` contains only public data (site origin, room name, wallet URL, requested capabilities) and no credentials. The connect panel renders in a closed shadow root and displays only values taken from verified signed lifecycle events; its copy action writes that same public instruction to the clipboard and nothing else.

## Site/agent link lifecycle: what revocation means

There is no global revocation and no AI Auth server that can enforce one. A site link stops working only through these mechanisms:

- **Bounded expiry.** Every link proof carries `expiresAt`, at most 30 days after creation, and verifiers reject it afterwards.
- **Signed revocation events.** `unlink` produces a signed `ai-auth-link-revocation` event. It takes effect at a site only after the wallet (or the user) delivers it and the site records it in its own revoked set (`createRevokedLinkSet`). A site that never receives the event keeps honoring the link until it expires.
- **Site-side records.** The site can always refuse a link by deleting its own account mapping.

The wallet's local link list is only what that browser origin storage remembers; it is not proof the site still honors a link. Mapping a wallet identity to an account is owned by the site. The signature proves key possession, not human identity or site membership, and `subject` is a site-supplied claim. Link storage is a separate IndexedDB database (`ai-auth-wallet-links-v1`); `forgetWallet` does not clear it, and key recovery or rotation yields a new wallet id that needs fresh links. The wallet trusts the origin given in a link challenge only as far as the transport that delivered it (popup or modal origin checks); the in-memory nonce store and revoked set are not durable across site restarts unless the site supplies its own.
