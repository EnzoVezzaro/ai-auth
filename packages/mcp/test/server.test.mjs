import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createAIAuthMcpServer } from "../index.js";

const wallet = {
  id: "agent:local-test-wallet",
  publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  async sign(type, payload) {
    return {
      body: { type, issuer: this.id, payload },
      proof: { signature: "local-test" },
    };
  },
};

async function connect(server) {
  const client = new Client({ name: "ai-auth-test-client", version: "0.2.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, clientTransport, serverTransport };
}

const actions = [
  {
    name: "workspace.read",
    description: "Read the current workspace.",
    inputSchema: { workspaceId: z.string().min(1) },
    requiredCapability: "workspace.read",
    readOnly: true,
    execute: async ({ workspaceId }) => ({ workspaceId, summary: "ready" }),
  },
  {
    name: "workspace.write",
    description: "Update a workspace note.",
    inputSchema: { workspaceId: z.string().min(1), note: z.string().max(500) },
    requiredCapability: "workspace.write",
    execute: async () => {
      throw new Error("Bearer secret-token-value at /private/customer-record");
    },
  },
];

test("local MCP tools require wallet approval and expose only approved actions", async (t) => {
  const published = [];
  const result = await createAIAuthMcpServer({
    wallet,
    actions,
    approveCapabilities: async (requested, identity) => {
      assert.deepEqual(requested, ["workspace.read", "workspace.write"]);
      assert.equal(identity.id, wallet.id);
      return ["workspace.read"];
    },
    publishEvent: (event) => published.push(event),
  });
  t.after(() => result.server.close());
  assert.deepEqual(result.capabilities, ["workspace.read"]);

  const { client, clientTransport, serverTransport } = await connect(
    result.server,
  );
  t.after(async () => {
    await client.close();
    await clientTransport.close();
    await serverTransport.close();
  });
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["workspace.read"],
  );
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const output = await client.callTool({
    name: "workspace.read",
    arguments: { workspaceId: "local-workspace" },
  });
  assert.match(output.content[0].text, /"summary":"ready"/u);
  assert.deepEqual(
    published.map((event) => event.body.payload.state),
    ["started", "completed"],
  );
  assert.ok(published.every((event) => event.proof.signature === "local-test"));
});

test("MCP server refuses an empty or broadened approval", async () => {
  await assert.rejects(
    createAIAuthMcpServer({
      wallet,
      actions,
      approveCapabilities: async () => [],
    }),
    /non-empty requested capability subset/u,
  );
  await assert.rejects(
    createAIAuthMcpServer({
      wallet,
      actions,
      approveCapabilities: async () => ["workspace.admin"],
    }),
    /non-empty requested capability subset/u,
  );
});

test("local MCP action errors hide secrets and sign failed events", async (t) => {
  const published = [];
  const result = await createAIAuthMcpServer({
    wallet,
    actions,
    approveCapabilities: async (requested) => requested,
    publishEvent: (event) => published.push(event),
  });
  t.after(() => result.server.close());
  const { client, clientTransport, serverTransport } = await connect(
    result.server,
  );
  t.after(async () => {
    await client.close();
    await clientTransport.close();
    await serverTransport.close();
  });
  const failed = await client.callTool({
    name: "workspace.write",
    arguments: { workspaceId: "local-workspace", note: "test" },
  });
  assert.equal(failed.isError, true);
  assert.equal(
    failed.content[0].text,
    "The action failed. Check the local host for details.",
  );
  assert.doesNotMatch(
    failed.content[0].text,
    /secret-token-value|customer-record/u,
  );
  assert.deepEqual(
    published.map((event) => event.body.payload.state),
    ["started", "failed"],
  );
});

test("MCP host event transport errors never expose callback secrets", async (t) => {
  for (const failingState of ["started", "failed"]) {
    const states = [];
    const result = await createAIAuthMcpServer({
      wallet,
      actions,
      approveCapabilities: async (requested) => requested,
      publishEvent: async (event) => {
        const state = event.body.payload.state;
        states.push(state);
        if (state === failingState)
          throw new Error("Authorization Bearer private-transport-token");
      },
    });
    t.after(() => result.server.close());
    const { client, clientTransport, serverTransport } = await connect(
      result.server,
    );
    t.after(async () => {
      await client.close();
      await clientTransport.close();
      await serverTransport.close();
    });
    const failed = await client.callTool({
      name: "workspace.write",
      arguments: { workspaceId: "local-workspace", note: "test" },
    });
    assert.equal(failed.isError, true);
    assert.equal(
      failed.content[0].text,
      "The action failed. Check the local host for details.",
    );
    assert.doesNotMatch(failed.content[0].text, /private-transport-token/u);
    assert.deepEqual(states, ["started", "failed"]);
  }
});
