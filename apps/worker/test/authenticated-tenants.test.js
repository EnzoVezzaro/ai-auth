import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  approvePermissionRequest,
  createCapabilityGrant,
  identityFor,
  signEnvelope,
} from "../../../packages/p2p/index.js";
import { createServiceClient } from "../../../packages/p2p/service.js";
import { createAIAuthMcpServer } from "../../../packages/mcp/index.js";

const APP_ORIGIN = "http://localhost:4173";
const OWNER_SCOPES = [
  "tenant.create",
  "tenant.delete",
  "tenant.invite",
  "tenant.member.revoke",
  "messages.read",
  "messages.write",
  "presence.read",
  "presence.publish",
];
const GUEST_SCOPES = [
  "tenant.join",
  "messages.read",
  "messages.write",
  "presence.read",
  "presence.publish",
];

async function wallet() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  return {
    id,
    publicKey,
    privateKey: pair.privateKey,
    sign: (type, payload) =>
      signEnvelope(
        { id, publicKey, privateKey: pair.privateKey },
        type,
        payload,
      ),
  };
}

async function call(
  path,
  { method = "GET", body, token, origin = APP_ORIGIN, clientIp } = {},
) {
  const headers = { origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (clientIp) headers["cf-connecting-ip"] = clientIp;
  return exports.default.fetch(`https://ai-auth-backend.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(agent, capabilities) {
  const challengeResponse = await call("/v1/auth/challenge", {
    method: "POST",
    body: { capabilities },
  });
  expect(challengeResponse.status).toBe(201);
  const { request } = await challengeResponse.json();
  const consent = await approvePermissionRequest(agent, request, capabilities);
  const sessionResponse = await call("/v1/auth/session", {
    method: "POST",
    body: { consent },
  });
  expect(sessionResponse.status).toBe(201);
  return sessionResponse.json();
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket event")),
      1_000,
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(event.data));
      },
      { once: true },
    );
  });
}

function nextClose(socket) {
  return new Promise((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
}

function messageWithin(socket, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(event.data));
      },
      { once: true },
    );
  });
}

async function connectPresence(tenantId, token) {
  const response = await exports.default.fetch(
    `https://ai-auth-backend.test/v1/tenants/${tenantId}/rooms/build/events`,
    {
      headers: {
        origin: APP_ORIGIN,
        upgrade: "websocket",
        "cf-connecting-ip": crypto.randomUUID(),
      },
    },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  socket.accept();
  expect(await nextMessage(socket)).toEqual({ type: "auth.required" });
  const authenticated = nextMessage(socket);
  socket.send(JSON.stringify({ type: "authenticate", token }));
  expect((await authenticated).type).toBe("session.authenticated");
  const snapshot = await nextMessage(socket);
  expect(snapshot.type).toBe("presence.snapshot");
  socket.presenceSnapshot = snapshot.peers;
  return socket;
}

test("signed wallet sessions create isolated tenants and authorize delegated collaboration", async () => {
  const owner = await wallet();
  const guest = await wallet();
  const outsider = await wallet();
  const ownerSession = await login(owner, OWNER_SCOPES);
  const guestSession = await login(guest, GUEST_SCOPES);
  const outsiderSession = await login(outsider, ["messages.read"]);

  const create = await call("/v1/tenants", {
    method: "POST",
    token: ownerSession.token,
    body: { name: "Research" },
  });
  expect(create.status).toBe(201);
  const { tenant } = await create.json();

  const invite = await createCapabilityGrant(owner, {
    recipient: guest.id,
    resource: `tenant:${tenant.tenantId}`,
    capabilities: GUEST_SCOPES,
    expiresAt: Date.now() + 60_000,
  });
  const issued = await call(`/v1/tenants/${tenant.tenantId}/invitations`, {
    method: "POST",
    token: ownerSession.token,
    body: { grant: invite },
  });
  expect(issued.status).toBe(201);

  const joined = await call(`/v1/tenants/${tenant.tenantId}/join`, {
    method: "POST",
    token: guestSession.token,
    body: { grant: invite },
  });
  expect(joined.status).toBe(200);

  const sent = await call(
    `/v1/tenants/${tenant.tenantId}/rooms/build/messages`,
    {
      method: "POST",
      token: guestSession.token,
      body: { body: "signed wallet collaboration" },
    },
  );
  expect(sent.status).toBe(201);
  const history = await call(
    `/v1/tenants/${tenant.tenantId}/rooms/build/messages`,
    {
      token: ownerSession.token,
    },
  );
  const historyResult = await history.json();
  expect(history.status, JSON.stringify(historyResult)).toBe(200);
  expect(historyResult.messages.map((message) => message.body)).toEqual([
    "signed wallet collaboration",
  ]);

  const outsiderRead = await call(
    `/v1/tenants/${tenant.tenantId}/rooms/build/messages`,
    {
      token: outsiderSession.token,
    },
  );
  expect(outsiderRead.status).toBe(403);
  const replayedInvite = await call(`/v1/tenants/${tenant.tenantId}/join`, {
    method: "POST",
    token: guestSession.token,
    body: { grant: invite },
  });
  expect(replayedInvite.status).toBe(409);

  const revokedInvite = await call(
    `/v1/tenants/${tenant.tenantId}/invitations/${invite.body.payload.grantId}`,
    { method: "DELETE", token: ownerSession.token },
  );
  expect(revokedInvite.status).toBe(200);
  const reissuedInvite = await call(
    `/v1/tenants/${tenant.tenantId}/invitations`,
    { method: "POST", token: ownerSession.token, body: { grant: invite } },
  );
  expect(reissuedInvite.status).toBe(201);
  const replayAfterReissue = await call(`/v1/tenants/${tenant.tenantId}/join`, {
    method: "POST",
    token: guestSession.token,
    body: { grant: invite },
  });
  expect(replayAfterReissue.status).toBe(409);

  const repeatRead = await call(
    `/v1/tenants/${tenant.tenantId}/rooms/build/messages`,
    {
      token: guestSession.token,
    },
  );
  expect((await repeatRead.json()).messages).toHaveLength(1);
  await abortAllDurableObjects();
  const afterRestart = await call(
    `/v1/tenants/${tenant.tenantId}/rooms/build/messages`,
    { token: guestSession.token },
  );
  expect(afterRestart.status).toBe(200);
  expect((await afterRestart.json()).messages).toHaveLength(1);
  const revoked = await call(
    `/v1/tenants/${tenant.tenantId}/members/${encodeURIComponent(guest.id)}`,
    { method: "DELETE", token: ownerSession.token },
  );
  expect(revoked.status).toBe(200);
  const afterRevoke = await call(
    `/v1/tenants/${tenant.tenantId}/rooms/build/messages`,
    { token: guestSession.token },
  );
  expect(afterRevoke.status).toBe(403);
});

test("consent challenges are origin-bound and single-use; revocation blocks later requests", async () => {
  const agent = await wallet();
  const blockedOrigin = await call("/v1/auth/challenge", {
    method: "POST",
    origin: "https://untrusted.example",
    body: { capabilities: ["messages.read"] },
  });
  expect(blockedOrigin.status).toBe(403);

  const challengeResponse = await call("/v1/auth/challenge", {
    method: "POST",
    body: { capabilities: ["tenant.create"] },
  });
  const { request } = await challengeResponse.json();
  const consent = await approvePermissionRequest(agent, request, [
    "tenant.create",
  ]);
  const loginResponse = await call("/v1/auth/session", {
    method: "POST",
    body: { consent },
  });
  expect(loginResponse.status).toBe(201);
  const session = await loginResponse.json();

  const replayResponse = await call("/v1/auth/session", {
    method: "POST",
    body: { consent },
  });
  expect(replayResponse.status).toBe(401);
  const revoked = await call("/v1/auth/session/revoke", {
    method: "POST",
    token: session.token,
    body: {},
  });
  expect(revoked.status).toBe(200);
  const tenantCreate = await call("/v1/tenants", {
    method: "POST",
    token: session.token,
    body: { name: "Should fail" },
  });
  expect(tenantCreate.status).toBe(401);
});

test("concurrent logins cannot exceed the per-agent active-session cap", async () => {
  const agent = await wallet();
  const capabilities = ["messages.read"];
  const consents = await Promise.all(
    Array.from({ length: 12 }, async () => {
      const challengeResponse = await call("/v1/auth/challenge", {
        method: "POST",
        body: { capabilities },
      });
      expect(challengeResponse.status).toBe(201);
      const { request } = await challengeResponse.json();
      return approvePermissionRequest(agent, request, capabilities);
    }),
  );
  const responses = await Promise.all(
    consents.map((consent) =>
      call("/v1/auth/session", { method: "POST", body: { consent } }),
    ),
  );
  expect(responses.filter((response) => response.status === 201)).toHaveLength(
    10,
  );
  expect(responses.filter((response) => response.status === 401)).toHaveLength(
    2,
  );
});

test("health route checks durable authorization storage", async () => {
  const response = await call("/v1/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    ready: true,
    version: "0.1.0",
  });
});

test("request telemetry records bounded outcome data without request identifiers", async () => {
  const logger = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const response = await call(
      "/v1/private-tenant-123/room-secret?token=query-secret",
      { clientIp: "192.0.2.200" },
    );
    expect(response.status).toBe(401);

    const started = logger.mock.calls.find(
      ([event]) => event === "http.request.started",
    );
    expect(started).toEqual([
      "http.request.started",
      { method: "GET", routeGroup: "other" },
    ]);

    const completed = logger.mock.calls.find(
      ([event]) => event === "http.request.completed",
    );
    expect(completed?.[1]).toMatchObject({
      method: "GET",
      routeGroup: "other",
      statusCode: 401,
    });
    expect(completed?.[1].durationMs).toEqual(expect.any(Number));
    expect(completed?.[1].durationMs).toBeGreaterThanOrEqual(0);
    const serializedEvents = JSON.stringify(logger.mock.calls);
    expect(serializedEvents).not.toContain("private-tenant-123");
    expect(serializedEvents).not.toContain("room-secret");
    expect(serializedEvents).not.toContain("query-secret");
    expect(serializedEvents).not.toContain("192.0.2.200");

    logger.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const healthy = await call("/v1/health");
    expect(healthy.status).toBe(200);
  } finally {
    logger.mockRestore();
  }
});

