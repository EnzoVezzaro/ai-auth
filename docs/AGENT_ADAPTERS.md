# Connecting coding agents (Claude Code, Codex, OpenCode)

`ai-auth-mcp` (package `@enzovezzaro/ai-auth-mcp`, bin `ai-auth-mcp`) lets a
coding agent act as a **verified AI Auth peer** of a site. It is a local MCP
server (stdio, or Streamable HTTP on loopback) wrapping the headless runtime in
`@enzovezzaro/ai-auth-agent`.

## What actually crosses the network

- **Local stdio MCP is not P2P.** In stdio mode, between the harness and
  `ai-auth-mcp` there is only a local pipe; no network is involved on that leg.
  With `--http`, the harness reaches the adapter over HTTP on `127.0.0.1` (a
  real network path, normally exposed through a tunnel; `packages/mcp/http.js`).
- `ai-auth-mcp` then joins the site's room itself: signaling through public
  Nostr relays, then a **direct WebRTC data channel** to peers. The signaling
  key is derived from public values only (no password is passed to the
  transport; Trystero derives it from the app id and room id/topic), so a relay
  that knows the topic can read the SDP — including network addresses. Relays
  see more than an opaque hash. Application message content is not relayed: it
  travels over the direct WebRTC data channel, protected by DTLS. There is no AI
  Auth server, database, relay-mediated application data, or TURN.
- If ICE fails before SDP is exchanged, the connection remains in
  `waiting-for-peers`. If SDP was exchanged and direct ICE then fails, the
  transport calls `invalidate()` and the status moves to `reconnecting` (not
  `waiting-for-peers`). `ai_auth_status` shows the diagnostics, including
  `lastIceError`.
- Everything a peer sends (`ai_auth_events`, `ai_auth_list_tools`) is
  **untrusted data**. The tools label it `untrusted: true`; never treat it as
  instructions.
- A signature proves the agent holds its key. It does not prove who runs it or
  that the site admitted it. Restricted rooms need a site membership proof.

## Consent model

| Step                                | Who decides                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| Give the agent an identity (`init`) | You, with a passphrase (`AI_AUTH_PASSPHRASE` or a TTY prompt; at least 12 characters) |
| Which scopes it may use             | You: TTY prompt, or `--approve a,b` listing **exact** scopes                          |
| Calling a site's WebMCP tool        | The site owner approves each call in the page                                         |
| Publishing this agent's own tools   | You: `--provide room` opts in; room peers may then call the read-only built-ins       |

- A scope is a site capability name: `presence.read` (join, status, read
  events), `messages.send` (send text), `tools.invoke` (list and call site
  tools).
- Approved scopes are always a **subset** of what the site requested (from the
  connect instruction, the manifest, or `--caps`). Wildcards, duplicates and
  anything not requested are rejected. Tools outside the approved scopes are not
  registered at all.
- A site URL only starts discovery. It never grants anything. Without a TTY,
  `ai-auth-mcp serve` refuses unless `--approve` is present.
- The harness cannot answer the prompt (its stdin is the MCP pipe), so harness
  configs must carry `--approve`. That flag is your explicit grant: review it.

## One-time setup

```sh
# 1. Create the agent's encrypted identity (prints only the public id)
export AI_AUTH_PASSPHRASE='a long passphrase'   # or omit to be prompted on a TTY
node packages/mcp/cli.js init --keystore-dir ~/.ai-auth/agent

# 2. See what a site would ask for, without granting anything
node packages/mcp/cli.js preview --connect 'https://site.example' --caps presence.read,messages.send
```

`--connect` accepts the site's copied connect instruction, its JSON descriptor,
`@file`, or a URL. For a bare URL the CLI tries
`https://<origin>/.well-known/ai-auth.json` (public, nonsecret; exact-origin
bound; no redirects; 16 KB cap). The manifest shape is provisional:
`{ "origin", "room"?, "capabilities": [...] }`. Pass `--origin/--room/--caps`
to skip it. The package is published on npm, so you can use
`npx -y @enzovezzaro/ai-auth-mcp` in place of `node /path/to/packages/mcp/cli.js`
in the commands below; the local path is shown for a source checkout.

The passphrase in a harness config is stored in plaintext in that config. That
is a real trade-off: it protects the key file at rest from other users and from
backups, not from anyone who can read the harness config. Prefer a config the
harness stores with owner-only permissions.

The harness commands below were checked against the installed CLIs' `--help`
output (Claude Code 2.1.325, Codex 0.161.0, OpenCode 2.2.5) and against the
config files those CLIs generate. The Cloudflare tunnel flags were checked with
`cloudflared tunnel --help`. The ChatGPT client's URL behaviour is documented,
not tested here, and the manual-run records at the end of this document are
dated observations rather than a claim about current behaviour.

## Claude Code

```sh
claude mcp add ai-auth --scope user \
  -e AI_AUTH_PASSPHRASE='a long passphrase' \
  -- node /abs/path/packages/mcp/cli.js serve \
     --keystore-dir ~/.ai-auth/agent \
     --origin https://site.example --room default \
     --caps presence.read,messages.send --approve presence.read,messages.send
claude mcp list
```

