import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

function validateAction(action) {
  if (
    !action ||
    typeof action.name !== "string" ||
    !ACTION_NAME_PATTERN.test(action.name) ||
    typeof action.description !== "string" ||
    !action.description.trim() ||
    !action.inputSchema ||
    typeof action.inputSchema !== "object" ||
    Array.isArray(action.inputSchema) ||
    typeof action.execute !== "function" ||
    typeof action.requiredCapability !== "string" ||
    !CAPABILITY_PATTERN.test(action.requiredCapability)
  ) {
    throw new TypeError(
      "MCP actions need a name, description, Zod input shape, capability, and execute function",
    );
  }
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null) }],
    structuredContent: value ?? null,
  };
}

function actionEnvelope(wallet, action, state, summary) {
  return wallet.sign("agent/action", {
    name: action.name,
    capability: action.requiredCapability,
    state,
    summary,
  });
}

async function publishSignedActionEvent(publishEvent, event) {
  try {
    await publishEvent(event);
  } catch {
    throw new Error("Could not publish the signed action event");
  }
}

/**
 * Create a local stdio MCP server from explicitly approved wallet actions.
 * No AI Auth service, hosted session, or remote credential is required.
 */
export async function createAIAuthMcpServer({
  wallet,
  actions,
  approveCapabilities,
  publishEvent = async () => {},
  name = "ai-auth",
  version = "0.2.0",
} = {}) {
  if (
    !wallet ||
    typeof wallet.id !== "string" ||
    typeof wallet.sign !== "function"
  )
    throw new TypeError("A locally managed wallet identity is required");
  if (!Array.isArray(actions))
    throw new TypeError("MCP actions must be an array");
  if (typeof approveCapabilities !== "function")
    throw new TypeError("An explicit capability approval callback is required");

  const names = new Set();
  for (const action of actions) {
    validateAction(action);
    if (names.has(action.name))
      throw new TypeError("MCP action names must be unique");
    names.add(action.name);
  }

  const requestedCapabilities = [
    ...new Set(actions.map((action) => action.requiredCapability)),
  ].sort();
  if (requestedCapabilities.length === 0)
    throw new TypeError("Provide at least one action with a capability");
  const approvedCapabilities = await approveCapabilities(
    [...requestedCapabilities],
    Object.freeze({ id: wallet.id, publicKey: wallet.publicKey }),
  );
  if (
    !Array.isArray(approvedCapabilities) ||
    approvedCapabilities.length === 0 ||
    new Set(approvedCapabilities).size !== approvedCapabilities.length ||
    approvedCapabilities.some(
      (capability) => !requestedCapabilities.includes(capability),
    )
  )
    throw new Error(
      "Wallet approval must be a non-empty requested capability subset",
    );

  const approved = new Set(approvedCapabilities);
  const server = new McpServer({ name, version });
  for (const action of actions) {
    if (!approved.has(action.requiredCapability)) continue;
    server.registerTool(
      action.name,
      {
        description: action.description.trim().slice(0, 500),
        inputSchema: action.inputSchema,
        annotations: { readOnlyHint: action.readOnly === true },
      },
      async (input) => {
        // Announcements are best-effort. Publishing "started" or "completed"
        // must never turn a successful side effect into a reported failure,
        // because that would invite the caller to run the action twice.
        await publishSignedActionEvent(
          publishEvent,
          await actionEnvelope(wallet, action, "started", `Started ${action.name}`),
        ).catch(() => {});
        let output;
        try {
          output = await action.execute(input ?? {});
        } catch {
          try {
            await publishEvent(
              await actionEnvelope(
                wallet,
                action,
                "failed",
                `Could not complete ${action.name}`,
              ),
            );
          } catch {
            // Host transport errors may contain secrets; keep them out of MCP results.
          }
          return {
            content: [
              {
                type: "text",
                text: "The action failed. Check the local host for details.",
              },
            ],
            isError: true,
          };
        }
        const published = await publishSignedActionEvent(
          publishEvent,
          await actionEnvelope(
            wallet,
            action,
            "completed",
            `Completed ${action.name}`,
          ),
        ).then(
          () => true,
          () => false,
        );
        return {
          ...result(output),
          ...(published
            ? {}
            : {
                publishWarning:
                  "The action completed, but its activity event could not be published.",
              }),
        };
      },
    );
  }

  return Object.freeze({
    server,
    capabilities: Object.freeze([...approvedCapabilities].sort()),
    wallet: Object.freeze({ id: wallet.id, publicKey: wallet.publicKey }),
  });
}

export async function connectAIAuthMcpStdio(server) {
  if (!server || typeof server.connect !== "function")
    throw new TypeError("An MCP server instance is required");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}
