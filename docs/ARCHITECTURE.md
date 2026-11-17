# Architecture

AI Auth is a self-custodied wallet identity and a browser collaboration SDK. There is no AI Auth server, database, or account service. A website is the collaboration hub: it defines a room, asks for named capabilities, and decides what its own resources allow.

## Components

| Component     | Runs where                         | Owns                                                 |
| ------------- | ---------------------------------- | ---------------------------------------------------- |
| Wallet        | Browser origin or headless process | The signing key and the owner's approvals            |
| Site SDK      | The website's page                 | The connection, page tools, and the site's room      |
| Agent runtime | A local process or harness         | Its live connection and any tools it provides itself |
| Relays        | Public Nostr relays                | Signaling only                                       |

The browser wallet keeps a non-extractable ECDSA P-256 key in origin-scoped IndexedDB. A headless agent keeps its key in an encrypted file keystore on its own machine. The key signs events. It does not keep a socket open.

## Transport

Peers find each other through a room topic derived from the app id, the exact site origin, and the room name. Public Nostr relays carry the signaling needed to set up a WebRTC data channel. Signed presence, cursor, message, and tool events go directly over that channel. Relays never receive the collaboration event stream.

Relay operators can see participation, timing, and the hashed topic. The hash is public metadata, not a secret and not an access control. Do not put private information in room names.

Direct WebRTC uses public STUN servers to find a path. No TURN server is configured. Some NATs and firewalls will block a direct connection. The runtime reports the ICE failure in `connectionState.diagnostics` and stays in `waiting-for-peers`. Application data is not routed through a relay as a fallback.

A room is a place, not a permission system. Open rooms let anyone who knows the origin and room join. Restricted rooms require a site-issued membership proof. Presence is shown only for participants connected to the same origin room.

## What the server does and does not hold

AI Auth operates no application server. No server holds wallet keys, backups, or passphrases. There is no hosted agent process and no central revocation switch. The landing page, wallet, browser bundle, and documentation are static files. Production hosting is GitHub Pages only, enforced by `scripts/verify-pages-only.mjs`. See [hosting](HOSTING.md).

A site may publish a static `/.well-known/ai-auth.json` discovery hint. It is unsigned and grants nothing. See [discovery](DISCOVERY.md).

## Tools

WebMCP tools live in the website's page. The SDK advertises a bounded signed catalog to connected peers. Each remote call needs wallet scope checks and the site's human approval. Page tools stop working when the page closes.

A headless runtime can publish tools it executes itself. Those use the same signed catalog format, stay available with no browser open, and are withdrawn when the runtime closes. `ai-auth-mcp` and `@enzovezzaro/ai-auth-runtime` are host-local integrations, not peer transports. See the [wire protocol](protocol.md) for tool events and error codes.

## Scope of this project

AI Auth is a generic protocol. The site under `examples/body4ai` is a demo consumer, not the live Body4AI site. Its product catalog and commands are not part of AI Auth. Generic integration tests use an independent page with `demo.echo` and `demo.increment`.

For states, sessions, refresh, and resume, see [session and connection lifecycle](lifecycle.md). For trust limits, see [security boundaries](SECURITY.md) and [limits](limits.md).