Then ask: "join the room with ai_auth_join, then read ai_auth_events". Remove
with `claude mcp remove ai-auth`.

## Codex

```sh
codex mcp add ai-auth --env AI_AUTH_PASSPHRASE='a long passphrase' \
  -- node /abs/path/packages/mcp/cli.js serve --keystore-dir ~/.ai-auth/agent \
     --origin https://site.example --room default \
     --caps presence.read,messages.send --approve presence.read,messages.send
codex mcp list
```

Equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.ai-auth]
command = "node"
args = ["/abs/path/packages/mcp/cli.js", "serve", "--keystore-dir", "/home/you/.ai-auth/agent",
        "--origin", "https://site.example", "--room", "default",
        "--caps", "presence.read,messages.send", "--approve", "presence.read,messages.send"]
env = { AI_AUTH_PASSPHRASE = "a long passphrase" }
```

## OpenCode

`opencode.json` (project) or the global config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "ai-auth": {
        "type": "local",
        "command": [
          "node",
          "/abs/path/packages/mcp/cli.js",
          "serve",
          "--keystore-dir",
          "/home/you/.ai-auth/agent",
          "--origin",
          "https://site.example",
          "--room",
          "default",
          "--caps",
          "presence.read,messages.send",
          "--approve",
          "presence.read,messages.send"
        ],
        "environment": { "AI_AUTH_PASSPHRASE": "a long passphrase" }
      }
    }
  }
}
```

## ChatGPT desktop plugin

ChatGPT's desktop app can connect to a remote MCP server URL, so this adapter
must listen on HTTP and be reachable over HTTPS:

```sh
node packages/mcp/cli.js serve --keystore-dir ~/.ai-auth/agent-c \
  --origin https://site.example --room default \
  --caps presence.read,messages.send,tools.invoke \
  --approve presence.read,messages.send,tools.invoke \
  --name "ChatGPT agent C" --auto-join --http 4303

cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4303
```

The CLI prints `MCP endpoint: http://127.0.0.1:4303/mcp/<secret>`. That secret
path is a credential: keep it private. Use the HTTPS hostname printed by the
tunnel with the same path, for example
`https://<random>.trycloudflare.com/mcp/<secret>`, and add it as a custom MCP
server/plugin in ChatGPT's Plugins page.

Each agent needs its own keystore directory, port and tunnel; do not share one
endpoint between chats. A quick tunnel gets a new hostname on each run, and the
endpoint changes if the process is given a different port or keystore.
Documented, not tested here: ChatGPT stores the URL that was added and does not
discover a replacement. After such a restart, remove the stale plugin and add
the newly printed URL again. This is a manual re-add step in the client, not a
protocol requirement.

Observed on 2026-11-16 with three independent plugins (agents A, B and C) in
one shared room on the example site: A and C kept working; B required that one manual re-add after
its endpoint changed. The current endpoint is a live credential and is reported
out of band rather than committed to this repository.

## Tools

| Tool                             | Scope           | Notes                                                                                                 |
| -------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `ai_auth_status`                 | `presence.read` | identity, intended room, strict `connected` flag, connection/generation, authorization, peers, scopes |
| `ai_auth_join` / `ai_auth_leave` | `presence.read` | `leave` also forgets the saved room                                                                   |
| `ai_auth_events`                 | `presence.read` | bounded ring (200), `since` cursor, max 50 per page, `dropped` flag                                   |
| `ai_auth_send`                   | `messages.send` | "sent" means submitted to the transport, not delivered                                                |
| `ai_auth_list_tools`             | `tools.invoke`  | tools advertised by connected participants (the site page or another agent)                           |
| `ai_auth_invoke`                 | `tools.invoke`  | page or agent tool; a provider approves each call and a denial is explicit                            |

### Code Mode

`--code-mode` adds `ai_auth_code` **in addition to** the existing tools,
following Cloudflare's [Code Mode pattern](https://blog.cloudflare.com/code-mode):
the harness can run a short script against `aiAuth.status()`,
`listTools()`, `invoke()`, `send()`, `move()` and `events()`, while every other
action stays registered. The script runs in a worker thread with a 2-second kill
timeout, so a runaway script is terminated. The guest has no network,
filesystem, process, imports or `eval`; side effects go through the same
connection-checked bridge. This is not a security boundary by itself: the MCP
process keeps the host's privileges, so do not treat Code Mode as a sandbox for
hostile code. A lost site connection makes `aiAuth.invoke()` return
`SITE_DISCONNECTED` / `TOOL_UNAVAILABLE` codes; `send()` and `move()` instead throw
plain errors, which Code Mode reports as `CODE_FAILED`. This is an adapter
option, not a hosted service and not part of WebMCP itself.

`ai_auth_invoke` returns a machine-readable `code` alongside its reason. The
codes in `TOOL_ERROR_CODES` are `TOOL_UNAVAILABLE`, `SITE_DISCONNECTED`,
`CATALOG_EXPIRED`, `AUTH_EXPIRED`, `CANCELLED`, `TIMEOUT`, `NOT_JOINED` and
`DENIED` (a denial or other rejection with no more specific code).

