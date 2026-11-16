import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const PASS = "cli test passphrase 123";
const SITE = "https://site.example";

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "agent");
}
const env = { ...process.env, AI_AUTH_PASSPHRASE: PASS };
const run = (args, input = "") =>
  spawnSync(process.execPath, [cli, ...args], {
    env,
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
const baseArgs = (dir) => [
  "--keystore-dir",
  dir,
  "--origin",
  SITE,
  "--room",
  "lobby",
  "--caps",
  "presence.read,messages.send,tools.invoke",
];

test("init creates a 0600 keystore and prints only the public id", async (t) => {
  const dir = await scratch(t);
  const r = run(["init", "--keystore-dir", dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^agent:[A-Za-z0-9_-]+$/);
  assert.ok(!r.stdout.includes(PASS) && !r.stderr.includes(PASS));
  if (process.platform !== "win32")
    assert.equal(
      (await stat(path.join(dir, "identity.json"))).mode & 0o777,
      0o600,
    );
  assert.equal(
    run(["whoami", "--keystore-dir", dir]).stdout.trim(),
    r.stdout.trim(),
  );
});

test("non-TTY serve without --approve refuses and shows the preview", async (t) => {
  const dir = await scratch(t);
  run(["init", "--keystore-dir", dir]);
  const r = run(["serve", ...baseArgs(dir)]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Refusing to auto-approve/);
  assert.match(r.stderr, /Scopes you can grant/);
  assert.match(r.stderr, /tools\.invoke/);
});

test("--approve cannot escalate beyond what the site requested", async (t) => {
  const dir = await scratch(t);
  run(["init", "--keystore-dir", dir]);
  const r = run([
    "serve",
    "--keystore-dir",
    dir,
    "--origin",
    SITE,
    "--caps",
    "presence.read",
    "--approve",
    "presence.read,tools.invoke",
  ]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not requested/);
  const wild = run(["serve", ...baseArgs(dir), "--approve", "*"]);
  assert.equal(wild.status, 3);
});

test("a bare URL never grants anything by itself", async (t) => {
  const dir = await scratch(t);
  run(["init", "--keystore-dir", dir]);
  const r = run([
    "serve",
    "--keystore-dir",
    dir,
    "--connect",
    SITE,
    "--no-manifest",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Pass --caps|none of the scopes/i);
});

test("serve with an exact subset exposes only the approved tools over stdio MCP", async (t) => {
  const dir = await scratch(t);
  run(["init", "--keystore-dir", dir]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve", ...baseArgs(dir), "--approve", "presence.read"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "t", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    "ai_auth_events",
    "ai_auth_join",
    "ai_auth_leave",
    "ai_auth_move",
    "ai_auth_status",
  ]);
  const status = await client.callTool({
    name: "ai_auth_status",
    arguments: {},
  });
  assert.equal(status.structuredContent.connection, "idle");
  assert.deepEqual(status.structuredContent.capabilities, ["presence.read"]);
  assert.equal(status.structuredContent.room, null);
});

test("--provide room publishes the built-in tools only with tools.invoke", async (t) => {
  const dir = await scratch(t);
  run(["init", "--keystore-dir", dir]);
  const denied = run([
    "serve",
    ...baseArgs(dir),
    "--approve",
    "presence.read",
    "--provide",
    "room",
  ]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /--provide room needs tools\.invoke/u);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      "serve",
      ...baseArgs(dir),
      "--approve",
      "presence.read,messages.send,tools.invoke",
      "--provide",
      "room",
    ],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "t", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  const status = await client.callTool({
    name: "ai_auth_status",
    arguments: {},
  });
  assert.deepEqual(status.structuredContent.provides, [
    "agent.ping",
    "agent.self",
  ]);
});

test("unlink refuses without --yes in non-TTY and removes the keystore with it", async (t) => {
  const dir = await scratch(t);
  run(["init", "--keystore-dir", dir]);
  assert.notEqual(run(["unlink", "--keystore-dir", dir]).status, 0);
  assert.equal(run(["unlink", "--keystore-dir", dir, "--yes"]).status, 0);
  assert.notEqual(run(["whoami", "--keystore-dir", dir]).status, 0);
});

test("serve --http exposes the approved tools over Streamable HTTP at a secret path", async (t) => {
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const dir = await scratch(t);
  run(["init", "--keystore-dir", dir]);
  const child = spawn(
    process.execPath,
    [
      cli,
      "serve",
      ...baseArgs(dir),
      "--approve",
      "presence.read",
      "--http",
      "0",
    ],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  t.after(() => child.kill());
  let stderr = "";
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no endpoint: ${stderr}`)),
      15_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(
        /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{16,})/u,
      );
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const client = new Client({ name: "t", version: "1" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    "ai_auth_events",
    "ai_auth_join",
    "ai_auth_leave",
    "ai_auth_move",
    "ai_auth_status",
  ]);
  const wrong = await fetch(new URL("/mcp/not-the-secret", endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(wrong.status, 404);
});

test("serve --http keeps the same endpoint across restarts of the same keystore", async (t) => {
  const dir = await scratch(t);
  run(["init", "--keystore-dir", dir]);
  const endpointOf = async () => {
    const child = spawn(
      process.execPath,
      [
        cli,
        "serve",
        ...baseArgs(dir),
        "--approve",
        "presence.read",
        "--http",
        "0",
      ],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    t.after(() => child.kill());
    let stderr = "";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no endpoint: ${stderr}`)),
        15_000,
      );
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const match = stderr.match(
          /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{16,})/u,
        );
        if (match) {
          clearTimeout(timer);
          child.kill();
          resolve(match[1].replace(/:\d+\//u, "/"));
        }
      });
    });
  };
  const first = await endpointOf();
  const second = await endpointOf();
  assert.equal(second, first, "the secret path is stored with the keystore");
});
