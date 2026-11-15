import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAIAuthMcpServer } from "../index.js";
import { fileURLToPath } from "node:url";

const identity = {
  id: "agent:local-test-wallet",
  publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  sign: async () => ({ proof: "local-only" }),
};

const session = {
  token: "opaque-test-session-token-012345678901234567890123456789",
  session: {
    id: "session-1",
    agentId: identity.id,
    capabilities: ["messages.read", "messages.write"],
    expiresAt: Date.now() + 60_000,
  },
};

async function connect(server) {
  const client = new Client({ name: "ai-auth-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, clientTransport, serverTransport };
}

test("MCP tools authenticate through explicit wallet approval and enforce scopes", async (t) => {
  const calls = [];
  const serviceClient = {
    async authenticate(wallet, requested, approved) {
      calls.push({ operation: "authenticate", wallet, requested, approved });
      return session;
    },
    async listMessages(auth, tenantId, room) {
      calls.push({ operation: "list", auth, tenantId, room });
      return { messages: [{ body: "hello from the authorized room" }] };
    },
    async sendMessage(auth, tenantId, room, body) {
      calls.push({ operation: "send", auth, tenantId, room, body });
      return { message: { body } };
    },
  };
  const authz = await createAIAuthMcpServer({
    serviceClient,
    wallet: identity,
    requestedCapabilities: ["messages.read", "messages.write", "tenant.create"],
    approveCapabilities: async (requested, agent) => {
      assert.equal(agent.id, identity.id);
      return requested.filter((scope) => scope !== "tenant.create");
    },
  });
  t.after(() => authz.server.close());
  const { client, clientTransport, serverTransport } = await connect(
    authz.server,
  );
  t.after(async () => {
    await client.close();
    await clientTransport.close();
    await serverTransport.close();
  });

  assert.equal(calls[0].operation, "authenticate");
  assert.deepEqual(calls[0].approved, ["messages.read", "messages.write"]);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "ai_auth_identity",
    "ai_auth_list_messages",
    "ai_auth_send_message",
  ]);

  const read = await client.callTool({
    name: "ai_auth_list_messages",
    arguments: { tenantId: "tenant-a", room: "research" },
  });
  assert.match(read.content[0].text, /hello from the authorized room/u);
  assert.equal(calls[1].operation, "list");
  assert.equal(calls[1].tenantId, "tenant-a");
  assert.equal(calls[1].auth.token, session.token);

  const sent = await client.callTool({
    name: "ai_auth_send_message",
    arguments: {
      tenantId: "tenant-a",
      room: "research",
      body: "signed session message",
    },
  });
  assert.match(sent.content[0].text, /signed session message/u);
  assert.equal(calls[2].operation, "send");
  assert.equal(calls[2].auth.token, session.token);

  const unavailable = await client.callTool({
    name: "ai_auth_create_tenant",
    arguments: { name: "Not approved" },
  });
  assert.equal(unavailable.isError, true);
  assert.equal(
    JSON.stringify([read, sent]).includes(session.token),
    false,
    "session credentials must not be returned to MCP clients",
  );
});

test("MCP startup fails closed if the wallet declines all requested access", async () => {
  await assert.rejects(
    createAIAuthMcpServer({
      serviceClient: {
        async authenticate() {
          throw new Error("must not authenticate without approval");
        },
      },
      wallet: identity,
      requestedCapabilities: ["messages.write"],
      approveCapabilities: async () => [],
    }),
    /No requested capabilities were approved/u,
  );
});

test("MCP operations pass through backend errors without exposing session tokens", async (t) => {
  const authSession = {
    token: "token-secret-marker-012345678901234567890123456789",
    session: {
      id: "session-2",
      agentId: identity.id,
      capabilities: ["messages.read"],
      expiresAt: Date.now() + 60_000,
    },
  };
  const authz = await createAIAuthMcpServer({
    serviceClient: {
      async authenticate() {
        return authSession;
      },
      async listMessages() {
        throw new Error(`request failed for Bearer ${authSession.token}`);
      },
    },
    wallet: identity,
    requestedCapabilities: ["messages.read"],
    approveCapabilities: async (requested) => requested,
  });
  t.after(() => authz.server.close());
  const { client, clientTransport, serverTransport } = await connect(
    authz.server,
  );
  t.after(async () => {
    await client.close();
    await clientTransport.close();
    await serverTransport.close();
  });

  const failed = await client.callTool({
    name: "ai_auth_list_messages",
    arguments: { tenantId: "tenant-a", room: "research" },
  });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /\[redacted\]/u);
  assert.equal(failed.content[0].text.includes(authSession.token), false);
});

test("stdio transport launches a local server and returns authorized tool output", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./stdio-fixture.mjs", import.meta.url))],
    stderr: "pipe",
    env: process.env,
  });
  const client = new Client({ name: "stdio-test-client", version: "0.1.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "ai_auth_list_messages",
      arguments: { tenantId: "tenant-test", room: "stdio" },
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /stdio transport works/u);
  } finally {
    await client.close();
  }
});
