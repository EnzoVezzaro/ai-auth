import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const baseUrl = new URL(process.env.AI_AUTH_URL ?? "http://127.0.0.1:3333");
if (
  !["http:", "https:"].includes(baseUrl.protocol) ||
  baseUrl.username ||
  baseUrl.password
)
  throw new Error(
    "AI_AUTH_URL must be an HTTP(S) origin without embedded credentials",
  );
const token = process.env.AI_AUTH_TOKEN;
if (!token)
  throw new Error(
    "AI_AUTH_TOKEN is required; use a dedicated revocable local agent token",
  );
async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new Error(
      `AI Auth returned ${response.status}: ${String(body.error ?? "request failed")}`,
    );
  return body;
}
function output(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}
const server = new McpServer(
  { name: "ai-auth", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } },
);
server.registerTool(
  "ai_auth.whoami",
  {
    title: "Current agent identity",
    description:
      "Return the authenticated AI Auth agent identity for this connection.",
    inputSchema: z.object({}),
  },
  async () => output(await call("/v1/me")),
);
server.registerTool(
  "ai_auth.list_agents",
  {
    title: "List public agents",
    description: "List agents visible in a room. Private sessions are omitted.",
    inputSchema: z.object({
      room: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,64}$/)
        .default("workspace"),
    }),
  },
  async ({ room }) =>
    output(await call(`/v1/presence?room=${encodeURIComponent(room)}`)),
);
server.registerTool(
  "ai_auth.set_status",
  {
    title: "Set agent status",
    description: "Set the authenticated agent status in its public presence.",
    inputSchema: z.object({
      status: z.enum(["online", "working", "idle", "away"]),
    }),
  },
  async ({ status }) =>
    output(
      await call("/v1/status", {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    ),
);
server.registerTool(
  "ai_auth.set_activity",
  {
    title: "Set public activity",
    description:
      "Set a short public activity label visible to authorized room participants.",
    inputSchema: z.object({ activity: z.string().trim().max(160) }),
  },
  async ({ activity }) =>
    output(
      await call("/v1/activity", {
        method: "POST",
        body: JSON.stringify({ activity }),
      }),
    ),
);
server.registerTool(
  "ai_auth.send_message",
  {
    title: "Send room message",
    description:
      "Send a bounded text message to an authorized public collaboration room.",
    inputSchema: z.object({
      room: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      body: z.string().trim().min(1).max(4000),
    }),
  },
  async ({ room, body }) =>
    output(
      await call(`/v1/rooms/${encodeURIComponent(room)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    ),
);
server.registerTool(
  "ai_auth.request_handoff",
  {
    title: "Request task handoff",
    description:
      "Create a shared coordination task. This does not authorize the underlying website action.",
    inputSchema: z.object({
      room: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      description: z.string().trim().min(1).max(2000),
      assigneeId: z.string().uuid().optional(),
    }),
  },
  async ({ room, description, assigneeId }) =>
    output(
      await call(`/v1/rooms/${encodeURIComponent(room)}/tasks`, {
        method: "POST",
        body: JSON.stringify({ description, assigneeId }),
      }),
    ),
);
server.registerTool(
  "ai_auth.acquire_lock",
  {
    title: "Acquire advisory resource lock",
    description:
      "Acquire a short-lived advisory lock. The protected website must enforce its own authorization and transaction.",
    inputSchema: z.object({
      room: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      resource: z.string().trim().min(1).max(200),
      leaseSeconds: z.number().int().min(5).max(300).default(60),
    }),
  },
  async ({ room, resource, leaseSeconds }) =>
    output(
      await call(`/v1/rooms/${encodeURIComponent(room)}/locks`, {
        method: "POST",
        body: JSON.stringify({ resource, leaseSeconds }),
      }),
    ),
);
server.registerTool(
  "ai_auth.release_lock",
  {
    title: "Release own resource lock",
    description: "Release a resource lock held by the authenticated agent.",
    inputSchema: z.object({
      room: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      resource: z.string().trim().min(1).max(200),
    }),
  },
  async ({ room, resource }) =>
    output(
      await call(
        `/v1/rooms/${encodeURIComponent(room)}/locks/${encodeURIComponent(resource)}`,
        { method: "DELETE" },
      ),
    ),
);
server.registerResource(
  "ai-auth://presence",
  "ai-auth://presence",
  {
    title: "Current public presence",
    description: "Public agent presence in a workspace room.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(await call("/v1/presence?room=workspace")),
      },
    ],
  }),
);
const handle = serveStdio(() => server, {
  onerror: (error) => process.stderr.write(`[ai-auth-mcp] ${error.message}\n`),
});
process.on("SIGINT", () => {
  void handle.close();
});
process.on("SIGTERM", () => {
  void handle.close();
});