test("challenge issuance is bounded per client and audience", async () => {
  for (let index = 0; index < 60; index += 1) {
    const response = await call("/v1/auth/challenge", {
      method: "POST",
      clientIp: "192.0.2.10",
      body: { capabilities: ["messages.read"] },
    });
    expect(response.status).toBe(201);
  }
  const limited = await call("/v1/auth/challenge", {
    method: "POST",
    clientIp: "192.0.2.10",
    body: { capabilities: ["messages.read"] },
  });
  expect(limited.status).toBe(429);

  const otherClient = await call("/v1/auth/challenge", {
    method: "POST",
    clientIp: "192.0.2.11",
    body: { capabilities: ["messages.read"] },
  });
  expect(otherClient.status).toBe(201);
});

test("unknown tenant IDs are rejected before websocket workspace allocation", async () => {
  const tenantId = crypto.randomUUID();
  const response = await exports.default.fetch(
    `https://ai-auth-backend.test/v1/tenants/${tenantId}/rooms/build/events`,
    {
      headers: {
        origin: APP_ORIGIN,
        upgrade: "websocket",
        "cf-connecting-ip": crypto.randomUUID(),
      },
    },
  );
  expect(response.status).toBe(404);
});

test("tenant owners can delete workspaces and clear tenant records", async () => {
  const owner = await wallet();
  const session = await login(owner, OWNER_SCOPES);
  const created = await call("/v1/tenants", {
    method: "POST",
    token: session.token,
    body: { name: "Temporary workspace" },
  });
  const { tenant } = await created.json();

  const deleted = await call(`/v1/tenants/${tenant.tenantId}`, {
    method: "DELETE",
    token: session.token,
  });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true });

  const missing = await call(
    `/v1/tenants/${tenant.tenantId}/rooms/build/messages`,
    { token: session.token },
  );
  expect(missing.status).toBe(404);
});

