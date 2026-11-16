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

The handshake challenge is short lived (1–120 seconds) and single use. The session is a separate signed grant. By default it is Never: no fixed end and no idle end, so it stays active until the owner ends it, the site ends it, or it is revoked. The owner may instead choose 5, 15, 30 or 60 minutes; a numeric session has a 10 minute idle timeout by default. The signed grant comes from the wallet's choice, bounded by the site's own limit, never from the request alone: verifiers reject any consent that exceeds the request's numeric cap, and a Never consent unless the request allowed Never. The wallet shows the expiry and the user can end the session at any time.

When a session expires, idles out, or is ended by the wallet, the connection closes and publish, receive, transfer, and registered WebMCP tool calls stop. Idle time resets on authorized activity (messages, transfers, tool calls, and the local page’s own cursor or scroll). Presence events from other participants do not extend the session. A site may call `connection.renew()`; the wallet owner must approve again, and renewal can keep or narrow capabilities but never widen them. An expired session cannot be renewed and requires a new connection. Revocation is not broadcast; an ended session is enforced by the wallet and by the site SDK, and bounded expiry limits exposure for everything else.

## Connect instructions and panel

The copyable connect instruction produced by `createAIAuthConnectInstruction` contains only public data (site origin, room name, wallet URL, requested capabilities) and no credentials. The connect panel renders in a closed shadow root and displays only values taken from verified signed lifecycle events; its copy action writes that same public instruction to the clipboard and nothing else.

## Site/agent link lifecycle: what revocation means

There is no global revocation and no AI Auth server that can enforce one. A site link stops working only through these mechanisms:

- **Bounded expiry.** Every link proof carries `expiresAt`, at most 30 days after creation, and verifiers reject it afterwards.
- **Signed revocation events.** `unlink` produces a signed `ai-auth-link-revocation` event. It takes effect at a site only after the wallet (or the user) delivers it and the site records it in its own revoked set (`createRevokedLinkSet`). A site that never receives the event keeps honoring the link until it expires.
- **Site-side records.** The site can always refuse a link by deleting its own account mapping.

The wallet's local link list is only what that browser origin storage remembers; it is not proof the site still honors a link. Mapping a wallet identity to an account is owned by the site. The signature proves key possession, not human identity or site membership, and `subject` is a site-supplied claim. Link storage is a separate IndexedDB database (`ai-auth-wallet-links-v1`); `forgetWallet` clears its records along with the wallet, and key recovery or rotation yields a new wallet id that needs fresh links. The wallet trusts the origin given in a link challenge only as far as the transport that delivered it (popup or modal origin checks); the in-memory nonce store and revoked set are development defaults, lost on restart and not shared across instances. Production sites must supply durable implementations of the nonce store (`issue`/`consume`, atomic single-use) and the revoked set (`has`), or replay and revocation guarantees disappear on restart.

## Participation modes

A room is either **open** or **restricted**; the choice is explicit per room.

