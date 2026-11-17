# Security boundaries

## Threat model

Assume other peers, relay operators, and page scripts are untrusted. Assume the origin that hosts the wallet is trusted only while it is free of XSS, hostile dependencies, and malicious extensions. WebRTC encrypts the data channel in transit. Signatures authenticate who wrote an event. Neither makes the payload safe. Validate every action before using it, and never execute received content as code.

A valid signature proves control of a key. It does not prove a human read a request, that the person is who they claim to be, or that an agent is trustworthy. Agent `provider`, `model`, `runtime`, and `agentType` fields are claims, not attestations.

## What a site can and cannot do

A site can ask for named capabilities for its exact origin, show the request in the wallet, verify the signed consent, and decide what its own resources allow. It cannot read the wallet key, sign as the wallet, add capabilities the owner did not approve, or silently renew a session.

The handshake challenge is short lived (1 to 120 seconds) and single use. The site must verify the consent signature, the expected wallet, the exact audience, the one-use nonce, the expiry, and the approved capability subset. Client-side consent is not server-side authorization. The site still checks every request against its own rules.

A request with no lifetime gets Never by default. The wallet shows the choice, and the owner can pick a fixed duration. A numeric site ceiling rules out Never. Verifiers reject a consent that exceeds the ceiling.

## What a stored record allows

The site record in `localStorage` is public data only: the signed consent, public key, capabilities, ids, and activity times. It does not contain a private key, backup, or passphrase. The wallet keeps approved grants in its own IndexedDB.

A stored record lets the page offer Resume. It does not let the page reconnect by itself. After a refresh the live connection is gone. The visitor must click Resume, and `resumeAIAuthSession` asks the wallet to re-verify the consent and confirm the session still exists. A record for an ended session cannot revive it.

## postMessage checks

The page and wallet exchange messages only with a verified origin and source. The wallet sends `connect-ready` only to a verified origin: the origin of an already verified connect request, or, when there is no such request, the browser-provided referrer origin. The referrer comes from the browser and cannot be forged by page script. The signal is never posted to `"*"`. A site that hides the referrer gets no ready signal until a verified connect request arrives. Keep the referrer for the wallet frame.

The connect panel renders in a closed shadow root and shows only values from verified signed lifecycle events. The copyable connect instruction contains public data only: site origin, room, wallet URL, and requested capabilities.

For embedded transfers, the page **validates, bounds and forwards `target` and `messageId` when the wallet reports support**. It refuses a target if the wallet page did not report support, so a private message is never sent publicly by an older wallet. It forwards a receipt only for this connection's own wallet as sender. The wheel offers targeting and receipts only when the wallet reports `supportsTargets` and `supportsReceipts`.

## Idle and presence

For the idle clock, local cursor or scroll publishing does call `lease.touch()` through `connection.publishCursor()`. Inbound presence events (including `presence/cursor`) do not reset idle. A numeric session with no idle choice ends after 10 minutes without authorized activity.

## Code Mode limits

Code Mode is opt-in with `--code-mode` on `ai-auth-mcp`. It adds the `ai_auth_code` tool, which runs a short script in a worker thread against a restricted `aiAuth` API. A kill timeout stops a runaway script after 2 seconds, and the code is capped at 8 KiB. The worker thread and timeout are containment, not a security boundary. The MCP process keeps the host's privileges, and the sandbox is not a hard isolation layer. Do not run untrusted code with it.

## Revocation

There is no global, instant revocation and no AI Auth server that can push one. A signed revocation takes effect at a peer only when that peer receives and applies it. Live gossip and bounded catch-up spread records to peers that see them. A peer offline beyond the catch-up window does not converge. Protected operations also need a short-lived execution grant, at most 15 minutes, which bounds exposure. Open rooms never allow protected operations.

## Participation and privacy

Rooms are open or restricted. Open rooms let anyone who knows the origin and room name join. The room topic is a hash of app id, origin, and room. It is public metadata, not a secret or an access control. Restricted rooms require a site-issued membership proof from a trusted issuer.

Private mode joins a room without advertising presence or a cursor. It is not anonymity. Relays see participation and timing metadata, direct peers see the connection, and every signed event names the wallet. Screen capture cannot be redacted: a screenshot or recording shows whatever is visible in the picked surface.

## Recovery

There is no password reset service. The encrypted recovery file and its passphrase are the only way back to a browser wallet. Store the file away from the browser profile. See [wallet recovery](RECOVERY.md) and the full [wire protocol](protocol.md).