test("tenant deletion does not reset lifetime creation quotas", async () => {
  const ownerAgentId = `agent:lifetime-quota-${crypto.randomUUID()}`;
  const directory = env.AUTH_DIRECTORY.get(
    env.AUTH_DIRECTORY.idFromName("global"),
  );
  await runInDurableObject(directory, async (instance) => {
    for (let index = 0; index < 100; index += 1) {
      const tenantId = crypto.randomUUID();
      expect(await instance.registerTenant({ tenantId, ownerAgentId })).toBe(
        true,
      );
      await instance.removeTenant({ tenantId, ownerAgentId });
    }
    expect(
      await instance.registerTenant({
        tenantId: crypto.randomUUID(),
        ownerAgentId,
      }),
    ).toBe(false);
  });
});

test("expired invitations are purged and active invitation storage is capped", async () => {
  const owner = await wallet();
  const guest = await wallet();
  const session = await login(owner, OWNER_SCOPES);
  const created = await call("/v1/tenants", {
    method: "POST",
    token: session.token,
    body: { name: "Invitation retention" },
  });
  const { tenant } = await created.json();
  const grant = await createCapabilityGrant(owner, {
    recipient: guest.id,
    resource: `tenant:${tenant.tenantId}`,
    capabilities: GUEST_SCOPES,
    expiresAt: Date.now() + 60_000,
  });
  const stub = env.WORKSPACES.get(env.WORKSPACES.idFromName(tenant.tenantId));

  await runInDurableObject(stub, async (instance) => {
    for (let index = 0; index < 1_000; index += 1) {
      instance.sql.exec(
        "INSERT INTO invitations (grant_id, recipient, grant_json, expires_at) VALUES (?, ?, ?, ?)",
        `active-${index}`,
        guest.id,
        "{}",
        Date.now() + 60_000,
      );
    }
  });
  const capped = await call(`/v1/tenants/${tenant.tenantId}/invitations`, {
    method: "POST",
    token: session.token,
    body: { grant },
  });
  expect(capped.status).toBe(429);

  await runInDurableObject(stub, async (instance) => {
    instance.sql.exec("UPDATE invitations SET expires_at = ?", Date.now() - 1);
    instance.sql.exec(
      "INSERT INTO used_grants (grant_id, consumed_at) VALUES (?, ?)",
      "expired-grant",
      Date.now() - 1,
    );
  });
  const issued = await call(`/v1/tenants/${tenant.tenantId}/invitations`, {
    method: "POST",
    token: session.token,
    body: { grant },
  });
  expect(issued.status).toBe(201);
  await runInDurableObject(stub, async (instance) => {
    expect(
      instance.sql
        .exec("SELECT COUNT(*) AS count FROM invitations")
        .toArray()[0].count,
    ).toBe(1);
    expect(
      instance.sql
        .exec("SELECT COUNT(*) AS count FROM used_grants")
        .toArray()[0].count,
    ).toBe(0);
  });
});

