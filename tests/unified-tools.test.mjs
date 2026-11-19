// Integration test for the first milestone: one API listing and invoking tools
// from MCP, WebMCP and UTCP while preserving native approval and error semantics.
import assert from "node:assert/strict";
import test from "node:test";
import { createToolAudit } from "../packages/p2p/tool-audit.js";
import { createToolRegistry } from "../packages/p2p/tool-registry.js";
import {
  createMcpAdapter,
  createWebMCPAdapter,
} from "../packages/p2p/provider-adapters.js";
import { createUtcpAdapter } from "../packages/p2p/utcp-adapter.js";
import { createUnifiedToolApi } from "../packages/p2p/unified-tools.js";

const ctx = Object.freeze({
  caller: "agent:test",
  origin: "https://app.example",
  approvedCapabilities: ["tools.invoke"],
  siteApproved: true,
  ownerApproved: true,
  nativeAuthorized: true,
});

function fixtureApi({ withInvokers = true, policy } = {}) {
  const audit = createToolAudit();
  const registry = createToolRegistry({
    audit,
    policy: policy ?? (() => true),
  });
  const calls = [];
  const invokers = withInvokers
    ? {
        webmcp: async (descriptor, args) => {
          calls.push(["webmcp", descriptor.id, args]);
          return { ok: true, value: "page" };
        },
        mcp: async (descriptor, args) => {
          calls.push(["mcp", descriptor.id, args]);
          return { ok: true, value: "server" };
        },
        utcp: async (descriptor, args) => {
          calls.push(["utcp", descriptor.id, args]);
          return { ok: true, value: "native" };
        },
      }
    : {};
  const api = createUnifiedToolApi({ registry, invokers });
  return { api, audit, calls };
}

const expiresAt = () => Date.now() + 60_000;
const webCatalog = () => ({
  tools: [
    {
      name: "notes.search",
      description: "Search notes",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  ],
  expiresAt: expiresAt(),
});
const mcpCatalog = () => ({
  sites: [
    {
      tools: [
        {
          name: "ai_auth_status",
          description: "Connection status",
          inputSchema: { type: "object" },
        },
      ],
      expiresAt: expiresAt(),
    },
  ],
});

function fakeUtcpClient() {
  return {
    async registerManual() {},
    async getTools() {
      return [
        {
          name: "issues.search",
          description: "Search issues",
          tool_call_template: {
            url: "https://api.example.com/tools/search",
            inputs: { parameters: { type: "object" } },
          },
        },
      ];
    },
    async callTool(name, args) {
      return { ok: true, name, args };
    },
    async deregisterManual() {},
  };
}

async function registerAll(api) {
  await api.registerAdapter(
    "webmcp",
    createWebMCPAdapter(webCatalog(), {
      origin: "https://app.example",
      capabilities: ["tools.invoke"],
    }),
  );
  await api.registerAdapter(
    "mcp",
    createMcpAdapter(mcpCatalog(), {
      providerId: "serverA",
      capabilities: ["tools.invoke"],
    }),
  );
  await api.registerAdapter(
    "utcp",
    createUtcpAdapter({
      manuals: [{ name: "github", url: "https://manual.example.com/utcp" }],
      client: fakeUtcpClient(),
      resolver: async () => ["93.184.216.34"],
      redirectFetch: async () => ({ headers: { get: () => null } }),
      capabilities: ["tools.invoke"],
    }),
  );
}

test("one API lists and invokes tools from all three providers", async () => {
  const { api, calls, audit } = fixtureApi();
  await registerAll(api);

  const tools = api.listTools(ctx);
  assert.deepEqual(
    tools.map((tool) => tool.id).sort(),
    [
      "mcp:serverA:ai_auth_status",
      "utcp:github:issues.search",
      "webmcp:https://app.example:notes.search",
    ].sort(),
  );

  for (const id of [
    "webmcp:https://app.example:notes.search",
    "mcp:serverA:ai_auth_status",
    "utcp:github:issues.search",
  ]) {
    const result = await api.invoke(id, { q: "x" }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.toolId, id);
  }
  assert.equal(calls.length, 3);
  assert.equal(audit.list().filter((row) => row.outcome === "ok").length, 3);
});

test("duplicate tool names across providers do not collide", async () => {
  const { api } = fixtureApi();
  await registerAll(api);
  await api.registerAdapter(
    "mcp",
    createMcpAdapter(
      {
        sites: [
          {
            tools: [{ name: "notes.search", inputSchema: { type: "object" } }],
            expiresAt: expiresAt(),
          },
        ],
      },
      { providerId: "serverB", capabilities: ["tools.invoke"] },
    ),
  );
  assert.equal(api.listTools(ctx).length, 4);
  assert.ok(api.getTool("mcp:serverB:notes.search"));
  assert.ok(api.getTool("webmcp:https://app.example:notes.search"));
});

test("missing approval or capability fails closed and is audited", async () => {
  const { api, calls, audit } = fixtureApi();
  await registerAll(api);
  const deny = await api.invoke(
    "mcp:serverA:ai_auth_status",
    {},
    {
      ...ctx,
      nativeAuthorized: false,
    },
  );
  assert.equal(deny.ok, false);
  assert.equal(deny.code, "DENIED");
  const noCap = await api.invoke(
    "mcp:serverA:ai_auth_status",
    {},
    {
      ...ctx,
      approvedCapabilities: [],
    },
  );
  assert.equal(noCap.ok, false);
  assert.equal(calls.length, 0);
  const denied = audit.list().filter((row) => row.decision === "deny");
  assert.equal(denied.length, 2);
  assert.ok(denied.every((row) => !("description" in row)));
});

test("a policy denial keeps native risk data out of the decision", async () => {
  const { api, calls } = fixtureApi({
    policy: (p) => (p.risk.sideEffect === "consequential" ? false : true),
  });
  await registerAll(api);
  assert.equal(
    (await api.invoke("mcp:serverA:ai_auth_status", {}, ctx)).ok,
    true,
  );
  assert.equal(calls.length, 1);
});

test("missing native invoker fails closed", async () => {
  const { api } = fixtureApi({ withInvokers: false });
  await registerAll(api);
  const result = await api.invoke("mcp:serverA:ai_auth_status", {}, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_INVOKER");
});

test("native provider errors are preserved, not widened", async () => {
  const audit = createToolAudit();
  const registry = createToolRegistry({ audit, policy: () => true });
  const api = createUnifiedToolApi({
    registry,
    invokers: {
      mcp: async () => ({ ok: false, code: "SITE_DISCONNECTED" }),
    },
  });
  await api.registerAdapter(
    "mcp",
    createMcpAdapter(mcpCatalog(), {
      providerId: "serverA",
      capabilities: ["tools.invoke"],
    }),
  );
  const result = await api.invoke("mcp:serverA:ai_auth_status", {}, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.native.code, "SITE_DISCONNECTED");
});

test("adapters with explicit provider ids register without id mismatch", async () => {
  const api = createUnifiedToolApi({ invokers: {} });
  const added = await api.registerAdapter(
    "webmcp",
    createWebMCPAdapter(
      {
        tools: [{ name: "notes.search", inputSchema: { type: "object" } }],
        expiresAt: Date.now() + 60_000,
      },
      {
        origin: "https://app.example",
        providerId: "site-wallet",
        capabilities: ["tools.invoke"],
      },
    ),
  );
  assert.equal(added[0].id, "webmcp:site-wallet:notes.search");
  assert.equal(added[0].source.origin, "https://app.example");
});
