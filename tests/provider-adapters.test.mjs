import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentToolAdapter,
  createMcpAdapter,
  createProviderAdapter,
  createWebMCPAdapter,
  descriptorSource,
  fromAgentToolCatalog,
  fromMcpCatalog,
  fromWebMCPCatalog,
} from "../packages/p2p/provider-adapters.js";

const FUTURE = Date.now() + 60_000;
const PAST = Date.now() - 60_000;

// ---------------------------------------------------------------------------
// Realistic fixtures (shapes copied from the three live catalog producers)
// ---------------------------------------------------------------------------

function webmcpCatalog() {
  // Shape of `safeToolDescriptor()` output in packages/p2p/webmcp.js, wrapped in
  // the signed `tool-catalog` envelope received from a peer.
  return {
    wallet: "agent:site-wallet",
    session: "site-session-1",
    expiresAt: FUTURE,
    fromOrigins: ["https://app.example"],
    page: "https://app.example/dashboard",
    tools: [
      {
        name: "notes.search",
        description: "Search the user's notes",
        title: "Search notes",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
        annotations: {
          readOnlyHint: true,
          consequentialHint: false,
          untrustedContentHint: false,
        },
      },
      {
        name: "docs.publish",
        description: "Publish a document to the team",
        inputSchema: { type: "object", properties: {} },
        annotations: {
          readOnlyHint: false,
          consequentialHint: true,
          untrustedContentHint: true,
        },
      },
    ],
  };
}