test("the same room name is isolated across tenant workspaces", async () => {
  const firstOwner = await wallet();
  const secondOwner = await wallet();
  const firstSession = await login(firstOwner, OWNER_SCOPES);
  const secondSession = await login(secondOwner, OWNER_SCOPES);
  const firstCreate = await call("/v1/tenants", {
    method: "POST",
    token: firstSession.token,
    body: { name: "First" },
  });
  const secondCreate = await call("/v1/tenants", {
    method: "POST",
    token: secondSession.token,
    body: { name: "Second" },
  });
  const firstTenant = (await firstCreate.json()).tenant;
  const secondTenant = (await secondCreate.json()).tenant;
  expect(firstTenant.tenantId).not.toBe(secondTenant.tenantId);

  await call(`/v1/tenants/${firstTenant.tenantId}/rooms/shared/messages`, {
    method: "POST",
    token: firstSession.token,
    body: { body: "private to first tenant" },
  });
  const secondHistory = await call(
    `/v1/tenants/${secondTenant.tenantId}/rooms/shared/messages`,
    {
      token: secondSession.token,
    },
  );
  const secondResult = await secondHistory.json();
  expect(secondHistory.status, JSON.stringify(secondResult)).toBe(200);
  expect(secondResult.messages).toEqual([]);
});