- **Open** (default, unchanged behavior): anyone who knows the site origin and room name can join, see public room content, and send events. The room topic is a SHA-256 hash of the app id, origin, and room name. It is public metadata on relays and is not a secret; it is not an access control. Open rooms are public, and sites should show `OPEN_ROOM_DISCLOSURE` (also available as `policy.disclosure` and `room.disclosure`) next to any open room.
- **Restricted**: a peer must present a membership proof (`ai-auth-membership`, v1) issued by a site or host key that the local `trustPolicy.issuers` list trusts. The proof is verified locally and binds issuer key, subject wallet id, exact origin, room, role, scopes, issue and expiry time (at most 24 hours without a duration kind; with one, the kind's limit applies: 1 hour short, 24 hours configured, 30 days long, 365 days until-revoked), and a unique id. A signature alone proves only key possession; membership comes from the proof.

In restricted rooms, the receiver drops every event from a wallet that has no valid, unrevoked proof whose subject is that wallet, before any listener (actions, tool calls, catalogs, transfers, chat) runs. A proof copied by another wallet fails the subject check; a proof for another room or origin fails the binding check. The sender does not deliver non-presence events to peers that have not proven membership, and a targeted send (`room.send(type, payload, { to })`) to a non-member is refused. Presence announcements (`peer/hello`, `peer/heartbeat`, `peer/goodbye`) still reach every direct peer, because they carry the proof and a display label; the label is never identity. Identity is the verified wallet key.

`remove(walletId)` revokes the admitting proof and takes effect on the next event; the host must issue a fresh proof to re-admit. `block(walletId)` is permanent for the policy instance. Roles (`owner`, `member`, `observer`) govern authorization; any human or agent label is only a claim. Observers may hold only `*.read` scopes.

Limits: membership is checked locally per receiver, proofs are bearer-bound to the subject but are not revoked remotely (use short lifetimes), and a member can still copy content it receives. The same-browser BroadcastChannel carries presence only in restricted rooms.

## Revocation, epochs, and execution grants: offline consistency limits

Authorization in a serverless, peer-to-peer system is eventually consistent. Read these limits before relying on revocation.

- **There is no global, instant revocation.** No AI Auth server can push one. A signed `ai-auth-revocation` record takes effect at a peer only when that peer receives, verifies and applies it. `createRevocationGossip` floods records to the peers connected to the sender, and those peers relay once. A peer that was offline, partitioned, or joined later receives nothing retroactively; there is no catch-up or history sync.
- **A peer that missed a revocation is bounded by the execution-grant TTL.** Protected operations require a live execution grant (at most 15 minutes, default 5). A peer that never learned of a revocation keeps honoring that identity until its stored grant expires and the site declines to renew it. Sites should choose a short grant TTL for sensitive scopes and stop renewing a revoked identity. Plain membership lifetimes are much longer (up to a year for `until-revoked`), which is why membership alone never authorizes protected operations.
- **Authorization epochs are local knowledge.** `bumpEpoch` invalidates older proofs and grants only at peers that learn the new epoch (`observeEpoch`, or by holding the policy that bumped it). Epoch values are not gossiped by this release.
- **Revocation authority.** A record counts only if signed by an issuer in the verifier's trust policy, or by a wallet revoking itself. A forged or wrong-room record is rejected and not relayed. Revocations are permanent for the life of the in-memory policy; durable storage across restarts is the site's responsibility, as with link nonces. The policy stores at most 4096 revocations and refuses more (`revocation-store-full`) rather than forgetting old ones.
- **Replay.** A record id is applied once; replays are no-ops. A revocation cannot be undone by replaying older state, but a site that loses its store loses the revocations.
- **Open rooms.** Open rooms have no membership, so wallet revocations only stop a key at peers that applied them; a revoked key can rejoin under a new key. Protected operations are never allowed in open rooms.
- **Agent descriptors** carry `provider`, `model`, `runtime` and `agentType` as claims, not attestations. Clone detection only sees what reaches the observing peer and is advisory.

## Interaction wheel privacy and delivery

- **Public room by default.** Everything sent from the wheel goes to peers in a public room, and recipients can save it. The wheel says so before each send.
- **Targets are addressing, not encryption.** A targeted message carries a signed `target`; honoring receivers drop it if it is not for them. Every directly connected peer still receives the packet, so a modified client can read it. Do not treat a target as confidentiality. The wheel offers a target only when the transfer layer enforces it (`supportsTargets`) and refuses to widen a targeted selection to everyone if the recipient goes offline.
- **Identity shown is a key fingerprint.** Recipients are listed by a short fingerprint derived from the verified wallet public key, never by a nickname. A fingerprint and a signature prove key possession only, not human identity or site membership.
- **Receipts prove a key signed an acknowledgement.** They do not prove a human read the content. See `WIRE_FORMAT.md`. Delivery status is never inferred from a successful transport call.
- **Sensitive page regions are blocked by default.** Elements that are password inputs, carry credential `autocomplete` tokens, are `contenteditable`, or sit inside `[data-private]` or `[data-ai-auth-private]` cannot be shared, and form control values are never included. Private descendants of a shared element are omitted from its text. Sites can mark regions with the two attributes.
- **Screen capture cannot be redacted.** Screenshots and recordings contain whatever is visible in the surface the user picks in the browser's `getDisplayMedia` picker. The wheel shows a preview and warns when the page has private regions, but it cannot mask them. Capture is only ever started by a click, is limited to 512 KiB (screenshots) and 1 MiB (recordings), and every track is stopped on completion, cancellation, close, expiry, and unmount.
- **The wheel is not an authorization path.** It only sends collaboration messages. It does not invoke WebMCP tools or site actions.
- **Embedded connections.** The site embed currently relays transfers through a postMessage proxy that does not carry targets or message ids. Through that path the wheel cannot target a recipient or confirm receipts, so it disables targeting and states that delivery cannot be confirmed.

## Catch-up, private presence, and what remains unsolved

- **Catch-up is bounded, not complete.** On first sight of a peer, peers exchange the latest signed epoch announcement and at most 32 recent revocation and link-revocation records no older than 7 days. All items are signature-verified and deduplicated; a forged or wrong-room item is dropped and noted in `diagnostics()`. A peer that was offline for longer than 7 days, or that missed more than 32 newer records, does not converge through gossip. Sites that need more must persist revocations themselves and pass them to `policy.applyRevocation` at startup. Until a peer converges it is still bounded by the execution-grant TTL for protected operations.
- **A sync responder is not an authority.** Anything a peer sends in a sync is verified against the local trust policy; a malicious peer can withhold records (denial) but cannot make a forged one apply.
- **Link revocations** are signed by the wallet that holds the link and are verified against the site origin. They stop a link at peers that receive them; there is still no global revocation.
- **Private presence is not anonymity.** A private participant sends no presence, heartbeat or cursor and appears in no peer list, and it cannot sign as anyone else. But joining the room is still visible to relays (topic participation) and to direct WebRTC peers; every event it sends names its wallet; in a restricted room it proves its membership to direct peers; and `membership/prove` and sync requests tell those peers it is there. Its actions are signed and logged locally (`room.audit()`); the log is not tamper-evident across restarts.
- **Protected tool execution is opt-in at the page.** `connectAIAuthModal` enforces `authorizeProtected` only when given a `participation` policy. Without one, remote tool requests rely on the site's human approval gate, as in 0.4.x. Open rooms never pass `authorizeProtected`.
- **Embed message forwarding.** The page validates and bounds `target` and `messageId` before forwarding them to the wallet, refuses a target if the wallet page did not report support (so a private message is never sent publicly by an older wallet), and forwards a delivery receipt only for this connection's own wallet as sender. The wallet verifies receipts' signatures; the page cannot, and trusts the wallet origin it already verified.
