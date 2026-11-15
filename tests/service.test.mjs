import test from "node:test";
import assert from "node:assert/strict";
import {
  createPermissionRequest,
  identityFor,
  verifyPermissionConsent,
} from "../packages/p2p/index.js";
import { createServiceClient } from "../packages/p2p/service.js";

async function wallet() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    id: await identityFor(publicKey),
    publicKey,
    privateKey: pair.privateKey,
  };
}

class TestWebSocket {
  listeners = new Map();
  readyState = 0;
  sent = [];

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  send(message) {
    this.sent.push(message);
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  message(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  disconnect(code = 1006) {
    this.readyState = 3;
    this.emit("close", { code });
  }

  close(code = 1000) {
    this.disconnect(code);
  }
}

test("service client signs a challenge and sends session tokens only in headers", async () => {
  const agent = await wallet();
  const challenge = await createPermissionRequest("https://app.example", [
    "tenant.create",
  ]);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1)
      return Response.json({ request: challenge }, { status: 201 });
    if (requests.length === 2)
      return Response.json(
        {
          token: "ephemeral-session-token-123456789012345678901234567890",
          session: {
            id: "session-1",
            agentId: agent.id,
            capabilities: ["tenant.create"],
            expiresAt: Date.now() + 60_000,
          },
        },
        { status: 201 },
      );
    return Response.json(
      { tenant: { tenantId: "tenant-1", ownerAgentId: agent.id } },
      { status: 201 },
    );
  };
  const client = createServiceClient({
    baseUrl: "https://api.example/",
    audience: "https://app.example",
    fetchImpl,
  });
  const session = await client.authenticate(
    agent,
    ["tenant.create"],
    ["tenant.create"],
  );
  const consent = JSON.parse(requests[1].init.body).consent;
  assert.equal(
    await verifyPermissionConsent(consent, challenge, {
      expectedOrigin: "https://app.example",
      expectedWallet: agent.id,
      nonceGuard: { consume: () => true },
    }),
    true,
  );

  const tenant = await client.createTenant(session, "Research");
  assert.equal(tenant.tenant.tenantId, "tenant-1");
  assert.equal(requests[0].init.headers.has("authorization"), false);
  assert.equal(
    JSON.parse(requests[0].init.body).audience,
    "https://app.example",
  );
  assert.equal(requests[1].init.headers.has("authorization"), false);
  assert.equal(
    requests[2].init.headers.get("authorization"),
    `Bearer ${session.token}`,
  );
  assert.equal(requests[2].init.credentials, "omit");
  assert.equal(
    requests.some(({ url }) => url.includes(session.token)),
    false,
  );
});

test("service authentication requires explicit wallet approval", async () => {
  let requestCount = 0;
  const client = createServiceClient({
    baseUrl: "https://api.example",
    audience: "https://app.example",
    fetchImpl: async () => {
      requestCount += 1;
      return Response.json({});
    },
  });
  await assert.rejects(
    client.authenticate({}, ["messages.write"]),
    /Explicit wallet-approved capabilities are required/u,
  );
  assert.equal(requestCount, 0);
});

test("service client rejects credential-bearing and non-local insecure URLs", () => {
  const options = { audience: "https://app.example" };
  assert.throws(
    () =>
      createServiceClient({
        ...options,
        baseUrl: "https://user:secret@api.example",
      }),
    /Credentials must not be embedded/u,
  );
  assert.throws(
    () =>
      createServiceClient({
        ...options,
        baseUrl: "https://api.example/?token=secret",
      }),
    /must not contain a query or fragment/u,
  );
  assert.throws(
    () => createServiceClient({ ...options, baseUrl: "http://api.example" }),
    /must use HTTPS/u,
  );
});

test("presence SDK puts the wallet token in the first frame, not the WebSocket URL", () => {
  const listeners = new Map();
  const socket = {
    sent: [],
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    send(message) {
      this.sent.push(message);
    },
  };
  let socketUrl;
  const client = createServiceClient({
    baseUrl: "https://api.example/base",
    audience: "https://app.example",
    fetchImpl: async () => Response.json({}),
    webSocketFactory(url) {
      socketUrl = url;
      return socket;
    },
  });
  const token = "in-memory-session-token";
  client.connectPresence({ token }, "tenant/one", "build room", () => {});
  assert.equal(
    socketUrl,
    "wss://api.example/base/v1/tenants/tenant%2Fone/rooms/build%20room/events",
  );
  assert.equal(socketUrl.includes(token), false);
  listeners.get("open")();
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: "authenticate", token });
});

test("presence SDK does not misreport application callback exceptions as bad JSON", () => {
  const listeners = new Map();
  const socket = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    send() {},
  };
  const received = [];
  const client = createServiceClient({
    baseUrl: "https://api.example",
    audience: "https://app.example",
    fetchImpl: async () => Response.json({}),
    webSocketFactory: () => socket,
  });
  client.connectPresence({ token: "token" }, "tenant-1", "room", (event) => {
    received.push(event);
    throw new Error("application callback failed");
  });
  assert.throws(
    () =>
      listeners.get("message")({
        data: JSON.stringify({ type: "presence.snapshot" }),
      }),
    /application callback failed/u,
  );
  assert.deepEqual(received, [{ type: "presence.snapshot" }]);
});

