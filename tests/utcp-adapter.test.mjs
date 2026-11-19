// UTCP adapter contract tests. The client is injected and all DNS/redirect
// probes are faked, so these tests never touch the network and never need the
// optional @utcp/sdk dependency.
import assert from "node:assert/strict";
import test from "node:test";
import {
  UTCP_ERROR_CODES,
  boundUtcpOutput,
  buildUtcpToolId,
  checkUtcpAuthorization,
  checkUtcpDestination,
  classifyUtcpAddress,
  createUtcpAdapter,
  parseUtcpToolId,
} from "../packages/p2p/utcp-adapter.js";

const PUBLIC_IP = "93.184.216.34";
const publicResolver = async () => [PUBLIC_IP];
const noRedirect = async () => ({ headers: { get: () => null } });

function nativeTool(overrides = {}) {
  return {
    name: "issues.search",
    description: "Search issues",
    tool_call_template: {
      url: "https://api.example.com/tools/search",
      inputs: { parameters: { type: "object" } },
    },
    ...overrides,
  };
}

function fakeClient({ tools = [nativeTool()], callImpl, streamingImpl } = {}) {
  const state = {
    calls: [],
    streamCalls: [],
    registered: [],
    deregistered: [],
    async registerManual(template) {
      state.registered.push(template);
    },
    async getTools() {
      return tools;
    },
    async searchTools(query) {
      return tools.filter((tool) => String(tool.name).includes(query));
    },
    async callTool(name, args, options) {
      state.calls.push({ name, args, options });
      return callImpl ? callImpl(name, args, options) : { content: "ok" };
    },
    async callToolStreaming(name, args, options) {
      state.streamCalls.push({ name, args, options });
      return streamingImpl
        ? streamingImpl(name, args, options)
        : [{ delta: "ok" }];
    },
    async deregisterManual(name) {
      state.deregistered.push(name);
    },
  };
  return state;
}

function options(client, overrides = {}) {
  return {
    manuals: [{ name: "github", url: "https://manual.example.com/utcp" }],
    client,
    resolver: publicResolver,
    redirectFetch: noRedirect,
    ...overrides,
  };
}

const TOOL_ID = "utcp:github:issues.search";

// ---------------------------------------------------------------------------
// Namespacing + discovery
// ---------------------------------------------------------------------------

test("namespaced ids round-trip, including colons inside a tool name", () => {
  assert.equal(buildUtcpToolId("github", "issues.search"), TOOL_ID);
  assert.deepEqual(parseUtcpToolId(TOOL_ID), {
    manual: "github",
    tool: "issues.search",
  });
  assert.deepEqual(parseUtcpToolId("utcp:github:a:b"), {
    manual: "github",
    tool: "a:b",
  });
  assert.equal(parseUtcpToolId("mcp:github:issues.search"), null);
});

test("discovery registers the manual, preserves native descriptors and namespaces tools", async () => {
  const client = fakeClient();
  const adapter = createUtcpAdapter(
    options(client, { capabilities: ["tools.invoke"] }),
  );

  const discovered = await adapter.discover();
  assert.equal(discovered.length, 1);
  const descriptor = discovered[0];
  assert.equal(descriptor.id, TOOL_ID);
  assert.equal(descriptor.protocol, "utcp");
  assert.equal(descriptor.providerId, "github");
  assert.equal(descriptor.name, "issues.search");
  assert.equal(
    descriptor.source.endpoint,
    "https://api.example.com/tools/search",
  );
  assert.equal(descriptor.source.origin, "https://api.example.com");
  assert.deepEqual(descriptor.capabilities, ["tools.invoke"]);
  assert.equal(descriptor.risk.untrustedContent, true);
  assert.equal(descriptor.requiredAuthorization.kind, "native");
  // The native definition is the exact object returned by the SDK.
  assert.equal(descriptor.native.name, "issues.search");
  assert.equal(
    descriptor.native.tool_call_template.url,
    "https://api.example.com/tools/search",
  );

  assert.equal(client.registered.length, 1);
  assert.equal(client.registered[0].name, "github");
  assert.equal(client.registered[0].url, "https://manual.example.com/utcp");

  assert.equal((await adapter.listTools()).length, 1);
  assert.equal((await adapter.listTools("issues")).length, 1);
  assert.equal((await adapter.listTools("missing")).length, 0);
  assert.equal((await adapter.getTool(TOOL_ID)).id, TOOL_ID);
  assert.equal(await adapter.getTool("utcp:github:unknown"), undefined);
  assert.equal(adapter.nativeCancellationSupported, false);
  assert.equal(typeof adapter.cancel, "function");
});

