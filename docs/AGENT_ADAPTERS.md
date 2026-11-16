# Connecting coding agents (Claude Code, Codex, OpenCode)

`ai-auth-mcp` (package `@enzovezzaro/ai-auth-mcp`, bin `ai-auth-mcp`) lets a
coding agent act as a **verified AI Auth peer** of a site. It is a local stdio
MCP server wrapping the headless runtime in `@enzovezzaro/ai-auth-agent`.

## What actually crosses the network

- **Local stdio MCP is not P2P.** Between the harness and `ai-auth-mcp` there is
  only a local pipe. No network is involved there.
- `ai-auth-mcp` then joins the site's room itself: signaling through public
  Nostr relays (they see hashed room topics and encrypted SDP, not content),
  then a **direct WebRTC data channel** to peers. No AI Auth server, database,
  relay-mediated application data, or TURN.
- If your network blocks peer candidates the connection stays in
  `waiting-for-peers`; `ai_auth_status` shows the diagnostics.
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
to skip it. After the package is published, replace
`node /path/to/packages/mcp/cli.js` below with `npx -y @enzovezzaro/ai-auth-mcp`.

The passphrase in a harness config is stored in plaintext in that config. That
is a real trade-off: it protects the key file at rest from other users and from
backups, not from anyone who can read the harness config. Prefer a config the
harness stores with owner-only permissions.

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
      "environment": { "AI_AUTH_PASSPHRASE": "a long passphrase" },
      "enabled": true
    }
  }
}
```

## Tools

| Tool                             | Scope           | Notes                                                                         |
| -------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| `ai_auth_status`                 | `presence.read` | identity, room, connection state, peers, granted scopes                       |
| `ai_auth_join` / `ai_auth_leave` | `presence.read` | `leave` also forgets the saved room                                           |
| `ai_auth_events`                 | `presence.read` | bounded ring (200), `since` cursor, max 50 per page, `dropped` flag           |
| `ai_auth_send`                   | `messages.send` | "sent" means submitted to the transport, not delivered                        |
| `ai_auth_list_tools`             | `tools.invoke`  | tools the connected site advertises                                           |
| `ai_auth_invoke`                 | `tools.invoke`  | site owner approves; a denial returns `{ ok: false, rejected: true, reason }` |

Joining is explicit (`ai_auth_join`), or pass `--auto-join` / `--resume`
(restores the last room saved for the same origin).

## Lifecycle and limits

- **Presence ends when the process ends.** The MCP server is started by the
  harness and exits with it (or on stdin close, SIGINT, SIGTERM). Peers then see
  the agent leave when its heartbeat lease lapses (about 24 s) or immediately if
  it said goodbye. There is no background daemon. A supervisor (launchd,
  systemd, a harness keep-alive) is optional and outside this package.
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
- `ai_auth_list_tools` and `ai_auth_invoke` were exercised by unit tests only,
  not against a live site page.
