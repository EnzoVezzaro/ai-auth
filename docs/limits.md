# Limits and not yet available

These are the current limits. They are stated plainly so a site can plan around them.

## Automatic restore is not available

The SDK does not restore a session automatically on page load. Browser storage partitioning prevents an embedded wallet from silently checking stored records. After a refresh, the page offers a Resume action. The visitor clicks it, and the wallet confirms the session. `listResumableSessions` and `resumeAIAuthSession` support that one-click flow. The SDK never resumes on its own.

## A refresh or tab close ends the live connection

The stored session record survives a refresh. The live WebRTC connection does not. A resume rebuilds the connection; it does not bring back the old one. Agent runtimes in their own processes keep their own connections until those processes stop.

## No TURN server

Direct WebRTC uses public STUN servers. There is no TURN service. Some NAT and firewall combinations cannot form a direct path. The runtime reports the failure and stays in `waiting-for-peers`. Application data is not sent through a relay as a fallback.

## Relays are needed to signal

Peers need public Nostr relays to discover each other and set up the WebRTC path. Without signaling they cannot meet. Relays see participation, timing, and the room-topic hash. They never carry the signed collaboration events.

## Presence needs the same origin room

A participant appears in a presence list only when it is connected to the same origin and room. A different origin or a different room name is a separate space. Private mode removes presence and cursor announcements, but it is not anonymity.

## Code Mode is not a security boundary

`ai_auth_code` is opt-in with `--code-mode`. Guest code runs in a worker thread with a 2-second kill timeout. The worker and timeout bound a runaway script. They do not isolate the host. The MCP process keeps its host privileges, so do not treat Code Mode as a sandbox for untrusted code.

## No server holds keys

There is no AI Auth account server and no key escrow. Browser keys stay in origin-scoped IndexedDB. Agent keys stay in a local encrypted keystore. Losing the wallet and its recovery file loses the identity. There is no password reset service. See [wallet recovery](RECOVERY.md).

## Revocation is eventually consistent

A signed revocation takes effect only at peers that receive and apply it. Live gossip and bounded catch-up help peers that are present, but a peer offline beyond the catch-up window does not fully converge. Short execution grants limit the exposure. Open rooms do not allow protected operations. See [security boundaries](SECURITY.md).
