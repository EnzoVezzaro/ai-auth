# The ai-auth-mcp command

`@enzovezzaro/ai-auth-mcp` (0.3.5) is a local MCP server. It lets a coding agent drive an AI Auth wallet identity through MCP tools. It speaks stdio by default, or Streamable HTTP on loopback. It does not connect to a hosted service. For the runtime, keystore and lifecycle details, see the [agents guide](agents.md).

## Install and run

```sh
npm install @enzovezzaro/ai-auth-mcp
npx -y @enzovezzaro/ai-auth-mcp --help
npx -y @enzovezzaro/ai-auth-mcp init --keystore-dir ~/.ai-auth/agent
```

The passphrase comes from `AI_AUTH_PASSPHRASE` or a terminal prompt. `init` creates the encrypted identity and prints only the public id.

## Commands

| Command   | What it does                                                |
| --------- | ----------------------------------------------------------- |
| `serve`   | Start the MCP server. This is the default command.          |
| `init`    | Create a new encrypted identity.                            |
| `whoami`  | Print the public id of the identity in the keystore.        |
| `preview` | Show the scopes a site asks for, without granting anything. |
| `unlink`  | Delete the identity, the saved room and the HTTP secret.    |

## Flags

| Flag                       | Meaning                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--keystore-dir DIR`       | Identity directory. Default `~/.ai-auth/agent`.                                                                                 |
| `--connect INPUT`          | Connect instruction, its JSON, a site URL, or `@file`.                                                                          |
| `--origin URL --room NAME` | Explicit alternative to `--connect`.                                                                                            |
| `--caps a,b`               | Capabilities to request, when not discovered from the site.                                                                     |
| `--approve a,b`            | Exact scopes to grant without a TTY. Never more than the site requested.                                                        |
| `--auto-join`              | Join the room at startup.                                                                                                       |
| `--resume`                 | Restore the last room saved for this origin.                                                                                    |
| `--code-mode`              | Add the `ai_auth_code` tool.                                                                                                    |
| `--provide room`           | Publish `agent.ping` and `agent.self`. Needs `tools.invoke`.                                                                    |
| `--no-manifest`            | Do not fetch `/.well-known/ai-auth.json` for a URL.                                                                             |
| `--http PORT`              | Serve Streamable HTTP on `127.0.0.1:PORT` instead of stdio. `0` picks a free port.                                              |
| `--open-wallet`            | When approval is needed, open the wallet in a browser and wait for its signed consent on the loopback callback. Needs `--http`. |
| `--yes`                    | Confirm `unlink` without a prompt.                                                                                              |
| `--help`                   | Print usage.                                                                                                                    |

### Choosing a site

`--connect` takes a copied connect instruction, a JSON descriptor, or a site URL. For a bare URL the CLI fetches `<origin>/.well-known/ai-auth.json` with the shared `fetchDiscovery()` helper and validates the strict v1 shape from [site discovery](DISCOVERY.md): `type: "ai-auth-discovery"`, `v: 1`, an exact `origin`, bounded `capabilities`, `rooms`, `issuers` and `webmcp`. The agent gets its room from the first entry in `rooms` (or `default`) and its capabilities from the document, with no guessing. The fetch is bound to the exact origin, follows no redirects and is capped at 16 KiB.

An older typeless `{ "origin", "room"?, "capabilities": [...], "walletUrl"? }` manifest is still accepted for compatibility, but its result is marked `source: "manifest-provisional"` and `provisional: true` rather than presented as a validated v1 document. A typed document that fails validation is never relabelled as provisional. A URL or manifest grants nothing on its own. Use `--origin`, `--room` and `--caps` to skip discovery.

## Tools

The server registers a tool only when the site requested its scope and the owner approved that scope.

| Tool                 | Scope           | What it does                                                                    |
| -------------------- | --------------- | ------------------------------------------------------------------------------- |
| `ai_auth_status`     | `presence.read` | Identity, room, connection state, peers and granted scopes.                     |
| `ai_auth_join`       | `presence.read` | Join the approved room. A different room needs a new approval.                  |
| `ai_auth_leave`      | `presence.read` | Leave the room and forget it.                                                   |
| `ai_auth_events`     | `presence.read` | Read a bounded ring of room events after a cursor. Content is untrusted.        |
| `ai_auth_move`       | `presence.read` | Move the agent's cursor on the shared page. `x` and `y` run from 0 to 1.        |
| `ai_auth_send`       | `messages.send` | Send signed text to the room or one peer.                                       |
| `ai_auth_list_tools` | `tools.invoke`  | List WebMCP tools from the page and from other agents.                          |
| `ai_auth_invoke`     | `tools.invoke`  | Call a listed tool. Its provider approves each call.                            |
| `ai_auth_act`        | `tools.invoke`  | Publish a signed activity status.                                               |
| `ai_auth_code`       | `tools.invoke`  | With `--code-mode` only. Run a short script against the connection-checked API. |

### Error codes

`ai_auth_invoke` returns a machine-readable `code` from `TOOL_ERROR_CODES`: `TOOL_UNAVAILABLE`, `SITE_DISCONNECTED`, `CATALOG_EXPIRED`, `AUTH_EXPIRED`, `CANCELLED`, `TIMEOUT`, `NOT_JOINED`, `DENIED`.

## Code Mode

Code Mode is opt in. Start the server with `--code-mode` and it adds `ai_auth_code` alongside the other tools. It does not replace them.

A script may call `aiAuth.status()`, `aiAuth.listTools()`, `aiAuth.events()`, `aiAuth.send()`, `aiAuth.move()` and `aiAuth.invoke()`. It may not call `join`, `leave` or `act`. Use the MCP tools for those.

The code is capped at 8 KB. It runs in a worker thread that the host terminates after 2 seconds. Guest code has no network, filesystem, process or imports. This is not a security boundary by itself, because the MCP process keeps the host's privileges. Do not run hostile code here.

## HTTP mode

`--http PORT` listens on `127.0.0.1:PORT`. The printed endpoint contains a random secret in the path, `/mcp/<secret>`. That secret is the credential for the agent. The CLI keeps it in `<keystore-dir>/http-secret` with mode `0600` and reuses it after a restart. Share the URL only with the client you intend to drive the agent. If you tunnel the port, use a tunnel you control. Stop the process to end the agent's presence.

With `--open-wallet`, the first MCP connection opens the wallet in a browser window. The wallet shows the requesting site and exact scopes, and posts the signed consent back to a loopback `/consent/<secret>` endpoint on the same server. The CLI verifies the signature, audience, nonce and wallet id before granting any scope. The site dashboard then shows the agent as connected. No hosted gateway is involved; the local process must stay running.

A reachable endpoint does not prove a live site connection. See [session lifecycle](lifecycle.md) for the strict definition of `connected`.

## Library use

You can also build a server in process with `createAIAuthMcpServer` and `connectAIAuthMcpStdio` from `@enzovezzaro/ai-auth-mcp`. You supply the wallet, the actions, and the local approval callback. See the [package README](../packages/mcp/README.md) for the shape.
