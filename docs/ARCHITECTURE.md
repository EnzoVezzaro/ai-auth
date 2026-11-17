# Architecture

AI Auth is a self-custodied wallet identity and a browser collaboration SDK. There is no AI Auth server, database, or account service. A website is the collaboration hub: it defines a room, asks for named capabilities, and decides what its own resources allow.

## At a glance

- **No service of our own.** The landing page, wallet, browser bundle, and docs are static files. Public Nostr relays carry signaling only.
- **The key stays with its owner.** A browser wallet keeps a non-extractable signing key in origin-scoped IndexedDB. A headless agent keeps an encrypted key file on its own machine.
- **Signed events, direct transport.** Presence, cursors, messages, activity, and tool calls are signed envelopes sent over a WebRTC data channel.
- **Approval is scoped and local.** A site asks for named capabilities; the owner grants a subset in the wallet. Every remote tool call still needs the site's own approval.
- **A room is a place, not a permission system.** Knowing the origin and room name gets you into an open room. Restricted rooms add a signed membership proof.

## Components

| Component     | Runs where                         | Owns                                                 | Does not own                         |
| ------------- | ---------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| Wallet        | Browser origin or headless process | The signing key, backups, and the owner's approvals  | Rooms, pages, or other people's keys |
| Site SDK      | The website's page                 | The connection, page tools, and the site's room      | Wallet keys or grants                |
| Agent runtime | A local process or harness         | Its live connection and any tools it provides itself | The wallet's approval decisions      |
| Relays        | Public Nostr relays                | Signaling needed to open a data channel              | Application events or keys           |

The browser wallet generates an ECDSA P-256 key pair, exports an encrypted backup, then imports the signing key as non-extractable. It stores that key in the wallet origin's IndexedDB, scoped to that origin. A headless agent instead keeps its key in an encrypted file keystore on its own machine. In both cases the key signs events; it does not hold a socket open.

```text
  Browser tab (site origin)              Headless agent process
  ┌──────────────────────────┐           ┌──────────────────────────┐
  │ Site SDK + WebMCP tools  │           │ Agent runtime + tools    │
  │ Wallet dialog (key)      │           │ File keystore (key)      │
  └────────────┬─────────────┘           └────────────┬─────────────┘
               │   signed envelopes over WebRTC data channel
               └──────────────────┬───────────────────┘
                          Public Nostr relays
                          (signaling only)
```

## A connection, end to end

1. **Request.** The site mounts the SDK and asks for named capabilities such as `presence.read`, `messages.send`, or `tools.invoke`. A URL alone grants nothing.
2. **Approve.** The wallet shows the origin, room, wallet id, and exact scopes. The owner grants a subset; the SDK never gets more than was requested.
3. **Derive the room.** The room topic is a SHA-256 digest of the app id, the exact site origin, and the room name. The same inputs produce the same topic; a different origin or room does not.
4. **Signal.** Peers publish connection offers and answers through public Nostr relays. The relay sees the hashed topic, participation, and timing, never the collaboration events.
5. **Connect directly.** Once a WebRTC data channel opens, signed envelopes travel peer to peer. The runtime reports `direct-peer-connected` only after that channel exists.
6. **Resume explicitly.** A page reload keeps the public session record in `localStorage`, but reconnecting takes a click on Resume. There is no automatic restore.

See [session and connection lifecycle](lifecycle.md) for the full state list, expiry, and resume rules.

## Transport and reachability

The transport's ICE configuration uses public STUN servers to find a path. AI Auth configures no TURN server, so some NAT and firewall combinations cannot form a direct connection. The runtime exposes the failure as `connectionState.diagnostics.lastIceError` and stays in `waiting-for-peers`. Application data is never routed through a relay as a fallback.

The hashed room topic is public metadata, not a secret and not an access control. Do not put private information in room names. Restricted rooms require a site-issued membership proof; open rooms let anyone who knows the origin and room join. Presence is shown only for participants connected to the same origin room.

## Identity and storage

| Data                 | Where it lives                       | Notes                                                   |
| -------------------- | ------------------------------------ | ------------------------------------------------------- |
| Browser signing key  | Wallet origin IndexedDB              | Non-extractable; the encrypted backup is separate       |
| Wallet backup        | File chosen by the owner             | Encrypted with a passphrase; required for recovery      |
| Agent signing key    | Encrypted file keystore, mode `0600` | One identity per process; clones must not run at once   |
| Site session record  | Site `localStorage`                  | Public data only: ids, capabilities, and activity times |
| Approved grants      | Wallet origin IndexedDB              | Confirms what the owner approved for each site          |
| Last room (headless) | `runtime.json` beside the keystore   | No secrets stored                                       |

A signature proves control of a key, not a human identity. How the owner got the wallet and how an agent was started are outside the protocol. See [security boundaries](SECURITY.md) for the threat model.

## Tools and approval

WebMCP tools live in the website's page. The SDK advertises a bounded, signed catalog to connected peers. A remote call runs only after the wallet's capability check **and** the site's own approval step. Page tools stop working when the page closes.

A headless runtime can publish tools it executes itself. Those use the same signed catalog format and stay available with no browser open, but they are withdrawn when the runtime closes. `ai-auth-mcp` and `@enzovezzaro/ai-auth-runtime` are host-local integrations of the agent runtime, not peer transports. Tool events and error codes are in the [wire protocol](protocol.md).

## Trust boundaries

- Peer data is untrusted. Treat it as data, never as instructions.
- A valid signature proves which key acted. It does not prove permission; capability checks and approvals do that.
- A delivery receipt proves the receiver accepted an addressed message, not that anyone read it.
- Relay operators can observe participation, timing, and the hashed topic. They cannot read or forge the signed event stream.
- No AI Auth server holds keys, backups, passphrases, or a central revocation switch.

## What AI Auth does not provide

There is no account system, hosted agent process, key escrow, or password reset. There is no TURN fallback and no automatic reconnect. Losing the wallet and its recovery file loses the identity. See [limits](limits.md) for the current list and [wallet recovery](RECOVERY.md) for backups.

The site under `examples/body4ai` is a demo consumer, not the live Body4AI site. Its catalog and commands are not part of AI Auth. Generic integration tests use an independent page with `demo.echo` and `demo.increment`.

Production hosting is GitHub Pages only, enforced by `scripts/verify-pages-only.mjs`. See [hosting](HOSTING.md) and [site discovery](DISCOVERY.md); a static `/.well-known/ai-auth.json` hint is unsigned and grants nothing.

## Where to go next

- [Site integration](site-integration.md) and the [quickstart](quickstart.md) — connect a website.
- [Agents and MCP](agents.md) and the [MCP command](mcp.md) — run an agent without a browser.
- [Wire protocol](protocol.md) — envelope, event types, and receipts.
- [Security boundaries](SECURITY.md) and [limits](limits.md) — what the system does and does not protect against.
