// P0-04: explicit, reproducible identity bootstrap from a browser install
// package. P0-05: public connect descriptor + GitHub Pages subpath discovery.
// No secret, passphrase or private key material is printed or asserted here.
globalThis.BroadcastChannel ??= class {
  postMessage() {}
  close() {}
};
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import {
  bindInstance,
  createInstanceId,
  createWallet,
} from "@enzovezzaro/ai-auth-wallet";
import { createFileKeystore } from "@enzovezzaro/ai-auth-agent";
import { grantPath } from "../approval.js";
import {
  fetchSiteManifest,
  manifestCandidates,
  parseConnectInput,
} from "../connect-input.js";

globalThis.crypto ??= webcrypto;
globalThis.indexedDB ??= new IDBFactory();

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const PASS = "bootstrap fixture passphrase 2026";
const env = { ...process.env, AI_AUTH_PASSPHRASE: PASS };

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-bootstrap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "agent");
}

const run = (args, useEnv = env) =>
  spawnSync(process.execPath, [cli, ...args], {
    env: useEnv,
    input: "",
    encoding: "utf8",
    timeout: 20_000,
  });

function runAsync(args, useEnv = env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: useEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out: ${stderr}`));
    }, 20_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end();
  });
}

async function makeInstallPackage(name = "Bootstrapped agent") {
  const wallet = await createWallet({ name, passphrase: PASS, persist: false });
  const instanceId = createInstanceId();
  const binding = await bindInstance(wallet, instanceId);
  return {
    format: "ai-auth-agent-install",
    version: 1,
    name: wallet.name,
    walletId: wallet.id,
    instanceId,
    binding,
    backup: wallet.backup,
    site: null,
  };
}

async function writePackage(t, pkg, label = "install") {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-package-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${label}.json`);
  await writeFile(file, JSON.stringify(pkg), { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------
// P0-04 — bootstrapping with explicit approval
// ---------------------------------------------------------------------------

test("init --from-install imports a browser identity from a clean keystore", async (t) => {
  const dir = await scratch(t);
  const pkg = await makeInstallPackage();
  const file = await writePackage(t, pkg);
  const r = run(["init", "--keystore-dir", dir, "--from-install", file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), pkg.walletId);
  assert.ok(!r.stdout.includes(PASS) && !r.stderr.includes(PASS));
  assert.ok(!r.stderr.includes(pkg.backup));
  if (process.platform !== "win32")
    assert.equal(
      (await stat(path.join(dir, "identity.json"))).mode & 0o777,
      0o600,
    );
  assert.equal(
    run(["whoami", "--keystore-dir", dir]).stdout.trim(),
    pkg.walletId,
  );
  // The imported keystore unlocks as the same identity in a real agent runtime.
  const wallet = await createFileKeystore({
    dir,
    passphrase: PASS,
    env: {},
  }).unlock();
  assert.equal(wallet.id, pkg.walletId);
  assert.equal(wallet.instanceId, pkg.instanceId);
});

test("setup/init never create or replace a keystore implicitly", async (t) => {
  const clean = await scratch(t);
  const r = run(["setup", "--keystore-dir", clean]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--from-install/);
  assert.equal(run(["whoami", "--keystore-dir", clean]).status, 1);

  const dir = await scratch(t);
  const first = await makeInstallPackage("First agent");
  const other = await makeInstallPackage("Other agent");
  const f1 = await writePackage(t, first, "first");
  const f2 = await writePackage(t, other, "other");
  assert.equal(
    run(["init", "--keystore-dir", dir, "--from-install", f1]).status,
    0,
  );
  const before = await readFile(path.join(dir, "identity.json"), "utf8");
  const denied = run(["init", "--keystore-dir", dir, "--from-install", f2]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /--replace/);
  assert.equal(await readFile(path.join(dir, "identity.json"), "utf8"), before);
});

test("setup bootstraps from the install package and then serves MCP", async (t) => {
  const dir = await scratch(t);
  const pkg = await makeInstallPackage("Setup agent");
  const file = await writePackage(t, pkg);
  const r = await runAsync([
    "setup",
    "--keystore-dir",
    dir,
    "--from-install",
    file,
    "--origin",
    "https://site.example",
    "--room",
    "lobby",
    "--caps",
    "presence.read",
    "--approve",
    "presence.read",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Identity imported for this agent/);
  assert.match(r.stderr, /ai-auth-mcp ready/);
  assert.equal(
    run(["whoami", "--keystore-dir", dir]).stdout.trim(),
    pkg.walletId,
  );
});

test("setup reuses the same identity without duplicating it", async (t) => {
  const dir = await scratch(t);
  const pkg = await makeInstallPackage("Reused agent");
  const file = await writePackage(t, pkg);
  assert.equal(
    run(["init", "--keystore-dir", dir, "--from-install", file]).status,
    0,
  );
  const before = await readFile(path.join(dir, "identity.json"), "utf8");
  const args = [
    "setup",
    "--keystore-dir",
    dir,
    "--from-install",
    file,
    "--origin",
    "https://site.example",
    "--room",
    "lobby",
    "--caps",
    "presence.read",
    "--approve",
    "presence.read",
  ];
  const r = await runAsync(args);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Identity reused/);
  assert.equal(await readFile(path.join(dir, "identity.json"), "utf8"), before);
  assert.equal(
    run(["whoami", "--keystore-dir", dir]).stdout.trim(),
    pkg.walletId,
  );
});

test("--replace archives the old identity and clears saved grants and the MCP secret", async (t) => {
  const dir = await scratch(t);
  const first = await makeInstallPackage("Original agent");
  const second = await makeInstallPackage("Replacement agent");
  const f1 = await writePackage(t, first, "first");
  const f2 = await writePackage(t, second, "second");
  assert.equal(
    run(["init", "--keystore-dir", dir, "--from-install", f1]).status,
    0,
  );
  await writeFile(grantPath(dir), "{}\n", { mode: 0o600 });
  await writeFile(path.join(dir, "http-secret"), "previous-secret-value", {
    mode: 0o600,
  });
  const r = run([
    "init",
    "--keystore-dir",
    dir,
    "--from-install",
    f2,
    "--replace",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), second.walletId);
  assert.match(
    r.stderr,
    /grants and the local MCP endpoint secret were cleared/,
  );
  assert.equal(
    run(["whoami", "--keystore-dir", dir]).stdout.trim(),
    second.walletId,
  );
  await assert.rejects(readFile(grantPath(dir)), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(dir, "http-secret")), {
    code: "ENOENT",
  });
});

test("a tampered package or a missing passphrase fails closed without leaking secrets", async (t) => {
  const dir = await scratch(t);
  const pkg = await makeInstallPackage();
  const tampered = await writePackage(
    t,
    { ...pkg, walletId: "agent:tampered-value" },
    "tampered",
  );
  const bad = run(["init", "--keystore-dir", dir, "--from-install", tampered]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /binding/i);

  const good = await writePackage(t, pkg);
  const noPass = { ...process.env };
  delete noPass.AI_AUTH_PASSPHRASE;
  const missing = run(
    ["init", "--keystore-dir", dir, "--from-install", good],
    noPass,
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /passphrase/i);
});

// ---------------------------------------------------------------------------
// P0-04 (clean machine) — explicit, opt-in identity creation. `serve` never
// mints an identity; `init --new-identity` is the one opt-in path.
// ---------------------------------------------------------------------------

test("init --new-identity creates and prints a fresh identity in a clean directory", async (t) => {
  const dir = await scratch(t);
  const r = run([
    "init",
    "--new-identity",
    "--keystore-dir",
    dir,
    "--name",
    "Fresh agent",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^agent:[A-Za-z0-9_-]+$/u);
  assert.ok(!r.stdout.includes(PASS) && !r.stderr.includes(PASS));
  assert.equal(
    run(["whoami", "--keystore-dir", dir]).stdout.trim(),
    r.stdout.trim(),
  );
  if (process.platform !== "win32")
    assert.equal(
      (await stat(path.join(dir, "identity.json"))).mode & 0o777,
      0o600,
    );
  // The created keystore unlocks as a real identity in the agent runtime.
  const wallet = await createFileKeystore({
    dir,
    passphrase: PASS,
    env: {},
  }).unlock();
  assert.equal(wallet.id, r.stdout.trim());
});

test("plain serve on a clean directory fails, names the exact next command and creates nothing", async (t) => {
  const clean = await scratch(t);
  const r = run([
    "serve",
    "--keystore-dir",
    clean,
    "--origin",
    "https://site.example",
    "--room",
    "lobby",
    "--caps",
    "presence.read",
    "--approve",
    "presence.read",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /init --new-identity/u);
  assert.doesNotMatch(r.stderr, /agent ready|listening/u);
  await assert.rejects(readFile(path.join(clean, "identity.json")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(grantPath(clean)), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(clean, "runtime.json")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(path.join(clean, "http-secret")), {
    code: "ENOENT",
  });
});

test("init --new-identity refuses to overwrite an existing keystore without --replace", async (t) => {
  const dir = await scratch(t);
  assert.equal(
    run(["init", "--new-identity", "--keystore-dir", dir]).status,
    0,
  );
  const before = await readFile(path.join(dir, "identity.json"), "utf8");
  const state = {
    [grantPath(dir)]: "{}\n",
    [path.join(dir, "runtime.json")]: "{}\n",
    [path.join(dir, "http-secret")]: "previous-secret-value",
  };
  for (const [file, text] of Object.entries(state))
    await writeFile(file, text, { mode: 0o600 });

  const denied = run(["init", "--new-identity", "--keystore-dir", dir]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /--replace/u);
  assert.equal(await readFile(path.join(dir, "identity.json"), "utf8"), before);
  for (const [file, text] of Object.entries(state))
    assert.equal(await readFile(file, "utf8"), text);
});

test("init --new-identity --replace archives the old identity and clears saved state", async (t) => {
  const dir = await scratch(t);
  const first = run(["init", "--new-identity", "--keystore-dir", dir]);
  assert.equal(first.status, 0, first.stderr);
  const before = await readFile(path.join(dir, "identity.json"), "utf8");
  await writeFile(grantPath(dir), "{}\n", { mode: 0o600 });
  await writeFile(path.join(dir, "runtime.json"), "{}\n", { mode: 0o600 });
  await writeFile(path.join(dir, "http-secret"), "previous-secret-value", {
    mode: 0o600,
  });

  const r = run(["init", "--new-identity", "--keystore-dir", dir, "--replace"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^agent:[A-Za-z0-9_-]+$/u);
  assert.notEqual(r.stdout.trim(), first.stdout.trim());
  assert.match(
    r.stderr,
    /grants and the local MCP endpoint secret were cleared/u,
  );
  const archived = await readFile(path.join(dir, "identity.json"), "utf8").then(
    (text) => text !== before,
  );
  assert.ok(archived, "a fresh identity file replaces the previous one");
  await assert.rejects(readFile(grantPath(dir)), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(dir, "runtime.json")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(path.join(dir, "http-secret")), {
    code: "ENOENT",
  });
});

// ---------------------------------------------------------------------------
// P0-05 — public descriptor and explicit project-subpath discovery
// ---------------------------------------------------------------------------

const PAGES_ORIGIN = "https://enzovezzaro.github.io";
const PAGES_PAGE = `${PAGES_ORIGIN}/ai-auth/connect-agent/?room=lobby&x=1`;
const PAGES_DOC = {
  type: "ai-auth-discovery",
  v: 1,
  origin: PAGES_ORIGIN,
  walletUrl: `${PAGES_ORIGIN}/ai-auth/wallet/`,
  capabilities: ["presence.read", "tools.invoke"],
  rooms: [{ name: "research", mode: "open" }],
  webmcp: true,
};

function pagesFetchFactory(responses) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    const hit = responses[String(url)];
    if (hit)
      return new Response(JSON.stringify(hit), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response("", { status: 404 });
  };
  return { fetchImpl, seen };
}

test("a public connect descriptor is parsed as strict data, not a token", () => {
  const descriptor = {
    protocol: "ai-auth-wallet",
    version: 1,
    origin: PAGES_ORIGIN,
    room: "lobby",
    walletUrl: `${PAGES_ORIGIN}/ai-auth/wallet/`,
    capabilities: ["presence.read"],
    discoveryBaseUrl: PAGES_PAGE,
  };
  const parsed = parseConnectInput(JSON.stringify(descriptor));
  assert.equal(parsed.origin, PAGES_ORIGIN);
  assert.equal(parsed.room, "lobby");
  assert.equal(parsed.walletUrl, descriptor.walletUrl);
  assert.deepEqual(parsed.capabilities, ["presence.read"]);
  assert.equal(parsed.discoveryBaseUrl, PAGES_PAGE);
  assert.equal(parsed.discoveryOnly, false);
  assert.equal(parsed.source, "instruction");

  assert.throws(
    () =>
      parseConnectInput(
        JSON.stringify({ ...descriptor, origin: `${PAGES_ORIGIN}/ai-auth/` }),
      ),
    /exact origin/,
  );
  assert.throws(
    () =>
      parseConnectInput(JSON.stringify({ ...descriptor, capabilities: ["*"] })),
    /capabilit/i,
  );
  assert.throws(
    () =>
      parseConnectInput(
        JSON.stringify({
          ...descriptor,
          discoveryBaseUrl: "https://evil.example/ai-auth/",
        }),
      ),
    /exact site origin/,
  );
  assert.throws(
    () =>
      parseConnectInput(
        `https://user:secret@${PAGES_ORIGIN.slice(8)}/ai-auth/`,
      ),
    /credentials/,
  );
});

test("a Pages page URL yields an explicit subpath manifest, without redirects or credentials", async () => {
  const parsed = parseConnectInput(PAGES_PAGE);
  assert.equal(parsed.origin, PAGES_ORIGIN);
  assert.equal(parsed.discoveryBaseUrl, PAGES_PAGE);
  assert.deepEqual(manifestCandidates(parsed.origin, parsed.discoveryBaseUrl), [
    `${PAGES_ORIGIN}/.well-known/ai-auth.json`,
    `${PAGES_ORIGIN}/ai-auth/.well-known/ai-auth.json`,
  ]);
  const { fetchImpl, seen } = pagesFetchFactory({
    [`${PAGES_ORIGIN}/ai-auth/.well-known/ai-auth.json`]: PAGES_DOC,
  });
  const site = await fetchSiteManifest(parsed.origin, {
    fetch: fetchImpl,
    baseUrl: parsed.discoveryBaseUrl,
  });
  assert.equal(site.room, "research");
  assert.deepEqual(site.capabilities, ["presence.read", "tools.invoke"]);
  assert.equal(site.source, "manifest");
  assert.equal(site.provisional, false);
  assert.equal(site.discoveryOnly, true);
  assert.ok(seen.length >= 2);
  assert.ok(
    seen.every(
      (request) =>
        request.init.redirect === "error" &&
        request.init.credentials === "omit" &&
        !String(request.init.headers?.accept ?? "").includes("secret"),
    ),
  );
});

test("the CLI discovers the Pages subpath end to end from a page URL", async (t) => {
  const dir = await scratch(t);
  assert.equal(run(["init", "--keystore-dir", dir]).status, 0);
  let base = "";
  const server = createServer((req, res) => {
    if (req.url === "/ai-auth/.well-known/ai-auth.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...PAGES_DOC, origin: base }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const pageUrl = `${base}/ai-auth/connect-agent/?room=lobby`;
  const r = await runAsync([
    "serve",
    "--keystore-dir",
    dir,
    "--connect",
    pageUrl,
    "--approve",
    "presence.read",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(`Site origin : ${base}`), r.stderr);
  assert.match(r.stderr, /Room\s+: research/u);
  assert.match(r.stderr, /Requested by: manifest/u);
});

test("a URL with no manifest is an honest, recoverable error, not consent", async (t) => {
  const dir = await scratch(t);
  assert.equal(run(["init", "--keystore-dir", dir]).status, 0);
  let base = "";
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await runAsync([
    "serve",
    "--keystore-dir",
    dir,
    "--connect",
    `${base}/ai-auth/connect-agent/`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Pass --caps/);
  assert.doesNotMatch(r.stderr, /Connected|connected now/i);
});
