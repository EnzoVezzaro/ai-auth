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

## Interaction wheel privacy and delivery

- **Public room by default.** Everything sent from the wheel goes to peers in a public room, and recipients can save it. The wheel says so before each send.
- **Targets are addressing, not encryption.** A targeted message carries a signed `target`; honoring receivers drop it if it is not for them. Every directly connected peer still receives the packet, so a modified client can read it. Do not treat a target as confidentiality. The wheel offers a target only when the transfer layer enforces it (`supportsTargets`) and refuses to widen a targeted selection to everyone if the recipient goes offline.
- **Identity shown is a key fingerprint.** Recipients are listed by a short fingerprint derived from the verified wallet public key, never by a nickname. A fingerprint and a signature prove key possession only, not human identity or site membership.
- **Receipts prove a key signed an acknowledgement.** They do not prove a human read the content. See `WIRE_FORMAT.md`. Delivery status is never inferred from a successful transport call.
- **Sensitive page regions are blocked by default.** Elements that are password inputs, carry credential `autocomplete` tokens, are `contenteditable`, or sit inside `[data-private]` or `[data-ai-auth-private]` cannot be shared, and form control values are never included. Private descendants of a shared element are omitted from its text. Sites can mark regions with the two attributes.
- **Screen capture cannot be redacted.** Screenshots and recordings contain whatever is visible in the surface the user picks in the browser's `getDisplayMedia` picker. The wheel shows a preview and warns when the page has private regions, but it cannot mask them. Capture is only ever started by a click, is limited to 512 KiB (screenshots) and 1 MiB (recordings), and every track is stopped on completion, cancellation, close, expiry, and unmount.
- **The wheel is not an authorization path.** It only sends collaboration messages. It does not invoke WebMCP tools or site actions.
- **Embedded connections.** The site embed currently relays transfers through a postMessage proxy that does not carry targets or message ids. Through that path the wheel cannot target a recipient or confirm receipts, so it disables targeting and states that delivery cannot be confirmed.