function mcpListToolsResult() {
  // Shape of `listTools()` in packages/mcp/bridge.js.
  return {
    untrusted: true,
    note: "Catalogs come from connected participants.",
    sites: [
      {
        wallet: "agent:page-wallet",
        session: "page-session-1",
        expiresAt: FUTURE,
        tools: [
          {
            name: "ai_auth_status",
            description: "Show identity and connection state.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
      {
        wallet: "agent:peer-wallet",
        session: "peer-session-1",
        expiresAt: PAST,
        tools: [
          {
            name: "ai_auth_send",
            description: "Send a signed text message.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        ],
      },
    ],
  };
}

function mcpActions() {
  // Shape of `buildAgentActions()` descriptors in packages/mcp/bridge.js.
  return [
    {
      name: "ai_auth_join",
      description: "Join the approved site room.",
      inputSchema: { type: "object", properties: {} },
      requiredCapability: "presence.read",
      readOnly: false,
      // Hints from the MCP SDK: advisory only, must not grant authority.
      annotations: { readOnlyHint: true, title: "Join room" },
      title: "Join room",
    },
  ];
}

function agentToolCatalog() {
  // Shape of the descriptors published by packages/agent/tool-provider.js.
  return {
    kind: "tool-catalog",
    tools: [
      {
        name: "agent.self",
        description: "This agent's public identity and capabilities.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "notes.delete",
        description: "Delete a note (provider-gated).",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// WebMCP conversion
// ---------------------------------------------------------------------------

test("fromWebMCPCatalog: namespacing, source origin/page, expiry and title", () => {
  const descriptors = fromWebMCPCatalog(webmcpCatalog(), {
    origin: "https://app.example",
    providerId: "site-wallet",
    capabilities: ["tools.invoke"],
  });

  assert.equal(descriptors.length, 2);
  // The ID uses the providerId token; the origin stays in source.origin.
  assert.equal(descriptors[0].id, "webmcp:site-wallet:notes.search");
  assert.equal(descriptors[1].id, "webmcp:site-wallet:docs.publish");
  assert.equal(descriptors[0].protocol, "webmcp");
  assert.equal(descriptors[0].providerId, "site-wallet");
  assert.deepEqual(descriptors[0].source, {
    origin: "https://app.example",
    page: "https://app.example/dashboard",
  });
  assert.equal(descriptors[0].title, "Search notes");
  assert.equal(descriptors[0].expiresAt, FUTURE);
  assert.equal(descriptors[0].availability, "online");
  assert.deepEqual(descriptors[0].audience.origins, ["https://app.example"]);
  assert.equal(descriptors[0].requiredAuthorization.kind, "site");
});

test("fromWebMCPCatalog: maps consequentialHint and untrustedContentHint to risk", () => {
  const [readonly, consequential] = fromWebMCPCatalog(webmcpCatalog(), {
    origin: "https://app.example",
    capabilities: ["tools.invoke"],
  });

  // A page's readOnlyHint is advisory and cannot lower risk below "write".
  assert.deepEqual(readonly.risk, {
    sideEffect: "write",
    untrustedContent: false,
  });
  assert.deepEqual(consequential.risk, {
    sideEffect: "consequential",
    untrustedContent: true,
  });
});

test("fromWebMCPCatalog: missing origin uses an explicit sentinel and is flagged", () => {
  const [descriptor] = fromWebMCPCatalog({ tools: [webmcpCatalog().tools[0]] });
  assert.equal(descriptor.id, "webmcp:unknown:notes.search");
  assert.equal("origin" in descriptor.source, false);
  assert.equal(descriptor.provenance, "missing-origin");
  assert.equal(descriptor.providerId, "unknown");
});

test("fromWebMCPCatalog: uses origin carried by the catalog when option omitted", () => {
  const [descriptor] = fromWebMCPCatalog({
    origin: "https://embedded.example",
    tools: webmcpCatalog().tools,
  });
  assert.equal(descriptor.id, "webmcp:https://embedded.example:notes.search");
  assert.equal(descriptor.source.origin, "https://embedded.example");
});

test("fromWebMCPCatalog: expired catalog is marked expired", () => {
  const catalog = webmcpCatalog();
  catalog.expiresAt = PAST;
  const [descriptor] = fromWebMCPCatalog(catalog, {
    origin: "https://app.example",
  });
  assert.equal(descriptor.availability, "expired");
  assert.equal(descriptor.expiresAt, PAST);
});

// ---------------------------------------------------------------------------
// MCP conversion
// ---------------------------------------------------------------------------

test("fromMcpCatalog: flattens listTools sites, carries endpoint and expiry", () => {
  const descriptors = fromMcpCatalog(mcpListToolsResult(), {
    providerId: "mcp-server-a",
    endpoint: "http://127.0.0.1:4317/mcp/secret",
    capabilities: ["tools.invoke"],
  });

  assert.equal(descriptors.length, 2);
  assert.equal(descriptors[0].id, "mcp:mcp-server-a:ai_auth_status");
  assert.equal(descriptors[1].id, "mcp:mcp-server-a:ai_auth_send");
  assert.equal(descriptors[0].protocol, "mcp");
  assert.deepEqual(descriptors[0].source, {
    endpoint: "http://127.0.0.1:4317/mcp/secret",
  });
  assert.deepEqual(descriptors[0].audience.walletIds, ["agent:page-wallet"]);
  assert.equal(descriptors[0].availability, "online");
  assert.equal(descriptors[1].availability, "expired");
  assert.equal(descriptors[1].requiredAuthorization.kind, "native");
});

test("fromMcpCatalog: advisory hints do not grant authority or read classification", () => {
  const [descriptor] = fromMcpCatalog(mcpActions(), {
    providerId: "mcp-server-b",
    capabilities: ["tools.invoke"],
  });

  assert.equal(descriptor.id, "mcp:mcp-server-b:ai_auth_join");
  // readOnlyHint: true must NOT lower risk to "read".
  assert.equal(descriptor.risk.sideEffect, "write");
  assert.equal(descriptor.risk.untrustedContent, true);
  // The explicit requiredCapability is preserved as a capability, not a hint.
  assert.deepEqual(descriptor.capabilities, ["tools.invoke", "presence.read"]);
  assert.equal(descriptor.title, "Join room");
});

test("fromMcpCatalog: consequential hint may only increase risk", () => {
  const [descriptor] = fromMcpCatalog(
    [
      {
        name: "danger.do",
        description: "Dangerous call",
        inputSchema: {},
        annotations: { readOnlyHint: true, consequentialHint: true },
      },
    ],
    { providerId: "mcp-server-c" },
  );
  assert.equal(descriptor.risk.sideEffect, "consequential");
});

// ---------------------------------------------------------------------------
// Agent tool catalog conversion
// ---------------------------------------------------------------------------

test("fromAgentToolCatalog: utcp namespacing, provider gating and peer trust", () => {
  const descriptors = fromAgentToolCatalog(agentToolCatalog(), {
    providerId: "room-agent",
    manual: "room-agent",
    capabilities: ["tools.invoke"],
  });

  assert.equal(descriptors.length, 2);
  assert.equal(descriptors[0].id, "utcp:room-agent:agent.self");
  assert.equal(descriptors[1].id, "utcp:room-agent:notes.delete");
  assert.equal(descriptors[0].protocol, "utcp");
  assert.equal(descriptors[0].providerId, "room-agent");
  assert.equal(descriptors[0].requiredAuthorization.kind, "owner");
  assert.equal(descriptors[0].risk.sideEffect, "write");
  assert.equal(descriptors[0].risk.untrustedContent, true);
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants
// ---------------------------------------------------------------------------

test("native descriptor is preserved verbatim (all fields, no weakening)", () => {
  const native = webmcpCatalog().tools[1];
  const [descriptor] = fromWebMCPCatalog([native], {
    origin: "https://app.example",
  });
  assert.deepEqual(descriptor.native, native);
  assert.equal(descriptor.native.annotations.consequentialHint, true);
  assert.equal(descriptor.native.annotations.untrustedContentHint, true);
  assert.notEqual(descriptor.native, native); // copied, not aliased
});

test("duplicate names across providers produce distinct namespaced ids", () => {
  const tool = { name: "notes.search", description: "x", inputSchema: {} };
  const web = fromWebMCPCatalog([tool], {
    origin: "https://a.example",
    providerId: "a",
  })[0];
  const mcp = fromMcpCatalog([tool], { providerId: "b" })[0];
  const agent = fromAgentToolCatalog([tool], {
    providerId: "c",
    manual: "c",
  })[0];

  assert.equal(web.id, "webmcp:a:notes.search");
  assert.equal(mcp.id, "mcp:b:notes.search");
  assert.equal(agent.id, "utcp:c:notes.search");
  assert.equal(new Set([web.id, mcp.id, agent.id]).size, 3);
});

test("exact duplicate ids within one catalog are collapsed", () => {
  const tool = { name: "same.tool", description: "x", inputSchema: {} };
  const descriptors = fromMcpCatalog([tool, { ...tool }], { providerId: "p" });
  assert.equal(descriptors.length, 1);
});

test("no mutation of input catalogs (deep-frozen fixtures)", () => {
  const catalogs = [
    webmcpCatalog(),
    mcpListToolsResult(),
    mcpActions(),
    agentToolCatalog(),
  ];
  const deepFreeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };
  catalogs.forEach(deepFreeze);

  assert.doesNotThrow(() => {
    fromWebMCPCatalog(catalogs[0], { origin: "https://app.example" });
    fromMcpCatalog(catalogs[1], { providerId: "mcp" });
    fromMcpCatalog(catalogs[2], { providerId: "mcp" });
    fromAgentToolCatalog(catalogs[3], { providerId: "agent" });
  });
  assert.equal(catalogs[0].tools.length, 2);
  assert.equal(catalogs[1].sites.length, 2);
  assert.equal(catalogs[2].length, 1);
  assert.equal(catalogs[3].tools.length, 2);
});

test("absence of fabricated permissions: no wildcard or hint-derived scopes", () => {
  const hintsOnly = [
    {
      name: "x.y",
      description: "x",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        consequentialHint: true,
        untrustedContentHint: true,
        destructiveHint: true,
      },
      protected: true,
    },
  ];
  const web = fromWebMCPCatalog(hintsOnly, { origin: "https://x.example" })[0];
  const mcp = fromMcpCatalog(hintsOnly, { providerId: "p" })[0];
  const agent = fromAgentToolCatalog(hintsOnly, { providerId: "p" })[0];

  for (const descriptor of [web, mcp, agent]) {
    assert.deepEqual(descriptor.capabilities, []);
    assert.equal(descriptor.capabilities.includes("*"), false);
    assert.equal("permissions" in descriptor, false);
    assert.equal("allowedOrigins" in descriptor, false);
  }
});

// ---------------------------------------------------------------------------
// Adapter facade
// ---------------------------------------------------------------------------

test("createProviderAdapter exposes only discover/listTools/getTool/close", async () => {
  const adapter = createProviderAdapter({
    protocol: "mcp",
    catalog: mcpActions(),
    providerId: "mcp-server-b",
  });

  assert.equal(adapter.protocol, "mcp");
  assert.deepEqual(Object.keys(adapter).sort(), [
    "close",
    "discover",
    "getTool",
    "listTools",
    "protocol",
  ]);
  assert.equal("invoke" in adapter, false);
  assert.equal("cancel" in adapter, false);
  assert.equal("subscribe" in adapter, false);

  const tools = await adapter.discover();
  assert.equal(tools.length, 1);
  assert.deepEqual(await adapter.listTools(), tools);
  assert.equal(
    (await adapter.getTool("mcp:mcp-server-b:ai_auth_join"))?.id,
    "mcp:mcp-server-b:ai_auth_join",
  );
  assert.equal(await adapter.getTool("mcp:mcp-server-b:missing"), undefined);

  await adapter.close();
  assert.deepEqual(await adapter.listTools(), []);
  assert.equal(
    await adapter.getTool("mcp:mcp-server-b:ai_auth_join"),
    undefined,
  );
  await adapter.close(); // idempotent
});

test("adapter factories for webmcp and agent sources and refresh function", async () => {
  let catalog = { tools: [webmcpCatalog().tools[0]] };
  const web = createWebMCPAdapter(() => catalog, {
    origin: "https://app.example",
  });
  assert.equal(
    (await web.discover())[0].id,
    "webmcp:https://app.example:notes.search",
  );
  catalog = { tools: [webmcpCatalog().tools[1]] };
  assert.equal(
    (await web.listTools())[0].id,
    "webmcp:https://app.example:docs.publish",
  );

  const agent = createAgentToolAdapter(agentToolCatalog(), {
    providerId: "room-agent",
    manual: "room-agent",
  });
  assert.equal(agent.protocol, "utcp");
  assert.equal((await agent.discover()).length, 2);
  assert.equal("cancel" in agent, false);
  await agent.close();
});

test("createProviderAdapter rejects unknown protocols", () => {
  assert.throws(
    () => createProviderAdapter({ protocol: "nope", catalog: [] }),
    /Unsupported tool catalog protocol/,
  );
});

test("descriptorSource reports the active builder", () => {
  assert.equal(typeof descriptorSource(), "string");
  assert.match(descriptorSource(), /^[a-zA-Z-]+$/);
});