test("resilient presence reconnects, authenticates again, and forwards the new snapshot", async () => {
  const sockets = [];
  const events = [];
  const client = createServiceClient({
    baseUrl: "https://api.example",
    audience: "https://app.example",
    fetchImpl: async () => Response.json({}),
    webSocketFactory(url) {
      assert.equal(url.includes("session-token"), false);
      const socket = new TestWebSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const connection = client.connectPresenceResilient(
    {
      token: "session-token",
      session: { expiresAt: Date.now() + 60_000 },
    },
    "tenant-1",
    "research",
    (event) => events.push(event),
    { minDelayMs: 0, maxDelayMs: 0 },
  );

  assert.equal(sockets.length, 1);
  assert.equal(connection.connected, false);
  assert.equal(connection.sendPresence("busy"), false);
  sockets[0].open();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), {
    type: "authenticate",
    token: "session-token",
  });
  sockets[0].message({
    type: "session.authenticated",
    expiresAt: Date.now() + 60_000,
  });
  sockets[0].message({
    type: "presence.snapshot",
    peers: [{ id: "agent:first" }],
  });
  assert.equal(connection.connected, true);
  assert.equal(connection.sendPresence("busy"), true);
  assert.deepEqual(JSON.parse(sockets[0].sent[1]), {
    type: "presence.update",
    status: "busy",
  });

  sockets[0].disconnect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.deepEqual(JSON.parse(sockets[1].sent[0]), {
    type: "authenticate",
    token: "session-token",
  });
  sockets[1].message({
    type: "session.authenticated",
    expiresAt: Date.now() + 60_000,
  });
  sockets[1].message({
    type: "presence.snapshot",
    peers: [{ id: "agent:current" }],
  });
  assert.deepEqual(
    events
      .filter((event) => event.type === "presence.snapshot")
      .map((event) => event.peers),
    [[{ id: "agent:first" }], [{ id: "agent:current" }]],
  );
  assert.equal(connection.sendMessage("still connected"), true);
  assert.deepEqual(JSON.parse(sockets[1].sent[1]), {
    type: "message.send",
    body: "still connected",
  });

  connection.close();
  assert.equal(connection.connected, false);
  sockets[1].disconnect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sockets.length, 2);
});

test("resilient presence stops retrying when the server revokes the session", async () => {
  const sockets = [];
  const events = [];
  const client = createServiceClient({
    baseUrl: "https://api.example",
    audience: "https://app.example",
    fetchImpl: async () => Response.json({}),
    webSocketFactory() {
      const socket = new TestWebSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const connection = client.connectPresenceResilient(
    {
      token: "revoked-session-token",
      session: { expiresAt: Date.now() + 60_000 },
    },
    "tenant-1",
    "research",
    (event) => events.push(event),
    { minDelayMs: 0, maxDelayMs: 0 },
  );
  sockets[0].disconnect(4401);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 1);
  assert.equal(connection.connected, false);
  assert.ok(events.some((event) => event.type === "connection.closed"));
  connection.close();
});

test("resilient presence records authentication before invoking the application callback", () => {
  const socket = new TestWebSocket();
  const client = createServiceClient({
    baseUrl: "https://api.example",
    audience: "https://app.example",
    fetchImpl: async () => Response.json({}),
    webSocketFactory: () => socket,
  });
  const connection = client.connectPresenceResilient(
    {
      token: "session-token",
      session: { expiresAt: Date.now() + 60_000 },
    },
    "tenant-1",
    "research",
    () => {
      throw new Error("application callback failed");
    },
  );
  socket.open();
  assert.throws(
    () => socket.message({ type: "session.authenticated" }),
    /application callback failed/u,
  );
  assert.equal(connection.connected, true);
  connection.close();
});

test("resilient presence closes and stops reporting connected at session expiry", async () => {
  const socket = new TestWebSocket();
  const events = [];
  const client = createServiceClient({
    baseUrl: "https://api.example",
    audience: "https://app.example",
    fetchImpl: async () => Response.json({}),
    webSocketFactory: () => socket,
  });
  const connection = client.connectPresenceResilient(
    { token: "short-session-token", session: { expiresAt: Date.now() + 20 } },
    "tenant-1",
    "research",
    (event) => events.push(event),
  );
  socket.open();
  socket.message({ type: "session.authenticated" });
  assert.equal(connection.connected, true);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connection.connected, false);
  assert.equal(socket.readyState, 3);
  assert.ok(
    events.some(
      (event) =>
        event.type === "connection.closed" &&
        event.code === 4401 &&
        event.terminal,
    ),
  );
});