test("WebSocket presence requires a wallet session and publishes authenticated peers", async () => {
  const owner = await wallet();
  const guest = await wallet();
  const ownerSession = await login(owner, OWNER_SCOPES);
  const guestSession = await login(guest, GUEST_SCOPES);
  const created = await call("/v1/tenants", {
    method: "POST",
    token: ownerSession.token,
    body: { name: "Presence" },
  });
  const { tenant } = await created.json();
  const grant = await createCapabilityGrant(owner, {
    recipient: guest.id,
    resource: `tenant:${tenant.tenantId}`,
    capabilities: GUEST_SCOPES,
    expiresAt: Date.now() + 60_000,
  });
  const issued = await call(`/v1/tenants/${tenant.tenantId}/invitations`, {
    method: "POST",
    token: ownerSession.token,
    body: { grant },
  });
  expect(issued.status).toBe(201);
  const joined = await call(`/v1/tenants/${tenant.tenantId}/join`, {
    method: "POST",
    token: guestSession.token,
    body: { grant },
  });
  expect(joined.status).toBe(200);

  const ownerSocket = await connectPresence(
    tenant.tenantId,
    ownerSession.token,
  );
  const ownerSocket2 = await connectPresence(
    tenant.tenantId,
    ownerSession.token,
  );
  expect(ownerSocket2.presenceSnapshot).toEqual([]);
  const peerJoined = nextMessage(ownerSocket);
  const peerJoined2 = nextMessage(ownerSocket2);
  const guestSocket = await connectPresence(
    tenant.tenantId,
    guestSession.token,
  );
  expect(await peerJoined).toMatchObject({
    type: "presence.joined",
    agent: { id: guest.id },
  });
  expect(await peerJoined2).toMatchObject({
    type: "presence.joined",
    agent: { id: guest.id },
  });
  expect(guestSocket.presenceSnapshot).toEqual([{ id: owner.id }]);

  const rateLimitError = new Promise((resolve) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "error") resolve(message);
      else ownerSocket.addEventListener("message", onMessage, { once: true });
    };
    ownerSocket.addEventListener("message", onMessage, { once: true });
  });
  const updatesReceived = new Promise((resolve, reject) => {
    let count = 0;
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for presence updates")),
      1_000,
    );
    guestSocket.addEventListener("message", (event) => {
      if (JSON.parse(event.data).type !== "presence.updated") return;
      count += 1;
      if (count === 30) {
        clearTimeout(timeout);
        resolve(count);
      }
    });
  });
  for (let index = 0; index < 31; index += 1)
    ownerSocket.send(
      JSON.stringify({ type: "presence.update", status: "busy" }),
    );
  expect(await rateLimitError).toEqual({
    type: "error",
    error: "Rate limit exceeded",
  });
  expect(await updatesReceived).toBe(30);

  ownerSocket.close();
  expect(await messageWithin(guestSocket, 50)).toBeNull();
  const ownerLeft = nextMessage(guestSocket);
  ownerSocket2.close();
  expect(await ownerLeft).toMatchObject({
    type: "presence.left",
    agent: { id: owner.id },
  });
  guestSocket.close();
});

