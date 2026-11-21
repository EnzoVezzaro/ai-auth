# @enzovezzaro/ai-auth-mcp

A local MCP adapter for AI Auth. It exposes approved wallet actions to a coding agent over stdio or Streamable HTTP on loopback. It does not contact a hosted service. Version 0.3.9.

For the `ai-auth-mcp` command, its flags, the tool table and Code Mode, see the [MCP command guide](../../docs/mcp.md). For the runtime, keystore and reconnect behaviour, see the [agents guide](../../docs/agents.md).

## Build a server in process

```js
import { z } from "zod";
import {
  createAIAuthMcpServer,
  connectAIAuthMcpStdio,
} from "@enzovezzaro/ai-auth-mcp";

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
});

await connectAIAuthMcpStdio(server);
```

Each action declares a name, a description, a Zod input shape, a required capability and an executor. The adapter asks the host to approve a subset of the requested capabilities and registers only the actions that subset covers. It signs `started`, `completed` and `failed` action events with the supplied wallet.

The wallet must provide `id` and `sign(type, payload)`. `publicKey` is passed through to the host but is not validated. `createFileKeystore` from `@enzovezzaro/ai-auth-agent` provides a wallet for Node.

The MCP process runs with the host's privileges and is not sandboxed. Validate action inputs and outputs, and expose only tools the host can safely run.

## HTTP transport

`serveAIAuthMcpHttp` in this package serves Streamable HTTP on `127.0.0.1` at a path with a random secret. Anyone with the full URL can drive the agent, so treat the URL as a credential. The command line sets this up with `--http PORT`. See the [MCP guide](../../docs/mcp.md).
