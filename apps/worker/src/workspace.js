import { DurableObject } from "cloudflare:workers";
import { verifyCapabilityGrant } from "../../../packages/p2p/index.js";

const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/u;
const WEBSOCKET_AUTH_TIMEOUT_MS = 10_000;
const MAX_TENANT_WEBSOCKETS = 200;
const MAX_UNAUTHENTICATED_WEBSOCKETS = 10;
const MAX_WEBSOCKETS_PER_AGENT = 10;
const MAX_MESSAGES_PER_TENANT = 1_000;
const MAX_AUDIT_EVENTS_PER_TENANT = 5_000;
const MAX_INVITATIONS_PER_TENANT = 1_000;
const ACTION_RATE_WINDOW_MS = 60_000;
const MAX_PRESENCE_UPDATES_PER_AGENT_WINDOW = 30;
const MAX_PRESENCE_UPDATES_PER_TENANT_WINDOW = 300;
const MAX_MESSAGE_WRITES_PER_AGENT_WINDOW = 60;
const MAX_MESSAGE_WRITES_PER_TENANT_WINDOW = 600;
const DELEGABLE_CAPABILITIES = new Set([
  "tenant.join",
  "messages.read",
  "messages.write",
  "presence.read",
  "presence.publish",
]);

function json(data, status = 200) {
  return Response.json(data, { status });
}
function rateLimited(retryAfterMs) {
  return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
    status: 429,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
    },
  });
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function validActor(actor) {
  return (
    actor &&
    typeof actor.agentId === "string" &&
    Array.isArray(actor.capabilities) &&
    actor.capabilities.every((value) => typeof value === "string")
  );
}