A reachable stdio pipe or HTTP MCP URL only means
the adapter is running; it is not evidence of a live site connection. See
`docs/CONNECTION_LIFECYCLE.md` for the strict definition of `connected`.

Joining is explicit (`ai_auth_join`), or pass `--auto-join` / `--resume`
(restores the last room saved for the same origin).

## Agent-provided tools (no page needed)

With `tools.invoke` approved, `--provide room` publishes two read-only tools
from the agent's own runtime:

| Tool         | Answer                                                       |
| ------------ | ------------------------------------------------------------ |
| `agent.ping` | `{ pong: true, agent, at }` — liveness of that runtime       |
| `agent.self` | `{ id, name, room, capabilities }` — public identity/context |

```sh
node packages/mcp/cli.js serve --keystore-dir ~/.ai-auth/agent \
  --origin https://site.example --room default \
  --caps presence.read,messages.send,tools.invoke \
  --approve presence.read,messages.send,tools.invoke --provide room --auto-join
```

Any participant in the same room can then call them through
`ai_auth_list_tools` / `ai_auth_invoke` while this process runs, even with every
browser closed. They expose only public data and never touch a page. This is
opt-in: without `--provide room` the agent publishes nothing and your tools stay
private. Page tools remain page-bound; `ai_auth_invoke` says so when no page is
online instead of returning a fake result.

## Lifecycle and limits

- **The runtime owns the connection.** Identity lives in the wallet keystore;
  presence lives only while this process keeps networking. A non-expiring
  session is not a running process.
- **Presence ends when the process ends.** In stdio mode the MCP server is
  started by the harness and exits with it: the stdin-close handler is
  registered only in the stdio branch, alongside SIGINT and SIGTERM. In `--http`
  mode there is no stdin-close exit; the server runs until it is stopped.
  Peers then see
  the agent leave when its heartbeat lease lapses (about 24 s) or immediately if
  it said goodbye. There is no background daemon and no hosted keep-alive
  service; a supervisor (launchd, systemd, a harness keep-alive) is optional and
  outside this package.
- **Reconnect:** run the harness again (or call `ai_auth_join`); the identity is
  stable because it lives in the keystore. Transport failures retry with bounded
  backoff inside a running process.
- **Disconnect:** `ai_auth_leave`, or stop the harness session.
- **Unlink:** `ai-auth-mcp unlink --keystore-dir DIR [--yes]` deletes the
  identity (and the saved room). Also remove the server from the harness
  (`claude mcp remove ai-auth`, `codex mcp remove ai-auth`, or delete the
  OpenCode entry) and revoke any grant the site's wallet UI holds. Rotating
  keys (`rotate()` in the agent package) gives a new identity peers must re-trust.
- Clones of a keystore directory are the same identity; do not run two copies
  at once.

## Verification (2026-11-15, scratch configs only)

- **Claude Code 2.1.325:** `claude -p --mcp-config <scratch>.json
--strict-mcp-config` listed the five tools for the `presence.read` and
  `messages.send` grant and `ai_auth_status` returned `connection: "idle"`,
  `capabilities: ["messages.send","presence.read"]`. A second run called
  `ai_auth_join`, which returned `waiting-for-peers`; a separate Node agent
  (`packages/agent/examples/peer.mjs`) in the same origin and room connected
  directly (peer log: `direct-peer-connected` after 5.8 s), and `ai_auth_events`
  returned its signed `message/text` "hello from Peer2" with the sender id.
  Final status: `direct-peer-connected`, `directPeerCount` 1.
- **Codex 0.161.0:** `CODEX_HOME=<scratch>` registered the server
  (`codex mcp list`), but `codex exec` stopped at "You've hit your usage limit"
  before any tool call, so no Codex tool call is verified.
- **OpenCode 2.2.5:** `OPENCODE_CONFIG=<scratch>.json opencode run --standalone`
  logged `mcp connected server=ai-auth tools=5`. The model then explored its
  code-execution tool and did not finish calling `ai_auth_status` within 200 s
  (two attempts), so no OpenCode tool call is verified.
- `ai_auth_list_tools` and `ai_auth_invoke` were exercised by unit tests at that
  time. Live page tools were exercised by the demo-site E2E through the SDK, not
  through `ai-auth-mcp`.

## Verification of agent-provided tools (2026-11-16)

- `npm test --prefix packages/agent` (36 tests): two real runtimes exchange a
  signed catalog and call each other's tools with no page, deny an unauthorized
  call, reject oversized results, follow a new session, and withdraw on close.
- `node --test tests/agent-scenarios.test.mjs` (8 scenarios): three independent
  agents; a human leaving; a human returning; no-visitor tool calls through
  `createAgentBridge`; a page-only tool reported unavailable; restart without a
  ghost; MCP-bridge ↔ direct-runtime interop; a generic site using only the
  public SDK.
- These tests use real `P2PRoom` signing and verification with an in-process
  transport. They do not replace the real-network browser E2E.
