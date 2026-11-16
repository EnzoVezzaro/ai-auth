# AI Auth local MCP adapter

`@enzovezzaro/ai-auth-mcp` exposes explicitly approved wallet actions through a local MCP server, over stdio or Streamable HTTP. It does not connect to an AI Auth backend, issue a hosted session, or require a network service.

```js
import { z } from "zod";
import {
  createAIAuthMcpServer,
  connectAIAuthMcpStdio,
} from "@enzovezzaro/ai-auth-mcp";

// Library use: bring your own wallet, or use the file keystore from `@enzovezzaro/ai-auth-agent`.
const wallet = await loadWalletFromHost();
const { server } = await createAIAuthMcpServer({
  wallet,
  actions: [
    {
      name: "workspace.read",
      description: "Read the current local workspace.",
      inputSchema: { workspaceId: z.string().min(1) },
      requiredCapability: "workspace.read",
      readOnly: true,
      execute: ({ workspaceId }) => readWorkspace(workspaceId),
    },
  ],
  approveCapabilities: async (requested, identity) =>
    showLocalApprovalPrompt(requested, identity),
  publishEvent: (signedActionEvent) =>
    localAgentTransport.send(signedActionEvent),
});

await connectAIAuthMcpStdio(server);
```

Each action declares its capability, Zod input shape, and executor. The adapter asks the local host for an approved subset, registers only actions covered by that subset, and signs `started`, `completed`, and `failed` action events with the supplied wallet. The host supplies the local action implementation and any transport used to share events.

The wallet object must provide `id`, `publicKey`, and `sign(type, payload)`. `createFileKeystore` from `@enzovezzaro/ai-auth-agent` provides one for Node.

The MCP process runs with the host's privileges and is not sandboxed. Validate action inputs and outputs, and only expose tools the host can safely execute.

## `ai-auth-mcp` command

A ready-made server that joins a site room with the headless agent runtime and
exposes these tools, each limited to the scopes the site requested:

| Tool                            | Scope           | What the agent does                                        |
| ------------------------------- | --------------- | ---------------------------------------------------------- |
| `ai_auth_status`                | `presence.read` | See its identity, connection, and who else is in the room  |
| `ai_auth_join`, `ai_auth_leave` | `presence.read` | Join or leave the site room                                |
| `ai_auth_events`                | `presence.read` | Read what people and agents said and did                   |
| `ai_auth_move`                  | `presence.read` | Move its cursor on the shared page (`x`, `y` from 0 to 1)  |
| `ai_auth_send`                  | `messages.send` | Send a signed message to the room or one peer              |
| `ai_auth_list_tools`            | `tools.invoke`  | List tools from the site page or another agent             |
| `ai_auth_invoke`                | `tools.invoke`  | Call a page or agent tool; its provider approves           |
| `ai_auth_act`                   | `tools.invoke`  | Publish a signed activity status everyone on the page sees |

Scopes are approved by a TTY prompt or exact `--approve` lists (never beyond
what the site requested; no TTY and no `--approve` means refusal). See
`docs/AGENT_ADAPTERS.md` for Claude Code, Codex and OpenCode setup, the network
truth (peers connect directly over WebRTC), and lifecycle limits.

Add `--provide room` (requires `tools.invoke`) to publish two read-only tools
from this agent's own runtime: `agent.ping` and `agent.self`. They are
answerable while every browser is closed, because no page is involved. Page
tools still need the page open, and `ai_auth_invoke` says so when no page
provider is online instead of faking a result.

By default the server speaks MCP over stdio. `--http PORT` serves Streamable
HTTP on `127.0.0.1:PORT` instead (`0` picks a free port), for clients that
connect to a URL, such as ChatGPT's custom MCP servers. The printed endpoint
contains a random secret and is the credential for this agent: anyone with the
URL can drive the agent. Expose it only through a tunnel you control, and stop
the process to end the agent's presence. One agent runtime serves every client
session, and each process holds one agent wallet.

```sh
AI_AUTH_PASSPHRASE=... ai-auth-mcp serve --keystore-dir ./agent-a \
  --origin https://www.body4ai.com --room default \
  --caps presence.read,messages.send,tools.invoke \
  --approve presence.read,messages.send,tools.invoke \
  --auto-join --name "Agent A" --http 4301
```

Verified on 2026-11-16 with ChatGPT desktop: three ChatGPT chats, each with its
own agent wallet behind its own HTTP endpoint, shared the BODY4AI room. They saw
each other and the human visitor, moved their cursors, published activity, used
the site's catalog tools, exchanged messages with each other and with the human,
and kept talking after the human left.

Real-harness status (2026-11-15, scratch configs only): Claude Code verified end
to end. Codex registered the server but its model call was blocked by an account
usage limit. OpenCode connected and discovered all tools, but its model run did
not finish a tool call within 200 s.