export class Workspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tenant (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_agent_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (agent_id TEXT PRIMARY KEY, role TEXT NOT NULL, capabilities TEXT NOT NULL, added_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS invitations (grant_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, grant_json TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS used_grants (grant_id TEXT PRIMARY KEY, consumed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room TEXT NOT NULL, agent_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_room_created ON messages (room, created_at);
      CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at);
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_events_created ON audit_events (created_at);
      CREATE TABLE IF NOT EXISTS action_rate_limits (
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL,
        PRIMARY KEY (agent_id, action)
      );
    `);
    const usedGrantColumns = this.sql
      .exec("PRAGMA table_info(used_grants)")
      .toArray();
    if (!usedGrantColumns.some((column) => column.name === "expires_at"))
      this.sql.exec(
        "ALTER TABLE used_grants ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0",
      );
  }

  async initializeTenant({ tenantId, name, ownerAgentId }) {
    if (this.sql.exec("SELECT id FROM tenant LIMIT 1").toArray()[0])
      throw new Error("Tenant workspace already exists");
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO tenant (id, name, owner_agent_id, created_at) VALUES (?, ?, ?, ?)",
      tenantId,
      name,
      ownerAgentId,
      now,
    );
    this.sql.exec(
      "INSERT INTO members (agent_id, role, capabilities, added_at) VALUES (?, 'owner', ?, ?)",
      ownerAgentId,
      JSON.stringify([
        "tenant.invite",
        "tenant.delete",
        "tenant.member.revoke",
        "messages.read",
        "messages.write",
        "presence.read",
        "presence.publish",
      ]),
      now,
    );
    this.audit(ownerAgentId, "tenant.created", { tenantId });
    return { tenantId, ownerAgentId };
  }

  audit(actorId, kind, payload) {
    this.sql.exec(
      "INSERT INTO audit_events (id, actor_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      actorId,
      kind,
      JSON.stringify(payload),
      Date.now(),
    );
    this.sql.exec(
      `DELETE FROM audit_events
       WHERE id IN (
         SELECT id FROM audit_events
         ORDER BY created_at DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
      MAX_AUDIT_EVENTS_PER_TENANT,
    );
  }

  async deleteTenant({ actor }) {
    const member = this.requireCapability(actor, "tenant.delete");
    if (member instanceof Response) return member;
    if (member.role !== "owner") return json({ error: "Forbidden" }, 403);
    const tenant = this.sql.exec("SELECT id FROM tenant LIMIT 1").toArray()[0];
    if (!tenant) return json({ error: "Tenant not found" }, 404);
    for (const socket of this.ctx.getWebSockets())
      socket.close(4410, "tenant deleted");
    this.sql.exec("DELETE FROM invitations");
    this.sql.exec("DELETE FROM used_grants");
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM audit_events");
    this.sql.exec("DELETE FROM action_rate_limits");
    this.sql.exec("DELETE FROM members");
    this.sql.exec("DELETE FROM tenant");
    return json({ deleted: true });
  }

  member(agentId) {
    const row = this.sql
      .exec(
        "SELECT role, capabilities FROM members WHERE agent_id = ? AND revoked_at IS NULL",
        agentId,
      )
      .toArray()[0];
    return row
      ? { role: row.role, capabilities: JSON.parse(row.capabilities) }
      : null;
  }

  requireCapability(actor, capability) {
    if (!validActor(actor)) return json({ error: "Unauthorized" }, 401);
    const member = this.member(actor.agentId);
    if (
      !member ||
      !member.capabilities.includes(capability) ||
      !actor.capabilities.includes(capability)
    )
      return json({ error: "Forbidden" }, 403);
    return member;
  }

  takeActionRateLimit(agentId, action, agentLimit, tenantLimit) {
    const now = Date.now();
    const windowStartedAt =
      Math.floor(now / ACTION_RATE_WINDOW_MS) * ACTION_RATE_WINDOW_MS;
    const consumeBucket = (bucketId, limit) =>
      this.sql
        .exec(
          `INSERT INTO action_rate_limits
         (agent_id, action, window_started_at, request_count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(agent_id, action) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           request_count = CASE
             WHEN action_rate_limits.window_started_at = excluded.window_started_at
             THEN action_rate_limits.request_count + 1
             ELSE 1
           END
         WHERE action_rate_limits.window_started_at != excluded.window_started_at
            OR action_rate_limits.request_count < ?
         RETURNING request_count`,
          bucketId,
          action,
          windowStartedAt,
          limit,
        )
        .toArray()[0];
    if (!consumeBucket(agentId, agentLimit))
      return rateLimited(windowStartedAt + ACTION_RATE_WINDOW_MS - now);
    if (!consumeBucket("tenant:all", tenantLimit))
      return rateLimited(windowStartedAt + ACTION_RATE_WINDOW_MS - now);
    return null;
  }

  async createInvitation({ actor, grant }) {
    const member = this.requireCapability(actor, "tenant.invite");
    if (member instanceof Response) return member;
    if (member.role !== "owner") return json({ error: "Forbidden" }, 403);
    const tenant = this.sql
      .exec("SELECT id, owner_agent_id FROM tenant LIMIT 1")
      .toArray()[0];
    const payload = grant?.body?.payload;
    if (
      !tenant ||
      grant?.body?.issuer !== tenant.owner_agent_id ||
      payload?.resource !== `tenant:${tenant.id}` ||
      !Array.isArray(payload?.capabilities) ||
      payload.capabilities.some(
        (capability) => !DELEGABLE_CAPABILITIES.has(capability),
      ) ||
      !payload.capabilities.includes("tenant.join") ||
      !(await verifyCapabilityGrant(grant, {
        expectedIssuer: tenant.owner_agent_id,
        expectedRecipient: payload.recipient,
        resource: `tenant:${tenant.id}`,
        requiredCapability: "tenant.join",
      }))
    )
      return json({ error: "Invalid invitation" }, 400);

    const now = Date.now();
    this.sql.exec(
      `UPDATE used_grants SET expires_at = (
         SELECT expires_at FROM invitations WHERE invitations.grant_id = used_grants.grant_id
       ) WHERE expires_at = 0 AND EXISTS (
         SELECT 1 FROM invitations WHERE invitations.grant_id = used_grants.grant_id
       )`,
    );
    this.sql.exec(
      "DELETE FROM invitations WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      now,
    );
    this.sql.exec("DELETE FROM used_grants WHERE expires_at <= ?", now);
    const existing = this.sql
      .exec(
        "SELECT grant_id FROM invitations WHERE grant_id = ?",
        payload.grantId,
      )
      .toArray()[0];
    const invitationCount = this.sql
      .exec("SELECT COUNT(*) AS count FROM invitations")
      .toArray()[0].count;
    if (!existing && invitationCount >= MAX_INVITATIONS_PER_TENANT)
      return json({ error: "Tenant invitation capacity reached" }, 429);

    const grantJson = JSON.stringify(grant);
    this.sql.exec(
      `INSERT INTO invitations (grant_id, recipient, grant_json, expires_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(grant_id) DO NOTHING`,
      payload.grantId,
      payload.recipient,
      grantJson,
      payload.expiresAt,
    );
    const saved = this.sql
      .exec(
        "SELECT grant_json FROM invitations WHERE grant_id = ? AND revoked_at IS NULL",
        payload.grantId,
      )
      .toArray()[0];
    if (!saved || saved.grant_json !== grantJson)
      return json({ error: "Invitation could not be stored" }, 409);
    this.audit(actor.agentId, "tenant.invitation.created", {
      grantId: payload.grantId,
      recipient: payload.recipient,
      capabilities: payload.capabilities,
    });
    return json({ invitation: grant }, 201);
  }

  async revokeInvitation({ actor, grantId }) {
    const member = this.requireCapability(actor, "tenant.invite");
    if (member instanceof Response) return member;
    if (member.role !== "owner") return json({ error: "Forbidden" }, 403);
    const row = this.sql
      .exec(
        `UPDATE invitations SET revoked_at = ?
       WHERE grant_id = ? AND revoked_at IS NULL RETURNING grant_id`,
        Date.now(),
        grantId,
      )
      .toArray()[0];
    if (!row) return json({ error: "Invitation not found" }, 404);
    this.audit(actor.agentId, "tenant.invitation.revoked", { grantId });
    return json({ revoked: true });
  }

  async revokeMember({ actor, agentId }) {
    const member = this.requireCapability(actor, "tenant.member.revoke");
    if (member instanceof Response) return member;
    if (member.role !== "owner" || agentId === actor.agentId)
      return json({ error: "Forbidden" }, 403);
    const row = this.sql
      .exec(
        `UPDATE members SET revoked_at = ?
         WHERE agent_id = ? AND revoked_at IS NULL RETURNING agent_id`,
        Date.now(),
        agentId,
      )
      .toArray()[0];
    if (!row) return json({ error: "Member not found" }, 404);
    this.sql.exec("DELETE FROM action_rate_limits WHERE agent_id = ?", agentId);
    this.audit(actor.agentId, "tenant.member.revoked", { agentId });
    const rooms = new Set();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.authenticated && attachment.agentId === agentId) {
        rooms.add(attachment.room);
        socket.close(4403, "tenant membership revoked");
      }
    }
    for (const room of rooms)
      await this.broadcast(
        room,
        { type: "presence.left", agent: { id: agentId } },
        "presence.read",
      );
    return json({ revoked: true });
  }

  async acceptInvitation({ actor, grant }) {
    if (!validActor(actor)) return json({ error: "Unauthorized" }, 401);
    if (!actor.capabilities.includes("tenant.join"))
      return json({ error: "Forbidden" }, 403);
    const tenant = this.sql
      .exec("SELECT id, owner_agent_id FROM tenant LIMIT 1")
      .toArray()[0];
    const payload = grant?.body?.payload;
    if (
      !tenant ||
      !payload?.grantId ||
      payload.recipient !== actor.agentId ||
      payload.resource !== `tenant:${tenant.id}` ||
      !(await verifyCapabilityGrant(grant, {
        expectedIssuer: tenant.owner_agent_id,
        expectedRecipient: actor.agentId,
        resource: `tenant:${tenant.id}`,
        requiredCapability: "tenant.join",
      }))
    )
      return json({ error: "Invalid invitation" }, 400);

    const invitation = this.sql
      .exec(
        `SELECT grant_json, expires_at FROM invitations
       WHERE grant_id = ? AND recipient = ? AND revoked_at IS NULL`,
        payload.grantId,
        actor.agentId,
      )
      .toArray()[0];
    if (
      !invitation ||
      invitation.expires_at <= Date.now() ||
      invitation.grant_json !== JSON.stringify(grant) ||
      payload.capabilities.some(
        (capability) => !actor.capabilities.includes(capability),
      )
    )
      return json(
        { error: "Invitation is expired, revoked, or not approved" },
        403,
      );

    const consumed = this.sql
      .exec(
        `INSERT INTO used_grants (grant_id, consumed_at, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(grant_id) DO NOTHING RETURNING grant_id`,
        payload.grantId,
        Date.now(),
        payload.expiresAt,
      )
      .toArray()[0];
    if (!consumed)
      return json({ error: "Invitation has already been used" }, 409);
    this.sql.exec(
      `INSERT INTO members (agent_id, role, capabilities, added_at)
       VALUES (?, 'member', ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET role = 'member', capabilities = excluded.capabilities,
         added_at = excluded.added_at, revoked_at = NULL`,
      actor.agentId,
      JSON.stringify(payload.capabilities),
      Date.now(),
    );
    this.audit(actor.agentId, "tenant.member.joined", {
      tenantId: tenant.id,
      grantId: payload.grantId,
    });
    return json({
      tenantId: tenant.id,
      role: "member",
      capabilities: payload.capabilities,
    });
  }

  async listMessages({ actor, room }) {
    if (typeof room !== "string" || !ROOM_PATTERN.test(room))
      return json({ error: "Invalid room" }, 400);
    const member = this.requireCapability(actor, "messages.read");
    if (member instanceof Response) return member;
    const messages = this.sql
      .exec(
        `SELECT id, room, agent_id AS agentId, body, created_at AS createdAt
       FROM messages WHERE room = ? ORDER BY created_at DESC LIMIT 100`,
        room,
      )
      .toArray()
      .reverse();
    return json({ messages });
  }

  async createMessage({ actor, room, body }) {
    if (
      typeof room !== "string" ||
      !ROOM_PATTERN.test(room) ||
      typeof body !== "string"
    )
      return json({ error: "Invalid message" }, 400);
    const text = body.trim();
    if (!text || text.length > 4_000)
      return json({ error: "Invalid message" }, 400);
    const member = this.requireCapability(actor, "messages.write");
    if (member instanceof Response) return member;
    const limited = this.takeActionRateLimit(
      actor.agentId,
      "messages.write",
      MAX_MESSAGE_WRITES_PER_AGENT_WINDOW,
      MAX_MESSAGE_WRITES_PER_TENANT_WINDOW,
    );
    if (limited) return limited;
    const message = {
      id: crypto.randomUUID(),
      room,
      agentId: actor.agentId,
      body: text,
      createdAt: Date.now(),
    };
    this.sql.exec(
      "INSERT INTO messages (id, room, agent_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
      message.id,
      room,
      actor.agentId,
      text,
      message.createdAt,
    );
    this.sql.exec(
      `DELETE FROM messages
       WHERE id IN (
         SELECT id FROM messages
         ORDER BY created_at DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
      MAX_MESSAGES_PER_TENANT,
    );
    this.audit(actor.agentId, "message.created", {
      id: message.id,
      room,
      bodyLength: text.length,
    });
    await this.broadcast(
      room,
      { type: "message.created", message },
      "messages.read",
    );
    return json({ message }, 201);
  }

  async authDirectory() {
    return this.env.AUTH_DIRECTORY.get(
      this.env.AUTH_DIRECTORY.idFromName("global"),
    );
  }

  async verifiedSocketSession(sessionId) {
    const auth = await this.authDirectory();
    const session = await auth.verifySessionId(sessionId);
    const member = session && this.member(session.agentId);
    return member ? { ...session, member } : null;
  }

  async hasOtherPresence(room, agentId, excludedSocket) {
    const auth = await this.authDirectory();
    for (const candidate of this.ctx.getWebSockets()) {
      if (
        candidate === excludedSocket ||
        candidate.readyState !== WebSocket.OPEN
      )
        continue;
      const attachment = candidate.deserializeAttachment();
      if (
        !attachment?.authenticated ||
        attachment.room !== room ||
        attachment.agentId !== agentId
      )
        continue;
      const session = await auth.verifySessionId(attachment.sessionId);
      const member = session && this.member(session.agentId);
      if (
        session?.capabilities.includes("presence.read") &&
        session.capabilities.includes("presence.publish") &&
        member?.capabilities.includes("presence.read") &&
        member.capabilities.includes("presence.publish")
      )
        return true;
    }
    return false;
  }

  async broadcast(room, event, capability) {
    const auth = await this.authDirectory();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (
        !attachment?.authenticated ||
        attachment.room !== room ||
        socket.readyState !== WebSocket.OPEN
      )
        continue;
      const session = await auth.verifySessionId(attachment.sessionId);
      const member = session && this.member(session.agentId);
      if (
        session?.capabilities.includes(capability) &&
        member?.capabilities.includes(capability)
      ) {
        if (
          event.type?.startsWith("presence.") &&
          event.agent?.id === session.agentId
        )
          continue;
        try {
          socket.send(JSON.stringify(event));
        } catch {
          socket.close(1011, "delivery failed");
        }
      } else {
        socket.close(4401, "authorization expired");
      }
    }
  }

  async fetch(request) {
    const path = new URL(request.url).pathname.split("/").filter(Boolean);
    if (path[0] !== "internal") return json({ error: "Not found" }, 404);
    if (
      path[1] === "events" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      const room = path[2] ?? "";
      if (!ROOM_PATTERN.test(room)) return json({ error: "Invalid room" }, 400);
      const sockets = this.ctx.getWebSockets();
      const unauthenticatedSockets = sockets.filter(
        (socket) => !socket.deserializeAttachment()?.authenticated,
      ).length;
      if (
        sockets.length >= MAX_TENANT_WEBSOCKETS ||
        unauthenticatedSockets >= MAX_UNAUTHENTICATED_WEBSOCKETS
      )
        return json({ error: "WebSocket capacity reached" }, 429);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const authDeadline = Date.now() + WEBSOCKET_AUTH_TIMEOUT_MS;
      server.serializeAttachment({ room, authenticated: false, authDeadline });
      const earliestDeadline = this.ctx
        .getWebSockets()
        .map((socket) => socket.deserializeAttachment())
        .filter((attachment) => !attachment?.authenticated)
        .reduce(
          (earliest, attachment) => Math.min(earliest, attachment.authDeadline),
          authDeadline,
        );
      await this.ctx.storage.setAlarm(earliestDeadline);
      server.send(JSON.stringify({ type: "auth.required" }));
      return new Response(null, { status: 101, webSocket: client });
    }
    const text = await request.text();
    const data = text
      ? parseJson(text)
      : {
          actor: parseJson(request.headers.get("x-ai-auth-actor") ?? ""),
        };
    if (!data) return json({ error: "Invalid request" }, 400);
    if (path[1] === "initialize" && request.method === "POST")
      return json(await this.initializeTenant(data), 201);
    if (path[1] === "tenant" && request.method === "DELETE")
      return this.deleteTenant(data);
    if (path[1] === "invitations" && request.method === "POST")
      return this.createInvitation(data);
    if (path[1] === "invitations" && path[2] && request.method === "DELETE")
      return this.revokeInvitation({ ...data, grantId: path[2] });
    if (path[1] === "members" && path[2] && request.method === "DELETE")
      return this.revokeMember({
        ...data,
        agentId: decodeURIComponent(path[2]),
      });
    if (path[1] === "join" && request.method === "POST")
      return this.acceptInvitation(data);
    if (path[1] === "messages" && request.method === "GET")
      return this.listMessages({ ...data, room: path[2] ?? "" });
    if (path[1] === "messages" && request.method === "POST")
      return this.createMessage({ ...data, room: path[2] ?? "" });
    return json({ error: "Not found" }, 404);
  }

  async alarm() {
    const now = Date.now();
    let nextDeadline;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (
        attachment?.authenticated ||
        typeof attachment?.authDeadline !== "number"
      )
        continue;
      if (attachment.authDeadline <= now) {
        socket.close(4408, "authentication timeout");
      } else {
        nextDeadline = Math.min(
          nextDeadline ?? attachment.authDeadline,
          attachment.authDeadline,
        );
      }
    }
    if (nextDeadline !== undefined)
      await this.ctx.storage.setAlarm(nextDeadline);
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    if (typeof message !== "string" || message.length > 8_192) {
      socket.close(1009, "message too large");
      return;
    }
    const data = parseJson(message);
    if (!data || typeof data.type !== "string") {
      socket.close(1003, "invalid message");
      return;
    }
    if (!attachment?.authenticated) {
      if (
        typeof attachment?.authDeadline !== "number" ||
        attachment.authDeadline <= Date.now()
      ) {
        socket.close(4408, "authentication timeout");
        return;
      }
      if (data.type !== "authenticate" || typeof data.token !== "string") {
        socket.close(4401, "authentication required");
        return;
      }
      const auth = await this.authDirectory();
      const session = await auth.verifySessionToken(data.token);
      const member = session && this.member(session.agentId);
      if (
        !session ||
        !member?.capabilities.includes("presence.read") ||
        !session.capabilities.includes("presence.read")
      ) {
        socket.close(4401, "unauthorized");
        return;
      }
      const alreadyPresent = await this.hasOtherPresence(
        attachment.room,
        session.agentId,
        socket,
      );
      const agentSockets = this.ctx.getWebSockets().filter((candidate) => {
        const current = candidate.deserializeAttachment();
        return current?.authenticated && current.agentId === session.agentId;
      }).length;
      if (agentSockets >= MAX_WEBSOCKETS_PER_AGENT) {
        socket.close(4429, "agent connection limit reached");
        return;
      }
      socket.serializeAttachment({
        room: attachment.room,
        authenticated: true,
        agentId: session.agentId,
        sessionId: session.id,
      });
      socket.send(
        JSON.stringify({
          type: "session.authenticated",
          expiresAt: session.expiresAt,
        }),
      );
      const peers = new Set();
      for (const peerSocket of this.ctx.getWebSockets()) {
        if (peerSocket === socket) continue;
        const peer = peerSocket.deserializeAttachment();
        if (!peer?.authenticated || peer.room !== attachment.room) continue;
        const peerSession = await auth.verifySessionId(peer.sessionId);
        const peerMember = peerSession && this.member(peerSession.agentId);
        if (
          peerSession?.capabilities.includes("presence.read") &&
          peerSession.capabilities.includes("presence.publish") &&
          peerMember?.capabilities.includes("presence.read") &&
          peerMember.capabilities.includes("presence.publish") &&
          peerSession.agentId !== session.agentId
        )
          peers.add(peerSession.agentId);
      }
      socket.send(
        JSON.stringify({
          type: "presence.snapshot",
          peers: [...peers].map((id) => ({ id })),
        }),
      );
      if (
        !alreadyPresent &&
        member.capabilities.includes("presence.publish") &&
        session.capabilities.includes("presence.publish")
      ) {
        await this.broadcast(
          attachment.room,
          { type: "presence.joined", agent: { id: session.agentId } },
          "presence.read",
        );
      }
      return;
    }

    const session = await this.verifiedSocketSession(attachment.sessionId);
    if (!session) {
      socket.close(4401, "session expired or revoked");
      return;
    }
    if (data.type === "presence.update") {
      if (
        !session.member.capabilities.includes("presence.publish") ||
        !session.capabilities.includes("presence.publish")
      ) {
        socket.close(4403, "presence permission required");
        return;
      }
      const limited = this.takeActionRateLimit(
        session.agentId,
        "presence.update",
        MAX_PRESENCE_UPDATES_PER_AGENT_WINDOW,
        MAX_PRESENCE_UPDATES_PER_TENANT_WINDOW,
      );
      if (limited) {
        socket.send(
          JSON.stringify({ type: "error", error: "Rate limit exceeded" }),
        );
        return;
      }
      await this.broadcast(
        attachment.room,
        {
          type: "presence.updated",
          agent: { id: session.agentId },
          status: data.status === "busy" ? "busy" : "online",
        },
        "presence.read",
      );
      return;
    }
    if (data.type === "message.send") {
      const result = await this.createMessage({
        actor: session,
        room: attachment.room,
        body: data.body,
      });
      if (!result.ok)
        socket.send(
          JSON.stringify({ type: "error", error: "Message was rejected" }),
        );
      return;
    }
    socket.send(JSON.stringify({ type: "error", error: "Unknown event" }));
  }

  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    if (
      attachment?.authenticated &&
      this.member(attachment.agentId) &&
      !(await this.hasOtherPresence(
        attachment.room,
        attachment.agentId,
        socket,
      ))
    ) {
      await this.broadcast(
        attachment.room,
        {
          type: "presence.left",
          agent: { id: attachment.agentId },
        },
        "presence.read",
      );
    }
    socket.close();
  }
}
