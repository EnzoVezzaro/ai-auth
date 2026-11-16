import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MAX_BODY_BYTES = 1_000_000;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function reply(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/**
 * Serves MCP over Streamable HTTP on loopback, at a path with a random secret.
 * Anyone who knows the full URL can drive this agent, so the URL is the
 * credential: keep it private and expose it only through a tunnel you control.
 * `createMcpServer()` must return a new McpServer for each session; the
 * sessions share whatever agent runtime those servers close over.
 */
export async function serveAIAuthMcpHttp({
  createMcpServer,
  port = 0,
  host = "127.0.0.1",
  secret = randomBytes(24).toString("base64url"),
}) {
  if (typeof createMcpServer !== "function")
    throw new TypeError("createMcpServer must return an MCP server");
  const path = `/mcp/${secret}`;
  const sessions = new Map();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path) return reply(res, 404, "Not found");
      const sessionId = req.headers["mcp-session-id"];
      const existing =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      const body = req.method === "POST" ? await readJson(req) : undefined;
      if (existing) return await existing.handleRequest(req, res, body);
      const isInitialize = [body]
        .flat()
        .some((message) => message?.method === "initialize");
      if (req.method !== "POST" || !isInitialize)
        return reply(res, 400, "Start a session with an initialize request");
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const mcp = await createMcpServer();
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent)
        reply(res, 400, String(error?.message ?? "Bad request").slice(0, 200));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    url: `http://${host}:${address.port}${path}`,
    close: async () => {
      for (const transport of sessions.values()) await transport.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
