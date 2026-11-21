# Session and connection lifecycle

An identity, a session, and a connection are different things. A wallet key can exist while nothing is running. A session can still be valid after the live connection has ended.

## States

`createConnectionState()` in `packages/p2p/connection-state.js` has an explicit transition table. Its states are `idle`, `approval-pending`, `wallet-authorized`, `connecting`, `signaling`, `waiting-for-peers`, `direct-peer-connected`, `reconnecting`, `degraded`, `expired`, `revoked`, and `disconnected`. Illegal transitions throw. The transport uses `tryTransition()`, which returns `false` instead of throwing from a network callback.

`direct-peer-connected` means a real WebRTC data channel is open and the peer is authenticated for this origin, room, session, and nonce. A saved wallet, a valid consent, a tool catalog, or a reachable endpoint cannot make that state true. A transport loss moves to `reconnecting`, then to `disconnected` if retries run out. Expired or revoked authorization is checked before any reconnect, so the connection does not come back.

## Sessions

A site sends a permission request with an exact origin, a one-use nonce, a room, and a list of capabilities. The wallet shows the request. The owner can untick capabilities, and the wallet signs only the accepted subset.

At the protocol level, a request with no lifetime gets **Never**: an omitted `sessionTtlMs` in `approvePermissionRequest` still means no fixed end and no idle end. That default is unchanged. In the approval UI the wallet pre-selects a bounded **30-minute** session (or the site's smaller cap) on first use. The owner can still pick 5, 15, 30, or 60 minutes, or the explicit **Until I disconnect** choice. A site may set its own ceiling with `sessionTtlMs` and `idleTimeoutMs`. A numeric ceiling rules out Never. The signed consent always comes from the owner's selected value, bounded by the site's ceiling; the pre-selection alone is never signed.

The consent binds the origin, nonce, room, and capabilities. A site verifies all four plus the signature and expiry, then enforces its own resources. Capabilities are checked again on each signed event.

### Design decision: bounded first-use default (P1-15)

**Status: RESOLVED by security review.** The change is in the wallet approval UI only. The protocol default, `sessionLimits`, signature and consent verification, saved grants and resume behavior are unchanged.

**Decision.** When the site allows unlimited duration and the wallet has no open saved grant for the same **origin + room + scopes**, the duration selector pre-selects **30 minutes**, or the site's numeric cap when it is shorter. The unlimited option stays visible as **"Until I disconnect — no automatic expiry"** with value `never`. Selecting it still signs `sessionTtlMs: null` and verifies when the site's policy allows Never. A saved relationship for the same origin, room and scopes keeps its previous pre-selection, so returning owners, renewals, resume and already stored grants behave exactly as before. Revoked, expired or other-wallet grants do not count as saved, so a fresh approval after revocation gets the bounded default too.

**Security justification.** An indefinite authorization persists until the owner ends it, the site ends it or it is revoked. A first-time owner can accept it without noticing how long access lasts, and the grant can outlive the task it was issued for. Revocation is eventually consistent: an offline peer applies it only when it receives and verifies the signed record, so an unbounded grant leaves an unbounded exposure window until propagation. Authorization validity is also independent of liveness — a site with no live data channel can still hold a valid grant, so "offline" never means "unauthorized". A bounded first session puts a signed end in the grant before any expanded trust exists. It does not change capability approval, nonce verification, origin/room binding or revocation: the owner still chooses and signs the scopes, and an explicit unlimited choice is always available when policy permits it.

**Compatibility.** Explicit `sessionTtlMs: null` keeps its protocol meaning (Never when the site allows it and the owner chooses it). Sites that only accept numeric caps are unaffected: the pre-selection was already bounded. Existing grants are never rewritten; this changes only which option is highlighted before a new consent is signed. `connection.renew()` still keeps or narrows scopes only, and saved sessions resume with the original grant.

## Expiry and idle

A numeric session ends at its signed expiry. It also ends after 10 minutes without authorized activity when no idle timeout is set. Authorized activity is any accepted signed non-presence event: a message, a transfer, a tool call, a receipt, an agent action, or a revocation gossip message. Inbound presence events are the exception. Local cursor or scroll publishing does call `lease.touch()` through `connection.publishCursor()`.

Inbound presence events (including `presence/cursor`) do not reset idle. Another participant's cursor or scroll cannot extend a session. Heartbeats keep presence visible, not the session alive.

When a session expires, idles out, or is ended, the connection closes. Publishing, receiving, transfers, and page tool calls stop. Peers see the identity as no longer live.

## Renewal

`connection.renew()` takes a fresh request back to the wallet owner. The owner must approve again. Renewal can keep the current capabilities or narrow them. It cannot add capabilities. An expired session cannot be renewed; it needs a new connection.

## Refresh and resume

A page refresh ends the live connection. It does not end the stored session record. The site record is kept in that origin's `localStorage` and holds public data only: the signed consent, the public key, capabilities, ids, and activity times. No private key is written there. The wallet keeps approved grants in its own IndexedDB.

`listResumableSessions` returns records that are locally valid for resume: it filters out expired, idle, foreign-origin, and tampered records. It cannot see the wallet's grant state, so a listed record can still be rejected on confirmation. Show a Resume action to the visitor. After the visitor clicks it, call `resumeAIAuthSession`. The wallet re-verifies the consent and confirms the session still exists. A session the site or wallet ended cannot be revived. Resuming reuses the original grant. It does not re-grant or widen scope.

The SDK never resumes silently from a stored record. Automatic restore on page load is not available. See [limits](limits.md).

## Disconnect

`connection.close()` ends the session for the page. The runtime sends `peer/goodbye` where the transport allows it and drops its presence. A peer shows as offline after 16 seconds without a heartbeat and is removed from the peer registry after 24 seconds; the site's cursor overlay removes a stale cursor after 60 seconds. A tab close ends that page's connection. An agent runtime in its own process keeps its own connection until that process stops.

## Revocation and epochs

There is no global revocation. A signed revocation takes effect at a peer only after that peer receives and applies it. Live gossip reaches the peers connected to the sender. On first sight of a peer, a bounded `revocation/sync` catch-up also sends the latest signed epoch and at most 32 recent revocations no older than 7 days. A peer offline longer than that does not fully converge.

Protected operations also need a short-lived execution grant. A peer that missed a revocation can only act until its stored grant expires.

A policy can bump the authorization epoch to invalidate older proofs and grants at that policy. Signed epoch announcements are propagated with `publishEpoch()` and included in catch-up, so epoch announcements are propagated to peers that receive them. The epoch is local state until a peer learns the new value through `observeEpoch` or catch-up.
