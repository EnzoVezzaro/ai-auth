# Connection lifecycle, WebMCP ownership, and presence

AI Auth is a generic identity and connection protocol. It is independent of any
particular website, including Body4AI. Five concepts are deliberately separate:

| Concept       | Owner                                     | Lifetime                                 |
| ------------- | ----------------------------------------- | ---------------------------------------- |
| Identity      | The wallet                                | Until deleted or rotated                 |
| Authorization | The site and the wallet owner             | Until expiry, narrowing, or revocation   |
| Runtime       | The harness (ChatGPT, Codex, …)           | As long as that process runs             |
| Connection    | The runtime's authenticated P2P transport | A live transport session only            |
| WebMCP        | The website                               | While its endpoint/provider is available |

An identity can exist while disconnected. An authorized agent can lose its
connection. A connected agent can have zero tools. None of these facts implies
another.

## Strict `connected`

`connected` is true only when all of the following hold:

- a real data-channel peer exists (Trystero `onPeerJoin` / a live channel);
- the remote party is authenticated by a signed envelope for this origin,
  room, session, and nonce;
- the runtime's `connectionState.status` is `direct-peer-connected`;
- a fresh inbound heartbeat/lease exists; and
- authorization is `active` (not `expired` or `revoked`).

A wallet, saved room, consent grant, non-expiring session, MCP registration,
discovery event, tool catalog, or reachable HTTP endpoint cannot make
`connected` true. `ai_auth_status` now exposes both `connection` (the transport
state) and `connected` (the strict boolean), plus `generation`,
`authorization`, and `joinedRoom`. `room` is the _intended_ room, not proof of
membership.

States: `idle`, `approval-pending`, `wallet-authorized`, `connecting`,
`signaling`, `waiting-for-peers`, `direct-peer-connected`, `reconnecting`,
`degraded`, `expired`, `revoked`, `disconnected`. A temporary transport loss
moves out of `direct-peer-connected` immediately into `reconnecting`, or to
`disconnected` when retries run out. Expired or revoked authorization is checked
before any reconnect, so the connection does not come back.

## Liveness

`P2PRoom` signs and verifies heartbeats. Defaults: heartbeat every 8 s,
offline after 16 s, lease expiry 24 s; all configurable. A WebRTC data-channel
`close` or `error` now invalidates the providers that were reachable through it
immediately, instead of leaving them online until lease expiry. Transport
`peer-connect-failed` moves the connection to `reconnecting` rather than
leaving a stale `direct-peer-connected` label. Each successful `join()` gets a
new `session` (the connection generation); stale signed messages from an older
session are rejected by the normal verification path.

## Recovery

Reconnection uses bounded exponential backoff with jitter. On success the
runtime reauthenticates, re-validates authorization, verifies origin/room, and
re-announces its tool catalogs under the new session. It reports `connected`
only after those checks pass. Expired or revoked permissions are never renewed
automatically. Within one process, a wallet identity can back only one live
runtime; a copied keystore cannot silently impersonate a second runtime.
Cross-process lease coordination remains a documented limitation.

## WebMCP belongs to the website

AI Auth transports and authorizes website-owned tools; it does not define
application commands. The generic browser fixture uses `demo.echo` and
`demo.increment` to prove this. There are no Body4AI catalogs in AI Auth core.

A page tool catalog is bound to the site's wallet, room session, signed nonce,
expiry, and tool version. When the providing page closes, it stops refreshing its
catalog, and the last catalog expires within two minutes. `stop()` and `close()`
publish an empty catalog at once; a page that closes without calling them does
not. In-flight calls are rejected with `SITE_DISCONNECTED` when the site leaves
the room. Expired catalogs are pruned on read. Calls validate
input against the advertised schema, apply the site's own authorization gate,
and return the real executor result or a structured error. Stable error codes
are `TOOL_UNAVAILABLE`, `SITE_DISCONNECTED`, `CATALOG_EXPIRED`,
`AUTH_EXPIRED`, `CANCELLED`, `TIMEOUT`.

The optional MCP `--code-mode` flag follows Cloudflare's
[Code Mode pattern](https://blog.cloudflare.com/code-mode): a single sandboxed
`ai_auth_code` tool executes a short script against the connection-checked
`aiAuth` API. It changes how tools are presented to a model, not who owns them;
the website still owns its WebMCP schemas and approval policy.

Agent-provided tools (`provideTools`, `--provide room`) are owned by the runtime,
not the page. They survive browser closure but are withdrawn when their runtime
closes. `tool-cancel` now aborts in-flight agent-provider calls.

## Website lifecycle

- **Agent ↔ agent:** continues while both runtimes and their connections live.
- **Agent ↔ page endpoint:** ends when that browser page closes. A different
  site-provided runtime or independently reachable endpoint may take over; it
  must be explicitly provided, not assumed.
- **Page-only tools:** unavailable when the page is gone. Agent-owned tools are
  independent. No mandatory hosted AI Auth server was added; GitHub Pages
  remains static.

## Harness findings

| Harness            | Verified                                                                               | Limitation                                                                            |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Claude Code        | Model-initiated `ai_auth_status`, `ai_auth_join`, `ai_auth_events` against a live peer | One manual run                                                                        |
| ChatGPT (HTTP MCP) | Three plugins connected; tools called; `--http` endpoint + tunnel                      | Reachable URL ≠ site connection; quick-tunnel URL changes need a manual plugin re-add |
| Codex              | Server registration / tool discovery                                                   | No model-initiated call completed in the recorded run (usage limit)                   |
| OpenCode           | Server connected, tools listed                                                         | No model-initiated call completed in the recorded run                                 |

The adapter cannot keep a suspended harness process alive. There is no cached
or simulated permanent connection.
