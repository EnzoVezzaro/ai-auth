import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { grantPath } from "../approval.js";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const PASS = "cli restart passphrase 123";
const SITE = "https://site.example";
const env = { ...process.env, AI_AUTH_PASSPHRASE: PASS };
const run = (args) =>
  spawnSync(process.execPath, [cli, ...args], {
    env,
    input: "",
    encoding: "utf8",
    timeout: 20_000,
  });

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-cli-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const base = (dir, room = "lobby", caps = "presence.read,messages.send") => [
  "--keystore-dir",
  dir,
  "--origin",
  SITE,
  "--room",
  room,
  "--caps",
  caps,
];
const start = (args, extraEnv = {}) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve", ...args],
    env: { ...env, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "restart-test", version: "1" });
  return { client, transport };
};

test("a restart reuses the saved scopes without --approve", async (t) => {
  const dir = await scratch(t);
  assert.equal(run(["init", "--keystore-dir", dir]).status, 0);
  const args = base(dir);

  const first = start([...args, "--approve", "presence.read"]);
  t.after(() => first.client.close());
  await first.client.connect(first.transport);
  const { tools } = await first.client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    "ai_auth_events",
    "ai_auth_join",
    "ai_auth_leave",
    "ai_auth_move",
    "ai_auth_status",
  ]);
  await first.client.close();

  const file = grantPath(dir);
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.origin, SITE);
  assert.equal(saved.room, "lobby");
  assert.deepEqual(saved.granted, ["presence.read"]);
  assert.equal(saved.sessionTtlMs, null, "no TTL means Never");

  // No --approve on restart: the saved grant stands in for it.
  const second = start(args);
  t.after(() => second.client.close());
  await second.client.connect(second.transport);
  const status = await second.client.callTool({
    name: "ai_auth_status",
    arguments: {},
  });
  assert.deepEqual(status.structuredContent.capabilities, ["presence.read"]);
  await second.client.close();
});

test("a numeric session TTL ends the headless session", async (t) => {
  const dir = await scratch(t);
  assert.equal(run(["init", "--keystore-dir", dir]).status, 0);
  const session = start([...base(dir), "--approve", "presence.read"], {
    AI_AUTH_SESSION_TTL_MS: "1500",
  });
  t.after(() => session.client.close());
  await session.client.connect(session.transport);
  const status = async () =>
    (
      await session.client.callTool({
        name: "ai_auth_status",
        arguments: {},
      })
    ).structuredContent;
  assert.equal((await status()).authorization, "active");
  const saved = JSON.parse(await readFile(grantPath(dir), "utf8"));
  assert.equal(saved.sessionTtlMs, 1500);
  assert.ok(saved.idleTimeoutMs > 0, "a numeric session has an idle ceiling");

  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if ((await status()).authorization !== "active") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const ended = await status();
  assert.equal(ended.authorization, "expired");
  assert.equal(ended.connection, "expired");
  assert.equal(ended.connected, false);
});

test("a changed origin, room or scope set refuses the saved grant", async (t) => {
  const dir = await scratch(t);
  assert.equal(run(["init", "--keystore-dir", dir]).status, 0);
  run(["serve", ...base(dir), "--approve", "presence.read"]);
  assert.ok((await readFile(grantPath(dir), "utf8")).includes("presence.read"));

  const changedRoom = run(["serve", ...base(dir, "elsewhere")]);
  assert.equal(changedRoom.status, 3);
  assert.match(changedRoom.stderr, /does not match/u);

  const changedScopes = run([
    "serve",
    ...base(dir, "lobby", "presence.read,messages.send,tools.invoke"),
  ]);
  assert.equal(changedScopes.status, 3);
  assert.match(changedScopes.stderr, /does not match/u);

  const changedOrigin = run([
    "serve",
    "--keystore-dir",
    dir,
    "--origin",
    "https://other.example",
    "--room",
    "lobby",
    "--caps",
    "presence.read,messages.send",
  ]);
  assert.equal(changedOrigin.status, 3);
  assert.match(changedOrigin.stderr, /does not match/u);
});

test("an explicit --approve replaces the saved grant and unlink removes it", async (t) => {
  const dir = await scratch(t);
  assert.equal(run(["init", "--keystore-dir", dir]).status, 0);
  run(["serve", ...base(dir), "--approve", "presence.read"]);

  const again = start([
    ...base(dir, "lobby", "presence.read,messages.send"),
    "--approve",
    "presence.read,messages.send",
  ]);
  t.after(() => again.client.close());
  await again.client.connect(again.transport);
  const status = await again.client.callTool({
    name: "ai_auth_status",
    arguments: {},
  });
  assert.deepEqual(status.structuredContent.capabilities, [
    "messages.send",
    "presence.read",
  ]);
  await again.client.close();
  assert.deepEqual(JSON.parse(await readFile(grantPath(dir), "utf8")).granted, [
    "messages.send",
    "presence.read",
  ]);

  assert.equal(run(["unlink", "--keystore-dir", dir, "--yes"]).status, 0);
  await assert.rejects(stat(grantPath(dir)), { code: "ENOENT" });
});
