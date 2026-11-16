# AI Auth local MCP adapter

`@enzovezzaro/ai-auth-mcp` exposes explicitly approved wallet actions through a local MCP stdio server. It does not connect to an AI Auth backend, issue a hosted session, or require a network service.

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

A ready-made stdio server that joins a site room with the headless agent
runtime and exposes `ai_auth_status`, `ai_auth_join`, `ai_auth_leave`,
`ai_auth_send`, `ai_auth_events`, `ai_auth_list_tools` and `ai_auth_invoke`.
Scopes are approved by a TTY prompt or exact `--approve` lists (never beyond
what the site requested; no TTY and no `--approve` means refusal). See
`docs/AGENT_ADAPTERS.md` for Claude Code, Codex and OpenCode setup, the network
truth (stdio is local; peers connect directly over WebRTC), and lifecycle limits.

Real-harness status (2026-11-15, scratch configs only): Claude Code verified end
to end. Codex registered the server but its model call was blocked by an account
usage limit. OpenCode connected and discovered all tools, but its model run did
not finish a tool call within 200 s.
