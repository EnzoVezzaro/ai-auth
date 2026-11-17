# Session and connection lifecycle

An identity, a session, and a connection are different things. A wallet key can exist while nothing is running. A session can still be valid after the live connection has ended.

## States

`createConnectionState()` in `packages/p2p/connection-state.js` has an explicit transition table. Its states are `idle`, `approval-pending`, `wallet-authorized`, `connecting`, `signaling`, `waiting-for-peers`, `direct-peer-connected`, `reconnecting`, `degraded`, `expired`, `revoked`, and `disconnected`. Illegal transitions throw. The transport uses `tryTransition()`, which returns `false` instead of throwing from a network callback.

`direct-peer-connected` means a real WebRTC data channel is open and the peer is authenticated for this origin, room, session, and nonce. A saved wallet, a valid consent, a tool catalog, or a reachable endpoint cannot make that state true. A transport loss moves to `reconnecting`, then to `disconnected` if retries run out. Expired or revoked authorization is checked before any reconnect, so the connection does not come back.

## Sessions

A site sends a permission request with an exact origin, a one-use nonce, a room, and a list of capabilities. The wallet shows the request. The owner can untick capabilities, and the wallet signs only the accepted subset.

A request with no lifetime gets **Never** by default. That means no fixed end and no idle end. The wallet shows the choice, so the owner can pick 5, 15, 30, or 60 minutes instead. A site may set its own ceiling with `sessionTtlMs` and `idleTimeoutMs`. A numeric ceiling rules out Never. The signed consent comes from the wallet's choice, bounded by the site's ceiling.

The consent binds the origin, nonce, room, and capabilities. A site verifies all four plus the signature and expiry, then enforces its own resources. Capabilities are checked again on each signed event.

## Expiry and idle

A numeric session ends at its signed expiry. It also ends after 10 minutes without authorized activity when no idle timeout is set. Authorized activity is a message, a transfer, or a tool call. Local cursor or scroll publishing does call `lease.touch()` through `connection.publishCursor()`.

Inbound presence events (including `presence/cursor`) do not reset idle. Another participant's cursor or scroll cannot extend a session. Heartbeats keep presence visible, not the session alive.

When a session expires, idles out, or is ended, the connection closes. Publishing, receiving, transfers, and page tool calls stop. Peers see the identity as no longer live.

## Renewal

`connection.renew()` takes a fresh request back to the wallet owner. The owner must approve again. Renewal can keep the current capabilities or narrow them. It cannot add capabilities. An expired session cannot be renewed; it needs a new connection.

## Refresh and resume

A page refresh ends the live connection. It does not end the stored session record. The site record is kept in that origin's `localStorage` and holds public data only: the signed consent, the public key, capabilities, ids, and activity times. No private key is written there. The wallet keeps approved grants in its own IndexedDB.

`listResumableSessions` returns records that can still be resumed. It filters out expired, idle, foreign-origin, and tampered records. Show a Resume action to the visitor. After the visitor clicks it, call `resumeAIAuthSession`. The wallet re-verifies the consent and confirms the session still exists. A session the site or wallet ended cannot be revived. Resuming reuses the original grant. It does not re-grant or widen scope.

The SDK never resumes silently from a stored record. Automatic restore on page load is not available. See [limits](limits.md).

## Disconnect

`connection.close()` ends the session for the page. The runtime sends `peer/goodbye` where the transport allows it and drops its presence. A peer shows as offline after 16 seconds without a heartbeat and is removed after 24 seconds. A tab close ends that page's connection. An agent runtime in its own process keeps its own connection until that process stops.

## Revocation and epochs

There is no global revocation. A signed revocation takes effect at a peer only after that peer receives and applies it. Live gossip reaches the peers connected to the sender. On first sight of a peer, a bounded `revocation/sync` catch-up also sends the latest signed epoch and at most 32 recent revocations no older than 7 days. A peer offline longer than that does not fully converge.

Protected operations also need a short-lived execution grant. A peer that missed a revocation can only act until its stored grant expires.

A policy can bump the authorization epoch to invalidate older proofs and grants at that policy. Signed epoch announcements are propagated with `publishEpoch()` and included in catch-up, so epoch announcements are propagated to peers that receive them. The epoch is local state until a peer learns the new value through `observeEpoch` or catch-up.
