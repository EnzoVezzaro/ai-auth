import Fastify from "fastify";
import cors from "@fastify/cors";
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TLSSocket } from "node:tls";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { webAssets } from "./web-assets.generated.js";
const dbPath = resolve(
  process.env.AI_AUTH_DB ??
    (process.env.VERCEL ? "/tmp/ai-auth.sqlite" : "./data/ai-auth.sqlite"),
);
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, runtime TEXT NOT NULL DEFAULT 'unspecified', category TEXT NOT NULL DEFAULT 'autonomous_agent', private INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'online', activity TEXT NOT NULL DEFAULT '', revoked_at TEXT, token_expires_at TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z');
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor_id TEXT, kind TEXT NOT NULL, room TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, room TEXT NOT NULL, initiator_id TEXT NOT NULL REFERENCES agents(id), assignee_id TEXT REFERENCES agents(id), description TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS resource_locks (id TEXT PRIMARY KEY, room TEXT NOT NULL, resource TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), expires_at INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(room, resource));
  CREATE TABLE IF NOT EXISTS agent_identities (issuer TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), PRIMARY KEY(issuer, subject, client_id), UNIQUE(agent_id));
  CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_actor_created ON audit_events(actor_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_room_status ON tasks(room, status);
`);
const agentColumns = new Set(
  (db.pragma("table_info(agents)") as Array<{ name: string }>).map(
    (column) => column.name,
  ),
);
if (!agentColumns.has("runtime"))
  db.exec(
    "ALTER TABLE agents ADD COLUMN runtime TEXT NOT NULL DEFAULT 'unspecified'",
  );
if (!agentColumns.has("category"))
  db.exec(
    "ALTER TABLE agents ADD COLUMN category TEXT NOT NULL DEFAULT 'autonomous_agent'",
  );
if (!agentColumns.has("private"))
  db.exec("ALTER TABLE agents ADD COLUMN private INTEGER NOT NULL DEFAULT 0");
if (!agentColumns.has("status"))
  db.exec(
    "ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'online'",
  );
if (!agentColumns.has("activity"))
  db.exec("ALTER TABLE agents ADD COLUMN activity TEXT NOT NULL DEFAULT ''");
if (!agentColumns.has("revoked_at"))
  db.exec("ALTER TABLE agents ADD COLUMN revoked_at TEXT");
if (!agentColumns.has("token_expires_at"))
  db.exec(
    "ALTER TABLE agents ADD COLUMN token_expires_at TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z'",
  );
const app = Fastify({
  logger: true,
  bodyLimit: 16_384,
  genReqId: () => randomUUID(),
});
const allowedOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
await app.register(cors, {
  origin: allowedOrigins.length ? allowedOrigins : false,
});
const now = () => new Date().toISOString();
const sockets = new Map<
  WebSocket,
  {
    agentId: string;
    room: string;
    private: boolean;
    connectedAt: number;
    lastSeen: number;
  }
>();
const websocketTickets = new Map<
  string,
  { agentId: string; room: string; expiresAt: number }
>();
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const scopeString = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
function audit(
  actorId: string | null,
  kind: string,
  room: string | null,
  payload: unknown,
) {
  const event = {
    id: randomUUID(),
    version: 1,
    timestamp: now(),
    siteId: "local",
    roomId: room,
    agentId: actorId,
    sessionId: null,
    type: kind,
    traceId: randomUUID(),
    payload,
  };
  db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?)").run(
    event.id,
    actorId,
    kind,
    room,
    JSON.stringify(event),
    event.timestamp,
  );
  return event;
}
function agentForToken(token: string) {
  if (!token) return undefined;
  return db
    .prepare(
      "SELECT id, name, runtime, category, private, status FROM agents WHERE token_hash = ? AND revoked_at IS NULL AND token_expires_at > ?",
    )
    .get(hash(token), now()) as
    | {
        id: string;
        name: string;
        runtime: string;
        category: string;
        private: number;
        status: string;
      }
    | undefined;
}
const oidcIssuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
const oidcAudience = process.env.OIDC_AUDIENCE;
const oidcJwksUrl = process.env.OIDC_JWKS_URL;
const oidcJwks = oidcJwksUrl ? createRemoteJWKSet(new URL(oidcJwksUrl)) : null;

async function agentForCredential(token: string) {
  const local = agentForToken(token);
  if (local || !oidcIssuer || !oidcAudience || !oidcJwks) return local;
  try {
    const { payload } = await jwtVerify(token, oidcJwks, {
      issuer: oidcIssuer,
      audience: oidcAudience,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== "string") return undefined;
    const clientId =
      typeof payload.azp === "string"
        ? payload.azp
        : typeof payload.client_id === "string"
          ? payload.client_id
          : "";
    if (!clientId) return undefined;
    const identity = db
      .prepare(
        "SELECT a.id,a.name,a.runtime,a.category,a.private,a.status FROM agent_identities i JOIN agents a ON a.id=i.agent_id WHERE i.issuer=? AND i.subject=? AND i.client_id=? AND a.revoked_at IS NULL",
      )
      .get(oidcIssuer, payload.sub, clientId) as
      | {
          id: string;
          name: string;
          runtime: string;
          category: string;
          private: number;
          status: string;
        }
      | undefined;
    if (identity) return identity;
    const category = z
      .enum([
        "autonomous_agent",
        "browser_automation",
        "simulated_test_client",
        "human",
      ])
      .safeParse(payload.agent_category);
    const agentId = randomUUID();
    const tokenHash = hash(randomBytes(32).toString("base64url"));
    const name =
      typeof payload.agent_name === "string"
        ? payload.agent_name.slice(0, 80)
        : `OIDC agent ${payload.sub.slice(0, 8)}`;
    const runtime =
      typeof payload.agent_runtime === "string"
        ? payload.agent_runtime.slice(0, 80)
        : "oidc";
    const privateMode = payload.ai_auth_private === true;
    const tx = db.transaction(() => {
      db.prepare(
        "INSERT INTO agents (id,name,token_hash,created_at,runtime,category,private,token_expires_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        agentId,
        name,
        tokenHash,
        now(),
        runtime,
        category.success ? category.data : "human",
        Number(privateMode),
        new Date(Number(payload.exp) * 1000).toISOString(),
      );
      db.prepare(
        "INSERT INTO agent_identities (issuer,subject,client_id,agent_id) VALUES (?,?,?,?)",
      ).run(oidcIssuer, payload.sub, clientId, agentId);
    });
    tx();
    return db
      .prepare(
        "SELECT id,name,runtime,category,private,status FROM agents WHERE id=?",
      )
      .get(agentId) as typeof identity;
  } catch {
    return undefined;
  }
}

async function authenticate(
  request: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply,
) {
  const auth = request.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const agent = await agentForCredential(token);
  if (!agent) {
    reply.code(401).send({ error: "valid bearer credential required" });
    return null;
  }
  return agent;
}
function sendRoom(room: string, event: unknown) {
  const data =
    event && typeof event === "object"
      ? (event as Record<string, unknown>)
      : {};
  const wire = JSON.stringify({
    version: 1,
    eventId: randomUUID(),
    timestamp: now(),
    siteId: "local",
    roomId: room,
    agentId: data.agentId ?? data.initiatorId ?? null,
    sessionId: null,
    traceId: randomUUID(),
    ...data,
  });
  for (const [socket, client] of sockets)
    if (
      client.room === room &&
      !client.private &&
      socket.readyState === WebSocket.OPEN
    )
      socket.send(wire);
}
app.get("/health", async () => ({ ok: true, protocol: "AAPP/1" }));
app.get("/", async (_request, reply) =>
  reply.type("text/html; charset=utf-8").send(webAssets.home),
);
app.get("/docs", async (_request, reply) =>
  reply.type("text/html; charset=utf-8").send(webAssets.docs),
);
app.get("/.well-known/ai-auth", async () => ({
  protocol: "AAPP",
  version: "1.0.0",
  registration: "/v1/agents/register",
  events: "/v1/events",
  capabilities: ["presence", "messaging", "tasks", "advisory-locks"],
}));
app.get(
  "/agents.txt",
  async () =>
    "# AI Auth discovery\nProtocol: AAPP/1\nRegistration: /v1/agents/register\nPresence: /v1/presence\nMCP: stdio server (npm run dev:mcp)\n",
);
app.get("/sdk/ai-auth.js", async (_request, reply) =>
  reply.type("text/javascript").send(webAssets.sdk),
);
app.get("/dashboard", async (_request, reply) =>
  reply.type("text/html; charset=utf-8").send(webAssets.dashboard),
);
app.get("/demo", async (_request, reply) =>
  reply.type("text/html; charset=utf-8").send(webAssets.demo),
);
app.post("/v1/agents/register", async (request, reply) => {
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(80),
      runtime: z.string().trim().min(1).max(80).default("unspecified"),
      category: z
        .enum([
          "autonomous_agent",
          "browser_automation",
          "simulated_test_client",
          "human",
        ])
        .default("autonomous_agent"),
      private: z.boolean().default(false),
    })
    .safeParse(request.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({ error: "invalid registration", issues: parsed.error.issues });
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const createdAt = now();
  const tokenExpiresAt = new Date(
    Date.now() + 12 * 60 * 60 * 1000,
  ).toISOString();
  db.prepare(
    "INSERT INTO agents (id,name,token_hash,created_at,runtime,category,private,token_expires_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    id,
    parsed.data.name,
    hash(token),
    createdAt,
    parsed.data.runtime,
    parsed.data.category,
    Number(parsed.data.private),
    tokenExpiresAt,
  );
  audit(id, "agent.registered", null, {
    name: parsed.data.name,
    runtime: parsed.data.runtime,
    category: parsed.data.category,
  });
  return reply.code(201).send({
    agent: {
      id,
      name: parsed.data.name,
      runtime: parsed.data.runtime,
      category: parsed.data.category,
      private: parsed.data.private,
      createdAt,
      tokenExpiresAt,
    },
    token,
  });
});
app.get("/v1/me", async (request, reply) => {
  const agent = await authenticate(request, reply);
  return agent
    ? { agent: { ...agent, private: Boolean(agent.private) } }
    : reply;
});
app.post("/v1/events/ticket", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  const parsed = z.object({ room: scopeString }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid room" });
  for (const [ticket, entry] of websocketTickets)
    if (entry.expiresAt <= Date.now()) websocketTickets.delete(ticket);
  const ticket = randomBytes(32).toString("base64url");
  websocketTickets.set(ticket, {
    agentId: agent.id,
    room: parsed.data.room,
    expiresAt: Date.now() + 30_000,
  });
  return { ticket, expiresIn: 30, room: parsed.data.room };
});
app.post("/v1/revoke", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ?").run(
    now(),
    agent.id,
  );
  for (const [socket, client] of sockets)
    if (client.agentId === agent.id) socket.close(1008, "credential revoked");
  audit(agent.id, "credential.revoked", null, {});
  return { revoked: true };
});
app.post("/v1/status", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  const parsed = z
    .object({ status: z.enum(["online", "working", "idle", "away"]) })
    .safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid status" });
  db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(
    parsed.data.status,
    agent.id,
  );
  audit(agent.id, "agent.status_changed", null, { status: parsed.data.status });
  if (!agent.private)
    for (const [, c] of sockets)
      if (c.agentId === agent.id && !c.private)
        sendRoom(c.room, {
          version: 1,
          type: "agent.status_changed",
          agentId: agent.id,
          status: parsed.data.status,
          timestamp: now(),
        });
  return { status: parsed.data.status };
});
app.post("/v1/activity", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  const parsed = z
    .object({ activity: z.string().trim().max(160) })
    .safeParse(request.body);
  if (!parsed.success)
    return reply.code(400).send({ error: "invalid activity" });
  db.prepare("UPDATE agents SET activity = ? WHERE id = ?").run(
    parsed.data.activity,
    agent.id,
  );
  audit(agent.id, "agent.activity_changed", null, {
    activity: parsed.data.activity,
  });
  if (!agent.private)
    for (const [, client] of sockets)
      if (client.agentId === agent.id && !client.private)
        sendRoom(client.room, {
          version: 1,
          type: "agent.activity_changed",
          agentId: agent.id,
          activity: parsed.data.activity,
        });
  return { activity: parsed.data.activity };
});
app.get("/v1/presence", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  const room = (request.query as { room?: string }).room ?? "workspace";
  if (!scopeString.safeParse(room).success)
    return reply.code(400).send({ error: "invalid room" });
  const agents = [...sockets.values()]
    .filter((c) => c.room === room && !c.private && c.agentId !== agent.id)
    .map((c) => {
      const a = db
        .prepare(
          "SELECT id,name,runtime,category,status,activity FROM agents WHERE id = ?",
        )
        .get(c.agentId) as {
        id: string;
        name: string;
        runtime: string;
        category: string;
        status: string;
        activity: string;
      };
      return {
        ...a,
        connectedAt: new Date(c.connectedAt).toISOString(),
        lastSeen: new Date(c.lastSeen).toISOString(),
      };
    });
  return { room, agents };
});
app.post("/v1/rooms/:room/messages", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  if (agent.private)
    return reply
      .code(403)
      .send({ error: "private sessions cannot publish into shared rooms" });
  const room = scopeString.safeParse((request.params as { room: string }).room);
  const body = z
    .object({ body: z.string().trim().min(1).max(4000) })
    .safeParse(request.body);
  if (!room.success || !body.success)
    return reply.code(400).send({ error: "invalid room or message body" });
  const message = {
    id: randomUUID(),
    room: room.data,
    agentId: agent.id,
    body: body.data.body,
    createdAt: now(),
  };
  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?)").run(
    message.id,
    message.room,
    message.agentId,
    message.body,
    message.createdAt,
  );
  audit(agent.id, "message.created", message.room, message);
  sendRoom(message.room, {
    version: 1,
    type: "agent.message_sent",
    ...message,
  });
  return reply.code(201).send({ message });
});
app.get("/v1/rooms/:room/messages", async (request, reply) => {
  if (!(await authenticate(request, reply))) return reply;
  const room = scopeString.safeParse((request.params as { room: string }).room);
  if (!room.success) return reply.code(400).send({ error: "invalid room" });
  return {
    messages: db
      .prepare(
        "SELECT id, room, agent_id AS agentId, body, created_at AS createdAt FROM messages WHERE room = ? ORDER BY created_at LIMIT 200",
      )
      .all(room.data),
  };
});
app.post("/v1/rooms/:room/tasks", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  if (agent.private)
    return reply
      .code(403)
      .send({ error: "private sessions cannot publish shared tasks" });
  const room = scopeString.safeParse((request.params as { room: string }).room);
  const body = z
    .object({
      description: z.string().trim().min(1).max(2000),
      assigneeId: z.string().uuid().optional(),
    })
    .safeParse(request.body);
  if (!room.success || !body.success)
    return reply.code(400).send({ error: "invalid room or task" });
  const id = randomUUID(),
    createdAt = now();
  if (
    body.data.assigneeId &&
    !db
      .prepare(
        "SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL AND private = 0",
      )
      .get(body.data.assigneeId)
  )
    return reply.code(404).send({ error: "assignee not found" });
  db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)").run(
    id,
    room.data,
    agent.id,
    body.data.assigneeId ?? null,
    body.data.description,
    "pending",
    null,
    createdAt,
    createdAt,
  );
  audit(agent.id, "task.created", room.data, {
    id,
    assigneeId: body.data.assigneeId ?? null,
  });
  sendRoom(room.data, {
    version: 1,
    type: "agent.handoff_requested",
    taskId: id,
    room: room.data,
    initiatorId: agent.id,
    assigneeId: body.data.assigneeId ?? null,
    description: body.data.description,
  });
  return reply.code(201).send({
    task: {
      id,
      room: room.data,
      initiatorId: agent.id,
      assigneeId: body.data.assigneeId ?? null,
      description: body.data.description,
      status: "pending",
      createdAt,
    },
  });
});
app.patch("/v1/tasks/:id", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  const task = db
    .prepare(
      "SELECT id,room,initiator_id AS initiatorId,assignee_id AS assigneeId,status FROM tasks WHERE id = ?",
    )
    .get((request.params as { id: string }).id) as
    | {
        id: string;
        room: string;
        initiatorId: string;
        assigneeId: string | null;
        status: string;
      }
    | undefined;
  if (!task) return reply.code(404).send({ error: "task not found" });
  if (agent.id !== task.assigneeId && agent.id !== task.initiatorId)
    return reply.code(403).send({ error: "task access denied" });
  const body = z
    .object({
      status: z.enum(["accepted", "in_progress", "completed", "failed"]),
      result: z.string().max(2000).optional(),
    })
    .safeParse(request.body);
  if (!body.success)
    return reply.code(400).send({ error: "invalid task update" });
  if (task.status === "completed" || task.status === "failed")
    return reply.code(409).send({ error: "task is terminal" });
  db.prepare(
    "UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?",
  ).run(body.data.status, body.data.result ?? null, now(), task.id);
  audit(agent.id, "task.updated", task.room, {
    id: task.id,
    status: body.data.status,
  });
  sendRoom(task.room, {
    version: 1,
    type:
      body.data.status === "accepted"
        ? "agent.handoff_accepted"
        : "agent.task_updated",
    taskId: task.id,
    status: body.data.status,
    result: body.data.result ?? null,
    agentId: agent.id,
    timestamp: now(),
  });
  return {
    task: {
      ...task,
      status: body.data.status,
      result: body.data.result ?? null,
    },
  };
});
app.get("/v1/rooms/:room/tasks", async (request, reply) => {
  if (!(await authenticate(request, reply))) return reply;
  const room = scopeString.safeParse((request.params as { room: string }).room);
  if (!room.success) return reply.code(400).send({ error: "invalid room" });
  return {
    tasks: db
      .prepare(
        "SELECT id,room,initiator_id AS initiatorId,assignee_id AS assigneeId,description,status,result,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE room = ? ORDER BY created_at DESC LIMIT 200",
      )
      .all(room.data),
  };
});
app.post("/v1/rooms/:room/locks", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  if (agent.private)
    return reply
      .code(403)
      .send({ error: "private sessions cannot acquire shared locks" });
  const room = scopeString.safeParse((request.params as { room: string }).room);
  const body = z
    .object({
      resource: z.string().trim().min(1).max(200),
      leaseSeconds: z.number().int().min(5).max(300).default(60),
    })
    .safeParse(request.body);
  if (!room.success || !body.success)
    return reply.code(400).send({ error: "invalid lock request" });
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM resource_locks WHERE expires_at <= ?").run(
      Date.now(),
    );
    const held = db
      .prepare(
        "SELECT agent_id AS agentId,expires_at AS expiresAt FROM resource_locks WHERE room = ? AND resource = ?",
      )
      .get(room.data, body.data.resource) as
      { agentId: string; expiresAt: number } | undefined;
    if (held) return { held };
    const lock = {
      id: randomUUID(),
      room: room.data,
      resource: body.data.resource,
      agentId: agent.id,
      expiresAt: Date.now() + body.data.leaseSeconds * 1000,
      createdAt: now(),
    };
    db.prepare("INSERT INTO resource_locks VALUES (?,?,?,?,?,?)").run(
      lock.id,
      lock.room,
      lock.resource,
      lock.agentId,
      lock.expiresAt,
      lock.createdAt,
    );
    return { lock };
  });
  const result = tx();
  if (result.held) {
    audit(agent.id, "lock.conflict_detected", room.data, {
      resource: body.data.resource,
      holder: result.held.agentId,
    });
    sendRoom(room.data, {
      version: 1,
      type: "resource.conflict_detected",
      resource: body.data.resource,
      requestingAgentId: agent.id,
      holderAgentId: result.held.agentId,
      expiresAt: result.held.expiresAt,
    });
    return reply
      .code(409)
      .send({ error: "resource locked", lock: result.held });
  }
  audit(agent.id, "lock.acquired", room.data, {
    resource: body.data.resource,
    expiresAt: result.lock!.expiresAt,
  });
  sendRoom(room.data, {
    version: 1,
    type: "resource.lock_acquired",
    ...result.lock,
  });
  return { lock: result.lock, advisory: true };
});
app.delete("/v1/rooms/:room/locks/:resource", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  const params = z
    .object({ room: scopeString, resource: z.string().min(1).max(200) })
    .safeParse(request.params);
  if (!params.success)
    return reply.code(400).send({ error: "invalid lock identifier" });
  const result = db
    .prepare(
      "DELETE FROM resource_locks WHERE room=? AND resource=? AND agent_id=?",
    )
    .run(params.data.room, params.data.resource, agent.id);
  if (!result.changes)
    return reply.code(404).send({ error: "owned lock not found" });
  audit(agent.id, "lock.released", params.data.room, {
    resource: params.data.resource,
  });
  sendRoom(params.data.room, {
    version: 1,
    type: "resource.lock_released",
    room: params.data.room,
    resource: params.data.resource,
    agentId: agent.id,
  });
  return { released: true };
});
app.get("/v1/audit", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  return {
    events: db
      .prepare(
        "SELECT id, actor_id AS actorId, kind, room, payload, created_at AS createdAt FROM audit_events WHERE actor_id = ? ORDER BY created_at DESC LIMIT 200",
      )
      .all(agent.id),
  };
});
app.get("/v1/analytics", async (request, reply) => {
  if (!(await authenticate(request, reply))) return reply;
  const actions = db
    .prepare(
      "SELECT COUNT(*) AS count FROM audit_events e LEFT JOIN agents a ON a.id = e.actor_id WHERE COALESCE(a.private, 0) = 0",
    )
    .get() as { count: number };
  const connected = [...sockets.values()].filter((c) => !c.private).length;
  return {
    connectedAgents: connected,
    activeSessions: connected,
    actions: actions.count,
    updatedAt: now(),
  };
});
app.post("/v1/analytics/events", async (request, reply) => {
  const agent = await authenticate(request, reply);
  if (!agent) return reply;
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      properties: z.record(z.string(), z.unknown()).default({}),
    })
    .safeParse(request.body);
  if (!body.success)
    return reply.code(400).send({ error: "invalid analytics event" });
  const safeProperties = JSON.parse(
    JSON.stringify(body.data.properties, (_key, value) =>
      typeof value === "string" && value.length > 500
        ? value.slice(0, 500)
        : value,
    ),
  );
  const event = audit(agent.id, "analytics.tracked", null, {
    name: body.data.name,
    properties: safeProperties,
  });
  return reply.code(202).send({ accepted: true, eventId: event.id });
});

const port = Number(process.env.PORT ?? 3333);
const wss = new WebSocketServer({
  server: app.server,
  path: "/v1/events",
  maxPayload: 4096,
});
wss.on("connection", (socket, request) => {
  const origin = request.headers.origin;
  const sameOrigin =
    origin ===
    `${request.socket instanceof TLSSocket ? "https" : "http"}://${request.headers.host ?? "localhost"}`;
  if (origin && !sameOrigin && !allowedOrigins.includes(origin)) {
    socket.close(1008, "origin not allowed");
    return;
  }
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const ticket = url.searchParams.get("ticket") ?? "";
  const ticketData = websocketTickets.get(ticket);
  if (ticketData) websocketTickets.delete(ticket);
  const token = url.searchParams.get("token") ?? "";
  const agent = ticketData
    ? (db
        .prepare(
          "SELECT id,name,runtime,category,private,status FROM agents WHERE id=? AND revoked_at IS NULL",
        )
        .get(ticketData.agentId) as ReturnType<typeof agentForToken>)
    : agentForToken(token);
  const room = ticketData?.room ?? url.searchParams.get("room") ?? "";
  if (
    !agent ||
    (ticketData && ticketData.expiresAt <= Date.now()) ||
    !scopeString.safeParse(room).success
  ) {
    socket.close(1008, "unauthorized");
    return;
  }
  const client = {
    agentId: agent.id,
    room,
    private: Boolean(agent.private),
    connectedAt: Date.now(),
    lastSeen: Date.now(),
  };
  sockets.set(socket, client);
  if (!client.private)
    sendRoom(room, {
      version: 1,
      type: "agent.connected",
      eventId: randomUUID(),
      timestamp: now(),
      siteId: "local",
      roomId: room,
      agentId: agent.id,
      sessionId: null,
      traceId: randomUUID(),
      category: agent.category,
      name: agent.name,
      runtime: agent.runtime,
      status: agent.status,
    });
  if (!client.private)
    sendRoom(room, {
      version: 1,
      type: "agent.entered_room",
      agentId: agent.id,
    });
  audit(agent.id, "agent.connected", room, { private: client.private });
  socket.on("message", (raw) => {
    if (raw.toString() === "ping") {
      client.lastSeen = Date.now();
      socket.send(
        JSON.stringify({
          version: 1,
          type: "agent.heartbeat",
          eventId: randomUUID(),
          timestamp: now(),
          siteId: "local",
          roomId: room,
          agentId: agent.id,
          sessionId: null,
          traceId: randomUUID(),
        }),
      );
    }
  });
  const timer = setInterval(() => {
    if (Date.now() - client.lastSeen > 45_000)
      socket.close(1001, "heartbeat expired");
    else if (
      !db
        .prepare("SELECT 1 FROM agents WHERE id=? AND revoked_at IS NULL")
        .get(agent.id)
    )
      socket.close(1008, "credential expired or revoked");
  }, 15_000);
  timer.unref();
  socket.on("close", () => {
    clearInterval(timer);
    sockets.delete(socket);
    if (!client.private) {
      sendRoom(room, {
        version: 1,
        type: "agent.left_room",
        agentId: agent.id,
      });
      sendRoom(room, {
        version: 1,
        type: "agent.disconnected",
        eventId: randomUUID(),
        timestamp: now(),
        siteId: "local",
        roomId: room,
        agentId: agent.id,
      });
    }
    audit(agent.id, "agent.disconnected", room, { private: client.private });
  });
});
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
export { app, wss };
if (isMain) {
  await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      for (const socket of wss.clients) socket.close(1001, "server shutdown");
      await app.close();
      db.close();
      process.exit(0);
    });
}