test("unauthenticated WebSockets are closed by the Durable Object alarm", async () => {
  const owner = await wallet();
  const ownerSession = await login(owner, OWNER_SCOPES);
  const created = await call("/v1/tenants", {
    method: "POST",
    token: ownerSession.token,
    body: { name: "Socket timeout" },
  });
  const { tenant } = await created.json();
  const tenantId = tenant.tenantId;
  const response = await exports.default.fetch(
    `https://ai-auth-backend.test/v1/tenants/${tenantId}/rooms/build/events`,
    {
      headers: {
        origin: APP_ORIGIN,
        upgrade: "websocket",
        "cf-connecting-ip": crypto.randomUUID(),
      },
    },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  socket.accept();
  expect(await nextMessage(socket)).toEqual({ type: "auth.required" });
  const closed = nextClose(socket);

  const stub = env.WORKSPACES.get(env.WORKSPACES.idFromName(tenantId));
  await runInDurableObject(stub, async (instance) => {
    const serverSocket = instance.ctx.getWebSockets()[0];
    const attachment = serverSocket.deserializeAttachment();
    serverSocket.serializeAttachment({
      ...attachment,
      authDeadline: Date.now() - 1,
    });
    await instance.alarm();
  });
  expect(await closed).toMatchObject({ code: 4408 });
});

test("WebSocket upgrade attempts are throttled per source IP", async () => {
  const owner = await wallet();
  const ownerSession = await login(owner, OWNER_SCOPES);
  const created = await call("/v1/tenants", {
    method: "POST",
    token: ownerSession.token,
    body: { name: "Handshake limits" },
  });
  const { tenant } = await created.json();
  const ip = "198.51.100.42";
  const sockets = [];

  for (let index = 0; index < 4; index += 1) {
    const response = await exports.default.fetch(
      `https://ai-auth-backend.test/v1/tenants/${tenant.tenantId}/rooms/build/events`,
      {
        headers: {
          origin: APP_ORIGIN,
          upgrade: "websocket",
          "cf-connecting-ip": ip,
        },
      },
    );
    expect(response.status).toBe(101);
    response.webSocket.accept();
    sockets.push(response.webSocket);
  }

  const limited = await exports.default.fetch(
    `https://ai-auth-backend.test/v1/tenants/${tenant.tenantId}/rooms/build/events`,
    {
      headers: {
        origin: APP_ORIGIN,
        upgrade: "websocket",
        "cf-connecting-ip": ip,
      },
    },
  );
  expect(limited.status).toBe(429);
  expect(limited.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
  const directory = env.AUTH_DIRECTORY.get(
    env.AUTH_DIRECTORY.idFromName("global"),
  );
  await runInDurableObject(directory, (instance) => {
    const rows = instance.sql
      .exec(
        "SELECT active_keys, (SELECT COUNT(*) FROM websocket_rate_limits) AS actual FROM websocket_rate_limit_capacity WHERE id = 1",
      )
      .toArray();
    expect(rows[0].active_keys).toBe(rows[0].actual);
  });
  for (const socket of sockets) socket.close();
});

test("message writes are rate limited before mutating tenant history", async () => {
  const owner = await wallet();
  const ownerSession = await login(owner, OWNER_SCOPES);
  const created = await call("/v1/tenants", {
    method: "POST",
    token: ownerSession.token,
    body: { name: "Write limits" },
  });
  const { tenant } = await created.json();
  const stub = env.WORKSPACES.get(env.WORKSPACES.idFromName(tenant.tenantId));

  await runInDurableObject(stub, async (instance) => {
    for (let index = 0; index < 60; index += 1) {
      const response = await instance.createMessage({
        actor: { agentId: owner.id, capabilities: OWNER_SCOPES },
        room: "build",
        body: `message ${index}`,
      });
      expect(response.status).toBe(201);
    }
    const limited = await instance.createMessage({
      actor: { agentId: owner.id, capabilities: OWNER_SCOPES },
      room: "build",
      body: "over the limit",
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(
      instance.sql.exec("SELECT COUNT(*) AS count FROM messages").toArray()[0]
        .count,
    ).toBe(60);
  });
});

test("presence updates share a durable per-agent rate limit", async () => {
  const owner = await wallet();
  const ownerSession = await login(owner, OWNER_SCOPES);
  const created = await call("/v1/tenants", {
    method: "POST",
    token: ownerSession.token,
    body: { name: "Presence limits" },
  });
  const { tenant } = await created.json();
  const stub = env.WORKSPACES.get(env.WORKSPACES.idFromName(tenant.tenantId));

  await runInDurableObject(stub, (instance) => {
    for (let index = 0; index < 30; index += 1)
      expect(
        instance.takeActionRateLimit(owner.id, "presence.update", 30, 300),
      ).toBeNull();
    expect(
      instance.takeActionRateLimit(owner.id, "presence.update", 30, 300).status,
    ).toBe(429);
    for (let index = 0; index < 2; index += 1)
      expect(
        instance.takeActionRateLimit("agent:second", "aggregate.test", 2, 3),
      ).toBeNull();
    expect(
      instance.takeActionRateLimit("agent:third", "aggregate.test", 2, 3),
    ).toBeNull();
    expect(
      instance.takeActionRateLimit("agent:third", "aggregate.test", 2, 3)
        .status,
    ).toBe(429);
  });
});

test("tenant message history remains bounded at the retention limit", async () => {
  const owner = await wallet();
  const ownerSession = await login(owner, OWNER_SCOPES);
  const created = await call("/v1/tenants", {
    method: "POST",
    token: ownerSession.token,
    body: { name: "Bounded history" },
  });
  const { tenant } = await created.json();
  const stub = env.WORKSPACES.get(env.WORKSPACES.idFromName(tenant.tenantId));

  await runInDurableObject(stub, async (instance) => {
    for (let index = 0; index < 1_000; index += 1) {
      instance.sql.exec(
        "INSERT INTO messages (id, room, agent_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        `seed-${index}`,
        "build",
        owner.id,
        `seed ${index}`,
        index,
      );
    }
    const response = await instance.createMessage({
      actor: { agentId: owner.id, capabilities: OWNER_SCOPES },
      room: "build",
      body: "latest retained message",
    });
    expect(response.status).toBe(201);
    const count = instance.sql
      .exec("SELECT COUNT(*) AS count FROM messages")
      .toArray()[0].count;
    expect(count).toBe(1_000);
    const latest = instance.sql
      .exec("SELECT body FROM messages WHERE id = ?", "seed-0")
      .toArray();
    expect(latest).toEqual([]);
  });
});

test("MCP wallet session creates a workspace and performs authorized shared-state operations", async () => {
  const agent = await wallet();
  const serviceClient = createServiceClient({
    baseUrl: "https://ai-auth-backend.test",
    audience: APP_ORIGIN,
    fetchImpl: async (url, init) => {
      const headers = new Headers(init.headers);
      headers.set("origin", APP_ORIGIN);
      headers.set("cf-connecting-ip", "192.0.2.12");
      return exports.default.fetch(
        `https://ai-auth-backend.test${new URL(url).pathname}`,
        { ...init, headers },
      );
    },
  });
  const { server, session } = await createAIAuthMcpServer({
    serviceClient,
    wallet: agent,
    requestedCapabilities: ["tenant.create", "messages.read", "messages.write"],
    approveCapabilities: async (requested) => requested,
  });
  const client = new Client({ name: "worker-mcp-e2e", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const created = await client.callTool({
      name: "ai_auth_create_tenant",
      arguments: { name: "MCP integration" },
    });
    expect(created.isError).not.toBe(true);
    const tenantId = created.structuredContent.tenant.tenantId;
    const sent = await client.callTool({
      name: "ai_auth_send_message",
      arguments: {
        tenantId,
        room: "research",
        body: "MCP uses the wallet-authorized session",
      },
    });
    expect(sent.isError).not.toBe(true);
    const history = await client.callTool({
      name: "ai_auth_list_messages",
      arguments: { tenantId, room: "research" },
    });
    expect(history.structuredContent.messages).toHaveLength(1);
    expect(history.structuredContent.messages[0].body).toBe(
      "MCP uses the wallet-authorized session",
    );
    expect(JSON.stringify([created, sent, history])).not.toContain(
      session.token,
    );
  } finally {
    await client.close();
    await clientTransport.close();
    await serverTransport.close();
    await server.close();
  }
});
