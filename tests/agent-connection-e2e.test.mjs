// W2 skeleton: deterministic multi-agent connection harness.
//
// This file OWNS only itself. It intentionally reuses the in-process hub from
// packages/agent/test instead of a browser or Nostr relay, so every scenario
// here runs offline and in bounded time. Browser-level fixtures
// (scripts/e2e/helpers.mjs :: approveWallet, scripts/e2e/participants.mjs ::
// HeadlessAgent) are named in docs/AGENT_E2E_PLAN.md's matrix and are the
// intended upgrade path for the remote-site variants; they are not wired in
// here to keep this skeleton runnable with `node --test <this file>` alone.
globalThis.BroadcastChannel = class {
  postMessage() {}
  close() {}
};

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAIAuthAgentClient,
  createAIAuthConnectInstruction,
} from "../packages/p2p/index.js";
import { createFileKeystore } from "../packages/agent/keystore.js";
import { createAgentRuntime } from "../packages/agent/runtime.js";
import { createHub } from "../packages/agent/test/fake-transport.mjs";
import { resolveApproval } from "../packages/mcp/approval.js";
import { parseConnectInput } from "../packages/mcp/connect-input.js";

globalThis.crypto ??= webcrypto;

const PASS = "correct horse battery staple";
const CAPS = ["presence.read", "messages.send", "tools.invoke"];
const ORIGIN = "https://connection.example";

/** One runtime with its own keystore dir; same dir => same wallet on restart. */
async function makeRuntime(t, hub, name, { dir, create = true } = {}) {
  const home = dir ?? (await mkdtemp(path.join(tmpdir(), "ai-auth-conn-")));
  if (!dir) t.after(() => rm(home, { recursive: true, force: true }));
  const keystore = createFileKeystore({ dir: home, passphrase: PASS, env: {} });
  if (create) await keystore.create({ name });
  const runtime = createAgentRuntime({
    keystore,
    origin: ORIGIN,
    room: "lobby",
    capabilities: CAPS,
    descriptor: { name },
    joinRoom: hub.joinRoom,
    delay: async () => {},
    random: () => 0.5,
  });
  t.after(() => runtime.close());
  return { runtime, dir: home, keystore };
}

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("condition not reached");
};

test("connect: instruction round-trips through the MCP parser and approval is a subset", async () => {
  const made = createAIAuthConnectInstruction({
    siteName: "Connection test site",
    siteOrigin: ORIGIN,
    walletUrl: `${ORIGIN}/wallet/`,
    capabilities: CAPS,
    room: "lobby",
  });
  const parsed = parseConnectInput(made.instruction);
  assert.equal(parsed.origin, ORIGIN);
  assert.equal(parsed.room, "lobby");
  // parseConnectInput normalizes capabilities to sorted order.
  assert.deepEqual([...parsed.capabilities], [...CAPS].sort());

  const granted = await resolveApproval({
    requested: CAPS,
    interactive: false,
    ask: async () => assert.fail("no TTY in a harness"),
    approve: ["presence.read", "messages.send"],
  });
  assert.deepEqual(granted, ["messages.send", "presence.read"]);
  await assert.rejects(
    resolveApproval({
      requested: CAPS,
      interactive: false,
      ask: async () => assert.fail("no TTY"),
      approve: ["presence.read", "admin.write"],
    }),
    /not requested|escalat/i,
  );
});

test("two headless agents discover each other and exchange signed message and cursor", async (t) => {
  const hub = createHub();
  const a = await makeRuntime(t, hub, "Agent A");
  const b = await makeRuntime(t, hub, "Agent B");
  await a.runtime.join();
  await b.runtime.join();

  await until(() =>
    a.runtime.peers().some((p) => p.id === b.runtime.identity.id),
  );
  assert.notEqual(a.runtime.identity.id, b.runtime.identity.id);

  const heard = [];
  b.runtime.onEvent((m) => {
    if (m.direction === "in" && m.envelope?.body?.type === "message/text")
      heard.push(m.envelope.body);
  });
  await a.runtime.send("message/text", { text: "signed hello" });
  await until(() => heard.length === 1);
  assert.equal(heard[0].issuer, a.runtime.identity.id);
  assert.equal(heard[0].payload.text, "signed hello");

  const cursors = [];
  b.runtime.onEvent((m) => {
    if (m.direction === "in" && m.envelope?.body?.type === "presence/cursor")
      cursors.push(m.envelope.body);
  });
  const client = createAIAuthAgentClient(a.runtime.agentRoom);
  t.after(() => client.close());
  client.publishCursor({ x: 0.4, y: 0.6 });
  await until(() => cursors.length === 1);
  assert.equal(cursors[0].issuer, a.runtime.identity.id);
});

test("stays connected across a restart: same wallet, saved room, no ghost", async (t) => {
  const hub = createHub();
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-conn-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await makeRuntime(t, hub, "Returning", { dir });
  const observer = await makeRuntime(t, hub, "Observer");
  await first.runtime.join();
  await observer.runtime.join();
  await until(() =>
    observer.runtime.peers().some((p) => p.id === first.runtime.identity.id),
  );
  const id = first.runtime.identity.id;

  await first.runtime.close();
  await until(() => !observer.runtime.peers().some((p) => p.id === id));

  const again = await makeRuntime(t, hub, "Returning", { dir, create: false });
  // identity is populated on resume (keystore unlock), not at construction.
  assert.equal(await again.runtime.resume(), true);
  assert.equal(again.runtime.identity.id, id, "wallet identity survived");
  assert.equal(again.runtime.room, "lobby", "saved room was restored");
  await until(() =>
    observer.runtime
      .peers()
      .some((p) => p.id === id && typeof p.session === "string"),
  );
});
