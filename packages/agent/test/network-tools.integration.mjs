// Real network test: a tool provider runs in its own OS process with no
// browser, and this process calls its tools over public Nostr relays and WebRTC.
// Opt-in because it needs internet and a network that permits peer candidates:
//   npm run test:network --prefix packages/agent
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAIAuthAgentClient } from "@enzovezzaro/ai-auth-wallet";
import { createFileKeystore, createAgentRuntime } from "../index.js";

const PASS = "network test passphrase";
const ORIGIN = "https://agent-demo.example";
const script = fileURLToPath(
  new URL("../examples/tool-peer.mjs", import.meta.url),
);

const until = async (check, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
};

test("an agent process without a browser serves tools to another agent over the network", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "ai-auth-net-tools-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const room = `nettools-${process.pid}-${Date.now()}`;

  const provider = spawn(
    process.execPath,
    [script, path.join(base, "provider"), room, "Provider", "120"],
    { env: { ...process.env, AI_AUTH_PASSPHRASE: PASS } },
  );
  const providerLines = [];
  provider.stdout.on("data", (d) =>
    providerLines.push(
      ...String(d).split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    ),
  );
  provider.stderr.on("data", (d) => process.stderr.write(d));
  t.after(() => provider.kill());

  const keystore = createFileKeystore({
    dir: path.join(base, "requester"),
    passphrase: PASS,
    env: {},
  });
  await keystore.create({ name: "Requester" });
  const runtime = createAgentRuntime({
    keystore,
    origin: ORIGIN,
    room,
    capabilities: ["presence.read", "tools.invoke"],
    descriptor: { name: "Requester" },
  });
  t.after(() => runtime.close());
  await runtime.join();
  const client = createAIAuthAgentClient(runtime.agentRoom);
  t.after(() => client.close());

  const catalog = await until(
    () =>
      client.catalogs.find((c) =>
        c.tools.some((tool) => tool.name === "room.echo"),
      ),
    90_000,
  );
  assert.ok(catalog, "the provider's tool catalog reached this agent");
  assert.ok(
    providerLines.some((l) => l.event === "providing"),
    "the provider process published its tools",
  );

  const echoed = await client.callTool(catalog, "room.echo", {
    text: "hello over the network",
  });
  assert.deepEqual(echoed, {
    echo: "hello over the network",
    by: "Provider",
  });

  await assert.rejects(
    client.callTool(catalog, "room.secret", {}),
    /did not allow/,
  );
});
