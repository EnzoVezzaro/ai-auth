// One room member must not be able to evict other providers' tool catalogs by
// announcing many sessions, and a catalog must name its own signer.
import assert from "node:assert/strict";
import test from "node:test";
import { createAIAuthAgentClient } from "../packages/p2p/index.js";

function room() {
  const listeners = new Set();
  return {
    api: {
      wallet: { id: "agent:me-123456789", name: "Me" },
      session: "my-session",
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async send() {},
    },
    emit(issuer, payload) {
      for (const listener of [...listeners])
        listener({
          direction: "in",
          envelope: { body: { type: "agent/action", issuer, payload } },
        });
    },
  };
}

const catalog = (session, tools) => ({
  kind: "tool-catalog",
  targetWallet: null,
  targetSession: session,
  targetNonce: `nonce-${session}-1234567890`,
  session,
  expiresAt: Date.now() + 60_000,
  tools,
});

test("a catalog naming another wallet as its target is refused", async () => {
  const r = room();
  const client = createAIAuthAgentClient(r.api);
  r.emit(
    "agent:attacker-123456",
    catalog("attacker-session", [
      { name: "a.tool", description: "d", inputSchema: {} },
    ]),
  );
  assert.equal(client.catalogs.length, 0, "a foreign catalog is not accepted");
  client.close();
});

test("a flooding issuer cannot evict another provider's catalog", async () => {
  const r = room();
  const client = createAIAuthAgentClient(r.api);
  const tool = (name) => ({
    name,
    description: "d",
    inputSchema: { type: "object", properties: {} },
  });
  const victim = catalog("victim-session", [tool("victim.tool")]);
  victim.targetWallet = "agent:victim-123456";
  r.emit("agent:victim-123456", victim);
  for (let i = 0; i < 12; i += 1) {
    const flood = catalog(`flood-session-${i}`, [tool(`flood.tool${i}`)]);
    flood.targetWallet = "agent:attacker-123456";
    r.emit("agent:attacker-123456", flood);
  }
  const kept = client.catalogs;
  assert.ok(
    kept.some((c) => c.wallet === "agent:victim-123456"),
    "the real provider's catalog survives the flood",
  );
  assert.ok(
    kept.filter((c) => c.wallet === "agent:attacker-123456").length <= 4,
    "one issuer cannot fill the catalog map",
  );
  client.close();
});
