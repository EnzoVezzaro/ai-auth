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

The handshake challenge is short lived (1–120 seconds) and single use. The session is a separate signed grant: 30 minutes by default, 60 minutes at most, with a 10 minute idle timeout by default. The signed expiry comes from the wallet's bounded grant, never from the request, so a site cannot extend its own session; verifiers reject any consent over the cap or over the request's own hint. The wallet shows the expiry and the user can end the session at any time.

When a session expires, idles out, or is ended by the wallet, the connection closes and publish, receive, transfer, and registered WebMCP tool calls stop. Idle time counts only authorized activity, not passive presence traffic. A site may call `connection.renew()`; the wallet owner must approve again, and renewal can keep or narrow capabilities but never widen them. An expired session cannot be renewed and requires a new connection. Revocation is not broadcast; an ended session is enforced by the wallet and by the site SDK, and bounded expiry limits exposure for everything else.

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
- **Restricted**: a peer must present a membership proof (`ai-auth-membership`, v1) issued by a site or host key that the local `trustPolicy.issuers` list trusts. The proof is verified locally and binds issuer key, subject wallet id, exact origin, room, role, scopes, issue and expiry time (at most 24 hours), and a unique id. A signature alone proves only key possession; membership comes from the proof.

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