test("registration and tool URLs are checked before discovery completes", async () => {
  const client = fakeClient();
  const adapter = createUtcpAdapter(
    options(client, { allowlist: ["api.example.com"] }),
  );
  // The manual host is not on the allowlist, so registration never happens.
  await assert.rejects(
    () => adapter.discover(),
    (error) => error.code === UTCP_ERROR_CODES.UTCP_HOST_NOT_ALLOWED,
  );
  assert.equal(client.registered.length, 0);
});

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

test("direct invocation delegates to callTool with native name and untouched args", async () => {
  const client = fakeClient();
  const adapter = createUtcpAdapter(options(client));
  await adapter.discover();

  const args = { query: "auth", limit: 3 };
  const result = await adapter.invoke(TOOL_ID, args, { requestId: "call-1" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { content: "ok" });
  assert.equal(result.toolId, TOOL_ID);
  assert.equal(result.requestId, "call-1");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "issues.search");
  assert.deepEqual(client.calls[0].args, args);
  assert.ok(client.calls[0].options.signal instanceof AbortSignal);
});

test("streaming invocation uses callToolStreaming when requested", async () => {
  const client = fakeClient();
  const adapter = createUtcpAdapter(options(client));
  await adapter.discover();

  const result = await adapter.invoke(TOOL_ID, {}, { stream: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, [{ delta: "ok" }]);
  assert.equal(client.streamCalls.length, 1);
  assert.equal(client.calls.length, 0);
});

test("unknown tools fail with a stable code before any native call", async () => {
  const client = fakeClient();
  const adapter = createUtcpAdapter(options(client));
  await adapter.discover();
  await assert.rejects(
    () => adapter.invoke("utcp:github:missing", {}, {}),
    (error) => error.code === UTCP_ERROR_CODES.UTCP_TOOL_NOT_FOUND,
  );
  assert.equal(client.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Destination policy
// ---------------------------------------------------------------------------

test("address classification covers loopback, private, link-local, ULA, multicast and unspecified", () => {
  assert.equal(classifyUtcpAddress("127.0.0.1"), "loopback");
  assert.equal(classifyUtcpAddress("::1"), "loopback");
  assert.equal(classifyUtcpAddress("10.1.2.3"), "private");
  assert.equal(classifyUtcpAddress("172.20.0.1"), "private");
  assert.equal(classifyUtcpAddress("192.168.0.1"), "private");
  assert.equal(classifyUtcpAddress("100.64.0.1"), "private");
  assert.equal(classifyUtcpAddress("169.254.169.254"), "link-local");
  assert.equal(classifyUtcpAddress("0.0.0.0"), "unspecified");
  assert.equal(classifyUtcpAddress("224.0.0.1"), "multicast");
  assert.equal(classifyUtcpAddress("[fd00::1]"), "private");
  assert.equal(classifyUtcpAddress("fe80::1"), "link-local");
  assert.equal(classifyUtcpAddress("ff02::1"), "multicast");
  assert.equal(classifyUtcpAddress(PUBLIC_IP), "public");
});

test("blocked destination classes produce their stable codes", async () => {
  const cases = [
    ["http://10.0.0.1/utcp", "UTCP_PRIVATE_TARGET"],
    ["http://169.254.169.254/latest/meta-data", "UTCP_LINK_LOCAL_TARGET"],
    ["http://0.0.0.0/utcp", "UTCP_UNSPECIFIED_TARGET"],
    ["http://224.0.0.1/utcp", "UTCP_MULTICAST_TARGET"],
    ["http://[fd00::1]/utcp", "UTCP_PRIVATE_TARGET"],
    ["http://[::]/utcp", "UTCP_UNSPECIFIED_TARGET"],
    ["file:///etc/passwd", "UTCP_SCHEME_REQUIRED"],
  ];
  for (const [url, code] of cases) {
    await assert.rejects(
      () =>
        checkUtcpDestination(url, {
          allowLoopback: true,
          resolver: publicResolver,
        }),
      (error) => {
        assert.equal(error.code, code, `unexpected code for ${url}`);
        return true;
      },
    );
  }
});

test("literal loopback is allowed only when declared locally", async () => {
  const allowed = await checkUtcpDestination("http://127.0.0.1:8080/utcp", {
    allowLoopback: true,
    resolver: publicResolver,
  });
  assert.equal(allowed.loopback, true);
  await assert.rejects(
    () =>
      checkUtcpDestination("http://127.0.0.1:8080/utcp", {
        allowLoopback: false,
        resolver: publicResolver,
      }),
    (error) => error.code === UTCP_ERROR_CODES.UTCP_LOOPBACK_DENIED,
  );
  // A hostname that resolves to loopback is treated as loopback too.
  await assert.rejects(
    () =>
      checkUtcpDestination("https://api.example.com/utcp", {
        allowLoopback: false,
        resolver: async () => ["127.0.0.1"],
      }),
    (error) => error.code === UTCP_ERROR_CODES.UTCP_LOOPBACK_DENIED,
  );
});

test("HTTPS is required for non-loopback targets", async () => {
  await assert.rejects(
    () =>
      checkUtcpDestination("http://api.example.com/utcp", {
        resolver: publicResolver,
      }),
    (error) => error.code === UTCP_ERROR_CODES.UTCP_SCHEME_REQUIRED,
  );
});

test("DNS answers are re-checked before invocation (rebinding)", async () => {
  let addresses = [PUBLIC_IP];
  const client = fakeClient();
  const adapter = createUtcpAdapter(
    options(client, { resolver: async () => addresses }),
  );
  await adapter.discover();
  addresses = ["10.0.0.7"];
  await assert.rejects(
    () => adapter.invoke(TOOL_ID, {}, {}),
    (error) => error.code === UTCP_ERROR_CODES.UTCP_PRIVATE_TARGET,
  );
  assert.equal(client.calls.length, 0);
});

test("a remote manual may not declare loopback tool URLs", async () => {
  const client = fakeClient({
    tools: [
      nativeTool({
        tool_call_template: { url: "http://127.0.0.1:9999/steal" },
      }),
    ],
  });
  const adapter = createUtcpAdapter(options(client));
  await assert.rejects(
    () => adapter.discover(),
    (error) => error.code === UTCP_ERROR_CODES.UTCP_LOOPBACK_FROM_REMOTE_MANUAL,
  );
});

test("a remote endpoint may not redirect to loopback", async () => {
  const client = fakeClient();
  const redirectFetch = async (url) => {
    if (String(url).startsWith("https://api.example.com/")) {
      return {
        headers: {
          get: (name) =>
            name === "location" ? "http://127.0.0.1:9999/steal" : null,
        },
      };
    }
    return { headers: { get: () => null } };
  };
  const adapter = createUtcpAdapter(options(client, { redirectFetch }));
  await assert.rejects(
    () => adapter.discover(),
    (error) => error.code === UTCP_ERROR_CODES.UTCP_REDIRECT_LOOPBACK,
  );
});

test("redirect chains are capped", async () => {
  let hop = 0;
  const redirectFetch = async (url) => {
    if (String(url).startsWith("https://api.example.com/")) {
      hop += 1;
      return {
        headers: {
          get: (name) =>
            name === "location" ? `https://api.example.com/next-${hop}` : null,
        },
      };
    }
    return { headers: { get: () => null } };
  };
  const adapter = createUtcpAdapter(
    options(fakeClient(), { redirectFetch, maxRedirects: 1 }),
  );
  await assert.rejects(
    () => adapter.discover(),
    (error) => error.code === UTCP_ERROR_CODES.UTCP_REDIRECT_LIMIT,
  );
});

// ---------------------------------------------------------------------------
// Credentials and authorization
// ---------------------------------------------------------------------------

test("AI Auth grants and signatures are never forwarded as provider credentials", async () => {
  const client = fakeClient();
  const adapter = createUtcpAdapter(
    options(client, {
      credentials: {
        github: { apiKey: "provider-native-secret" },
        other: { token: "another-namespace-secret" },
      },
    }),
  );
  await adapter.discover();

  const ctx = {
    authorization: { valid: true },
    grants: [{ scope: "tools.invoke" }],
    signature: "ai-auth-signature",
    walletId: "did:key:abc",
    room: "research",
  };
  await adapter.invoke(TOOL_ID, { query: "x" }, ctx);

  const template = client.registered[0];
  assert.equal(template.apiKey, "provider-native-secret");
  assert.equal(template.token, undefined); // other manual's namespace is isolated
  for (const key of [
    "grants",
    "signature",
    "walletId",
    "room",
    "authorization",
  ]) {
    assert.equal(Object.hasOwn(template, key), false);
  }

  const call = client.calls[0];
  assert.deepEqual(call.args, { query: "x" });
  assert.deepEqual(Object.keys(call.options), ["signal"]);
});

test("expired AI Auth authorization fails closed before the native call", async () => {
  const client = fakeClient();
  const adapter = createUtcpAdapter(options(client));
  await adapter.discover();
  await assert.rejects(
    () =>
      adapter.invoke(
        TOOL_ID,
        {},
        {
          authorization: { expiresAt: Date.now() - 1000 },
        },
      ),
    (error) => error.code === UTCP_ERROR_CODES.AUTH_EXPIRED,
  );
  assert.equal(client.calls.length, 0);

  assert.doesNotThrow(() =>
    checkUtcpAuthorization({
      authorization: { exp: Math.floor(Date.now() / 1000) + 60 },
    }),
  );
  assert.throws(
    () =>
      checkUtcpAuthorization({
        authorization: { exp: Math.floor(Date.now() / 1000) - 60 },
      }),
    (error) => error.code === UTCP_ERROR_CODES.AUTH_EXPIRED,
  );
});

// ---------------------------------------------------------------------------
// Native errors
// ---------------------------------------------------------------------------

test("native errors and codes are preserved alongside a normalized outcome", async () => {
  const client = fakeClient({
    callImpl() {
      const error = new Error("provider rate limit reached");
      error.code = "RATE_LIMITED";
      error.data = { retryAfterMs: 1000 };
      throw error;
    },
  });
  const adapter = createUtcpAdapter(options(client));
  await adapter.discover();

  const result = await adapter.invoke(TOOL_ID, {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, UTCP_ERROR_CODES.UTCP_NATIVE_ERROR);
  assert.equal(result.error.nativeCode, "RATE_LIMITED");
  assert.equal(result.native.error.code, "RATE_LIMITED");
  assert.equal(result.native.error.message, "provider rate limit reached");
  assert.deepEqual(result.native.error.data, { retryAfterMs: 1000 });
  assert.equal(result.nativeCancellationSupported, false);
});

// ---------------------------------------------------------------------------
// Deadline, cancel, close
// ---------------------------------------------------------------------------

function hangingClient() {
  return fakeClient({ callImpl: () => new Promise(() => {}) });
}

test("deadline returns TIMEOUT truthfully when the SDK cannot cancel", async () => {
  const adapter = createUtcpAdapter(
    options(hangingClient(), { deadlineMs: 20 }),
  );
  await adapter.discover();
  const result = await adapter.invoke(TOOL_ID, {}, { requestId: "deadline-1" });
  assert.equal(result.error.code, UTCP_ERROR_CODES.TIMEOUT);
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.nativeCallMayStillRun, true);
  assert.equal(result.nativeCancellationSupported, false);
});

test("cancel(requestId) reports CANCELLED, not a false success", async () => {
  const adapter = createUtcpAdapter(
    options(hangingClient(), { deadlineMs: 5000 }),
  );
  await adapter.discover();
  const pending = adapter.invoke(TOOL_ID, {}, { requestId: "cancel-1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await adapter.cancel("cancel-1");
  const result = await pending;
  assert.equal(result.error.code, UTCP_ERROR_CODES.CANCELLED);
  assert.equal(result.cancelled, true);
  assert.equal(result.nativeCallMayStillRun, true);
  // Cancelling an unknown id is a harmless no-op.
  await assert.doesNotReject(() => adapter.cancel("never-existed"));
});

test("an external AbortSignal cancels the wrapper", async () => {
  const adapter = createUtcpAdapter(
    options(hangingClient(), { deadlineMs: 5000 }),
  );
  await adapter.discover();
  const controller = new AbortController();
  const pending = adapter.invoke(
    TOOL_ID,
    {},
    { requestId: "abort-1", signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const result = await pending;
  assert.equal(result.error.code, UTCP_ERROR_CODES.CANCELLED);
  assert.equal(result.cancelled, true);
});

test("close deregisters manuals and fails subsequent calls closed", async () => {
  const client = fakeClient();
  const adapter = createUtcpAdapter(options(client));
  await adapter.discover();
  await adapter.close();
  await adapter.close(); // idempotent
  assert.deepEqual(client.deregistered, ["github"]);
  await assert.rejects(
    () => adapter.invoke(TOOL_ID, {}, {}),
    (error) => error.code === UTCP_ERROR_CODES.TOOL_UNAVAILABLE,
  );
});

// ---------------------------------------------------------------------------
// Bounded output
// ---------------------------------------------------------------------------

test("large native results are bounded without changing small results", async () => {
  assert.deepEqual(boundUtcpOutput({ a: 1 }, 1024), { a: 1 });
  const client = fakeClient({
    callImpl: () => ({ blob: "x".repeat(50_000) }),
  });
  const adapter = createUtcpAdapter(options(client, { maxOutputBytes: 256 }));
  await adapter.discover();
  const result = await adapter.invoke(TOOL_ID, {}, {});
  assert.equal(result.ok, true);
  assert.equal(result.result.__utcpTruncated, true);
  assert.ok(result.result.bytes > 256);
  assert.ok(Buffer.byteLength(result.result.preview, "utf8") <= 256);
});

// ---------------------------------------------------------------------------
// Independent security review regressions (2026-11-19)
// ---------------------------------------------------------------------------

test("a remote manual may not redirect to a hostname that resolves to loopback", async () => {
  const redirectFetch = async (url) => {
    if (String(url).startsWith("https://manual.example.com/")) {
      return {
        headers: {
          get: (name) =>
            name === "location" ? "https://rebind.example.com/manual" : null,
        },
      };
    }
    return { headers: { get: () => null } };
  };
  const adapter = createUtcpAdapter(
    options(fakeClient(), {
      redirectFetch,
      resolver: async (host) =>
        String(host).includes("rebind") ? ["127.0.0.1"] : [PUBLIC_IP],
    }),
  );
  await assert.rejects(
    () => adapter.discover(),
    (error) => /LOOPBACK/u.test(error.code ?? ""),
  );
});

test("provider config cannot replace the validated manual url", async () => {
  const client = fakeClient();
  const adapter = createUtcpAdapter(
    options(client, {
      credentials: { github: { url: "http://127.0.0.1:9999/steal" } },
    }),
  );
  await adapter.discover();
  assert.equal(client.registered[0].url, "https://manual.example.com/utcp");
});

test("oversized native error data is bounded", async () => {
  const client = fakeClient({
    callImpl: () => {
      const error = new Error("provider failed");
      error.data = { blob: "x".repeat(20_000) };
      throw error;
    },
  });
  const adapter = createUtcpAdapter(options(client, { maxOutputBytes: 300 }));
  await adapter.discover();
  const result = await adapter.invoke(TOOL_ID, {}, { nativeAuthorized: true });
  assert.equal(result.ok, false);
  assert.equal(result.native.__utcpTruncated, true);
});

test("a manual id distinct from its name still produces a registrable descriptor", async () => {
  const adapter = createUtcpAdapter(
    options(fakeClient(), {
      manuals: [
        { id: "m-123", name: "github", url: "https://manual.example.com/utcp" },
      ],
    }),
  );
  const [descriptor] = await adapter.discover();
  assert.equal(descriptor.id, "utcp:github:issues.search");
  assert.equal(descriptor.providerId, "github");
});
