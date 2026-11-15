# AI Auth local MCP adapter

`@enzovezzaro/ai-auth-mcp` exposes explicitly approved wallet actions through a local MCP stdio server. It does not connect to an AI Auth backend, issue a hosted session, or require a network service.

```js
import { z } from "zod";
import {
  createAIAuthMcpServer,
  connectAIAuthMcpStdio,
} from "@enzovezzaro/ai-auth-mcp";

// Implement this host-specific adapter; this package does not provide a Node keystore.
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

The wallet object must provide `id`, `publicKey`, and `sign(type, payload)`. The browser wallet package stores keys in IndexedDB and does not provide Node storage; connect a host-managed local key store or signing provider before starting this stdio server.

The MCP process runs with the host's privileges and is not sandboxed. Validate action inputs and outputs, and only expose tools the host can safely execute.
