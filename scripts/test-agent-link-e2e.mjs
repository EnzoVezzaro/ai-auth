// E2E for AI Auth agent connect links: a real Chromium page, the real
// `ai-auth-mcp` CLI as the agent, and real Nostr + WebRTC. No wallet is
// opened anywhere on the site side.
//
//  1. The site's Connect popup finds no known agent and shows a one-time link.
//  2. The agent creates its own identity on its machine, then runs
//     `serve --connect <link>`; the site shows it connected.
//  3. The agent knows which site it is on (ai_auth_status.site) and the site's
//     own tool answers it by its signed id (site.whoami).
//  4. A restarted agent with NO --connect, and a reloaded page (new site key),
//     reconnect with a fresh challenge and no new link.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchBrowser, root, startStaticServer } from "./e2e/helpers.mjs";

// The MCP client SDK ships with the MCP package (installed by
// `npm ci --prefix packages/mcp` in CI), not with the repository root.
const sdk = (file) =>
  import(
    path.join(
      root,
      "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm",
      file,
    )
  );
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");

const CLI = path.join(root, "packages/mcp/cli.js");
const PASSPHRASE = "agent link e2e passphrase 2026"; // synthetic fixture
const ROOM = `agent-link-e2e-${Date.now().toString(36)}`;
const SCOPES = "presence.read,messages.send,tools.invoke";
const RUN_LIMIT_MS = 6 * 60_000;

let server;
let browser;
let agent;
let keystoreDir;
let exitCode = 0;
const step = (n, text) => console.log(`STEP ${n}. ${text}`);

function runCli(args, { capture = false } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, AI_AUTH_PASSPHRASE: PASSPHRASE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => {
    stderr += d;
    if (process.env.AI_AUTH_E2E_DEBUG) process.stderr.write(d);
  });
  const done = new Promise((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return { child, done, out: () => stdout, err: () => stderr, capture };
}

async function startAgent(extra) {
  const proc = runCli([
    "serve",
    "--keystore-dir",
    keystoreDir,
    "--approve",
    SCOPES,
    "--http",
    "0",
    "--name",
    "e2e-agent",
    ...extra,
  ]);
  const deadline = Date.now() + 60_000;
  let url = null;
  while (!url && Date.now() < deadline) {
    url =
      proc
        .err()
        .match(/MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp\/\S+)/u)?.[1] ??
      null;
    if (proc.child.exitCode !== null)
      throw new Error(`agent exited: ${proc.err()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!url) throw new Error(`agent never printed its endpoint: ${proc.err()}`);
  const client = new Client({ name: "agent-link-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse(res.content.map((c) => c.text).join(""));
  };
  return {
    ...proc,
    call,
    async stop() {
      await client.close().catch(() => {});
      proc.child.kill("SIGTERM");
      await proc.done;
    },
  };
}

async function waitFor(fn, label, ms = 90_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const phase = (page) =>
  page.evaluate(() => window.__agentLinkSite?.link.state.phase ?? null);

async function openSite() {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  await page.goto(`${server.siteUrl}agent-link/?room=${ROOM}`);
  await page.waitForFunction(() => Boolean(window.__agentLinkSite));
  return { context, page };
}

const limit = setTimeout(() => {
  console.error("Whole-run timeout exceeded");
  process.exit(1);
}, RUN_LIMIT_MS);

try {
  server = await startStaticServer();
  browser = await launchBrowser();
  keystoreDir = await mkdtemp(path.join(tmpdir(), "ai-auth-link-agent-"));

  step(1, "Connect shows a one-time link when no agent is known");
  let site = await openSite();
  await site.page.click("#connect");
  const linkInput = site.page.locator(
    ".ai-auth-connect input[aria-label='Agent connect link']",
  );
  await linkInput.waitFor({ state: "visible", timeout: 30_000 });
  const link = await linkInput.inputValue();
  assert.match(
    link,
    /#ai-auth-link=/u,
    "the link carries its token in the fragment",
  );
  assert.equal(await phase(site.page), "needs-link");
  assert.equal(
    await site.page.locator('iframe[title="AI Auth wallet"]').count(),
    0,
    "no wallet is opened by the site",
  );

  step(
    2,
    "The agent creates its identity on its own machine and connects with the link",
  );
  const init = runCli([
    "init",
    "--new-identity",
    "--keystore-dir",
    keystoreDir,
  ]);
  assert.equal(await init.done, 0, init.err());
  const agentId = init.out().trim();
  assert.match(agentId, /^agent:/u);
  agent = await startAgent(["--connect", link]);
  await waitFor(
    async () => (await phase(site.page)) === "connected",
    "site connected",
  );
  const siteAgents = await site.page.evaluate(
    () => window.__agentLinkSite.link.state.agents,
  );
  assert.deepEqual(
    siteAgents.map((a) => a.id),
    [agentId],
    "the site sees exactly this agent",
  );
  assert.match(
    await site.page.locator("#status").innerText(),
    /Connected · e2e-agent/u,
  );

  step(
    3,
    "The agent knows it is connected to that site, and the site answers by signed id",
  );
  const status = await waitFor(async () => {
    const s = await agent.call("ai_auth_status");
    return s.site?.connected ? s : null;
  }, "agent status site.connected");
  assert.equal(status.site.site.name, "Agent connect example");
  assert.equal(status.site.site.origin, server.origin);
  assert.equal(status.site.via, "link");
  const whoami = await waitFor(async () => {
    const r = await agent.call("ai_auth_invoke", {
      name: "site.whoami",
      input: {},
    });
    return r.ok ? r : null;
  }, "site.whoami");
  assert.equal(whoami.result.connected, true);
  assert.equal(whoami.result.agent.id, agentId);
  assert.match(
    whoami.result.message,
    /You are connected to Agent connect example/u,
  );

  step(
    4,
    "Restart agent (no --connect) and reload page: reconnects with no new link",
  );
  await agent.stop();
  agent = await startAgent([]);
  assert.match(agent.err(), /Reconnecting to Agent connect example/u);
  // Same browser, page reloaded: a new site key, but the site still remembers
  // the agent (public id + pair secret in this origin's localStorage).
  await site.page.reload();
  await site.page.waitForFunction(() => Boolean(window.__agentLinkSite));
  await site.page.click("#connect");
  await waitFor(
    async () => (await phase(site.page)) === "connected",
    "automatic reconnect",
  );
  const again = await waitFor(async () => {
    const s = await agent.call("ai_auth_status");
    return s.site?.connected ? s : null;
  }, "agent reconnect status");
  assert.equal(again.site.via, "challenge");
  assert.equal(
    await site.page.evaluate(
      () => window.__agentLinkSite.link.state.agents.length,
    ),
    1,
  );

  console.log(
    "PASS agent-link E2E: link shown with no wallet, agent created its own identity, connected with the link, knew its site, site answered by signed id, and reconnected automatically after restart and reload.",
  );
} catch (error) {
  exitCode = 1;
  console.error("FAIL", error?.stack ?? error);
  if (agent)
    console.error(
      "agent stderr:\n",
      agent.err().replace(/\/mcp\/\S+/gu, "/mcp/<secret>"),
    );
} finally {
  clearTimeout(limit);
  await agent?.stop().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop().catch(() => {});
  if (keystoreDir) await rm(keystoreDir, { recursive: true, force: true });
  process.exit(exitCode);
}
