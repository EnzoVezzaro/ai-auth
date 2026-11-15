import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOOL_CAPABILITY = Object.freeze({
  ai_auth_create_tenant: "tenant.create",
  ai_auth_create_invitation: "tenant.invite",
  ai_auth_join_tenant: "tenant.join",
  ai_auth_list_messages: "messages.read",
  ai_auth_send_message: "messages.write",
});
const MCP_CAPABILITIES = new Set(Object.values(TOOL_CAPABILITY));
const OPERATION_METHOD = Object.freeze({
  ai_auth_create_tenant: "createTenant",
  ai_auth_create_invitation: "createInvitation",
  ai_auth_join_tenant: "joinTenant",
  ai_auth_list_messages: "listMessages",
  ai_auth_send_message: "sendMessage",
});

function assertScopes(scopes) {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.some(
      (scope) => typeof scope !== "string" || !MCP_CAPABILITIES.has(scope),
    ) ||
    new Set(scopes).size !== scopes.length
  )
    throw new TypeError("A non-empty list of unique capabilities is required");
}

function mcpResult(value) {
  const serialized = JSON.stringify(value);
  return {
    content: [{ type: "text", text: serialized }],
    structuredContent: value,
  };
}

function safeError(error, token) {
  const message =
    typeof error?.message === "string" ? error.message : "Request failed";
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return message
    .replace(new RegExp(escaped, "gu"), "[redacted]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 240);
}

function registerOperation(
  server,
  name,
  config,
  operation,
  serviceClient,
  session,
) {
  const capability = TOOL_CAPABILITY[name];
  if (!session.session.capabilities.includes(capability)) return;
  if (typeof serviceClient[OPERATION_METHOD[name]] !== "function")
    throw new TypeError(
      `The AI Auth service client must implement ${OPERATION_METHOD[name]}`,
    );
  server.registerTool(name, config, async (input) => {
    try {
      return mcpResult(await operation(input));
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `AI Auth operation failed: ${safeError(error, session.token)}`,
          },
        ],
        isError: true,
      };
    }
  });
}

/**
 * Build a stdio-ready MCP server after explicit local wallet approval.
 * The caller owns wallet persistence and should provide an interactive or
 * policy-backed approval callback. The wallet's private key never enters MCP.
 */
export async function createAIAuthMcpServer({
  serviceClient,
  wallet,
  requestedCapabilities,
  approveCapabilities,
  name = "ai-auth",
  version = "0.1.0",
} = {}) {
  if (!serviceClient || typeof serviceClient.authenticate !== "function")
    throw new TypeError("An AI Auth service client is required");
  if (
    !wallet ||
    typeof wallet.id !== "string" ||
    typeof wallet.sign !== "function"
  )
    throw new TypeError("A locally managed wallet identity is required");
  if (typeof approveCapabilities !== "function")
    throw new TypeError("An explicit wallet approval callback is required");
  assertScopes(requestedCapabilities);

  const approvedCapabilities = await approveCapabilities(
    [...requestedCapabilities],
    Object.freeze({ id: wallet.id, publicKey: wallet.publicKey }),
  );
  if (!Array.isArray(approvedCapabilities))
    throw new TypeError("Wallet approval must return an array of capabilities");
  if (approvedCapabilities.length === 0)
    throw new Error("No requested capabilities were approved");
  if (
    new Set(approvedCapabilities).size !== approvedCapabilities.length ||
    approvedCapabilities.some(
      (capability) => !requestedCapabilities.includes(capability),
    )
  )
    throw new Error("Wallet approval included an unrequested capability");

  const session = await serviceClient.authenticate(
    wallet,
    requestedCapabilities,
    approvedCapabilities,
  );
  if (
    typeof session?.token !== "string" ||
    session.token.length < 40 ||
    session.session?.agentId !== wallet.id ||
    !Number.isFinite(session.session?.expiresAt) ||
    session.session.expiresAt <= Date.now() ||
    !Array.isArray(session.session?.capabilities) ||
    session.session.capabilities.some(
      (capability) => !approvedCapabilities.includes(capability),
    )
  )
    throw new Error("AI Auth returned an invalid wallet session");

  const server = new McpServer({ name, version });
  server.registerTool(
    "ai_auth_identity",
    {
      description: "Return the local wallet's public AI Auth identity.",
      inputSchema: {},
    },
    async () =>
      mcpResult({ agentId: wallet.id, publicKey: wallet.publicKey ?? null }),
  );

  registerOperation(
    server,
    "ai_auth_create_tenant",
    {
      description: "Create an isolated shared workspace for this agent.",
      inputSchema: { name: z.string().trim().min(1).max(80) },
    },
    ({ name: tenantName }) => serviceClient.createTenant(session, tenantName),
    serviceClient,
    session,
  );
  registerOperation(
    server,
    "ai_auth_create_invitation",
    {
      description:
        "Create a recipient-bound, owner-signed invitation with explicit capabilities and expiry.",
      inputSchema: {
        tenantId: z.string().min(1).max(128),
        recipient: z.string().min(1).max(256),
        capabilities: z.array(z.string().min(1)).min(1).max(16),
        expiresAt: z.number().int().positive(),
      },
    },
    ({ tenantId, recipient, capabilities, expiresAt }) =>
      serviceClient.createInvitation(session, wallet, {
        tenantId,
        recipient,
        capabilities,
        expiresAt,
      }),
    serviceClient,
    session,
  );
  registerOperation(
    server,
    "ai_auth_join_tenant",
    {
      description: "Join a workspace using a signed invitation grant.",
      inputSchema: {
        tenantId: z.string().min(1).max(128),
        grant: z.record(z.string(), z.unknown()),
      },
    },
    ({ tenantId, grant }) => serviceClient.joinTenant(session, tenantId, grant),
    serviceClient,
    session,
  );
  registerOperation(
    server,
    "ai_auth_list_messages",
    {
      description: "Read recent messages from an authorized workspace room.",
      inputSchema: {
        tenantId: z.string().min(1).max(128),
        room: z.string().min(1).max(64),
      },
    },
    ({ tenantId, room }) => serviceClient.listMessages(session, tenantId, room),
    serviceClient,
    session,
  );
  registerOperation(
    server,
    "ai_auth_send_message",
    {
      description: "Send a message to an authorized workspace room.",
      inputSchema: {
        tenantId: z.string().min(1).max(128),
        room: z.string().min(1).max(64),
        body: z.string().trim().min(1).max(4_000),
      },
    },
    ({ tenantId, room, body }) =>
      serviceClient.sendMessage(session, tenantId, room, body),
    serviceClient,
    session,
  );

  return Object.freeze({ server, session });
}

export async function connectAIAuthMcpStdio(server) {
  if (!server || typeof server.connect !== "function")
    throw new TypeError("An MCP server instance is required");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}
