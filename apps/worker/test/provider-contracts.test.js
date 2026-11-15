import { expect, test, vi } from "vitest";
import { createPluginHost } from "../../../packages/runtime/index.js";
import { createWorkerPlugins } from "../src/providers.js";

test("Worker adapters satisfy and exercise every runtime provider contract", async () => {
  const tenantRequests = [];
  const tenantStub = {
    async fetch(request) {
      tenantRequests.push(request);
      return Response.json({ forwarded: true });
    },
  };
  const workspaceBinding = {
    idFromName: vi.fn((name) => `workspace:${name}`),
    get: vi.fn((id) => {
      expect(id).toMatch(/^workspace:/u);
      return tenantStub;
    }),
  };
  const logger = vi.spyOn(console, "info").mockImplementation(() => {});
  const host = await createPluginHost(
    createWorkerPlugins({ WORKSPACES: workspaceBinding }),
  );

  try {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    await expect(
      host.get("identity").implementation.identify(publicKey),
    ).resolves.toMatch(/^agent:/u);
    expect(
      host
        .get("authorization")
        .implementation.allows(
          { capabilities: ["messages.read"] },
          "messages.read",
        ),
    ).toBe(true);
    expect(
      host
        .get("authorization")
        .implementation.allows(
          { capabilities: ["messages.read"] },
          "messages.write",
        ),
    ).toBe(false);

    const storage = host.get("storage").implementation.getTenant("tenant-a");
    const presence = host.get("presence").implementation.getTenant("tenant-a");
    expect(storage).toBe(tenantStub);
    expect(presence).toBe(tenantStub);
    expect(workspaceBinding.idFromName).toHaveBeenCalledTimes(2);

    await host
      .get("transport")
      .implementation.forwardTenant(
        storage,
        "/v1/messages",
        "POST",
        { actor: { agentId: "agent:test" }, text: "hello" },
        new Request("https://api.example/v1/messages", { method: "POST" }),
      );
    expect(tenantRequests).toHaveLength(1);
    expect(tenantRequests[0].url).toBe(
      "https://workspace.internal/v1/messages",
    );
    expect(tenantRequests[0].method).toBe("POST");
    expect(tenantRequests[0].headers.get("x-ai-auth-actor")).toBe(
      JSON.stringify({ agentId: "agent:test" }),
    );
    await expect(tenantRequests[0].json()).resolves.toEqual({
      actor: { agentId: "agent:test" },
      text: "hello",
    });

    host
      .get("observability")
      .implementation.record("http.request.started", { routeGroup: "tenants" });
    expect(logger).toHaveBeenCalledWith("http.request.started", {
      routeGroup: "tenants",
    });
  } finally {
    logger.mockRestore();
    await host.close();
  }
});
