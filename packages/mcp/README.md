# `@enzovezzaro/ai-auth-mcp`

Wallet-approved MCP tools for the AI Auth shared-state service. The package runs as a local MCP server over stdio; it does not host an authentication service or store wallet keys.

## Integration model

The host application supplies a locally managed wallet, the `@enzovezzaro/ai-auth-wallet/service` client, and an approval callback. The callback receives the requested capability list and the wallet's public identity. It must obtain user or local policy approval before returning the approved subset. The package then signs a service challenge with the wallet and exposes only tools covered by the resulting short-lived session.

```js
import {
  connectAIAuthMcpStdio,
  createAIAuthMcpServer,
} from "@enzovezzaro/ai-auth-mcp";
import { createServiceClient } from "@enzovezzaro/ai-auth-wallet/service";

const wallet = await loadWalletFromYourLocalSecureWallet();
const serviceClient = createServiceClient({
  baseUrl: process.env.AI_AUTH_SERVICE_URL,
  audience: process.env.AI_AUTH_AUDIENCE,
});
const { server } = await createAIAuthMcpServer({
  serviceClient,
  wallet,
  requestedCapabilities: ["messages.read", "messages.write"],
  approveCapabilities: (requested, identity) =>
    promptForWalletApproval(requested, identity),
});
await connectAIAuthMcpStdio(server);
```

The package provides `ai_auth_identity` plus scope-gated tools for workspace creation, signed invitations, joining, reading messages and sending messages. The backend remains the authority for tenant membership and every protected operation. Do not log the returned session object or place it in MCP tool output.

## Limits

- The application that launches this MCP process owns secure wallet loading and the approval UI or policy. This package deliberately does not persist private keys or silently approve requested capabilities.
- Presence WebSocket subscriptions and a turnkey wallet-provider CLI are not included yet.
- The package is not production-ready until the shared-state service is deployed and authenticated multi-client E2E passes.
