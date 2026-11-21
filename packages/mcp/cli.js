#!/usr/bin/env node
import { readFile, rm, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  createFileKeystore,
  createAgentRuntime,
  installAgentIdentity,
  promptSecret,
} from "@enzovezzaro/ai-auth-agent";
import {
  NonceGuard,
  createPermissionRequest,
  verifyPermissionConsent,
} from "@enzovezzaro/ai-auth-wallet";
import { createAIAuthMcpServer, connectAIAuthMcpStdio } from "./index.js";
import { serveAIAuthMcpHttp } from "./http.js";
import { parseArgs, USAGE } from "./cli-args.js";
import { parseConnectInput, fetchSiteManifest } from "./connect-input.js";
import {
  resolveApproval,
  renderPreview,
  askOnTty,
  createApprovalLease,
  lifetimeFromEnv,
  readSavedGrant,
  writeSavedGrant,
  grantPath,
} from "./approval.js";
import {
  createAgentBridge,
  buildAgentActions,
  createRoomToolProvider,
} from "./bridge.js";

const TOOL_SCOPES = ["messages.send", "presence.read", "tools.invoke"];
const err = (text) => process.stderr.write(`${text}\n`);
const interactive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY);

async function resolveSite(args) {
  let raw = args.connect;
  if (raw?.startsWith("@")) raw = await readFile(raw.slice(1), "utf8");
  let site;
  if (raw) site = parseConnectInput(raw);
  else if (args.origin) site = parseConnectInput(args.origin);
  else
    throw new Error("Provide --connect (instruction or site URL) or --origin");
  if (site.discoveryOnly && !args.flags.has("no-manifest") && !args.caps) {
    try {
      // Preserve the manifest source and provisional flag from discovery. The
      // preview must not present a typeless fallback as a validated v1 doc.
      // Pass the exact public base URL (when present) so a project-subpath host
      // such as GitHub Pages /ai-auth/ is discovered explicitly, not guessed.
      site = await fetchSiteManifest(site.origin, {
        baseUrl: site.discoveryBaseUrl,
      });
    } catch (error) {
      throw new Error(
        `${error.message}. Pass --caps to name the scopes explicitly`,
      );
    }
  }
  const room = args.room ?? site.room ?? "default";
  const capabilities = args.caps ?? site.capabilities;
  return { ...site, room, capabilities: [...capabilities].sort() };
}

function requestedScopes(site) {
  const requested = TOOL_SCOPES.filter((cap) =>
    site.capabilities.includes(cap),
  );
  if (requested.length === 0)
    throw new Error(
      `The site requests none of the scopes this adapter can use (${TOOL_SCOPES.join(", ")})`,
    );
  return requested;
}

function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref?.();
  } catch {}
}

async function approveInBrowser({ site, asked, consentUrl, walletId }) {
  if (!consentUrl)
    throw new Error("--open-wallet needs --http for the consent callback");
  const request = await createPermissionRequest(site.origin, asked, {
    room: site.room,
  });
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
  const walletBase = site.walletUrl ?? new URL("/wallet/", site.origin).href;
  const walletUrl = new URL(walletBase);
  walletUrl.searchParams.set("connect", "1");
  walletUrl.searchParams.set("connect-request", encoded);
  walletUrl.searchParams.set("callback", consentUrl);
  err(`Open this wallet window to approve the connection:\n${walletUrl.href}`);
  openBrowser(walletUrl.href);

  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Wallet approval timed out")),
      5 * 60_000,
    );
    pendingConsent = (body) => {
      clearTimeout(timer);
      resolve(body);
    };
  });
  if (message?.type !== "ai-auth/connect-consent")
    throw new Error("The wallet sent an unexpected response");
  if (message.requestNonce !== request.nonce)
    throw new Error("The wallet approval does not match this request");
  const verified = await verifyPermissionConsent(message.consent, request, {
    expectedOrigin: site.origin,
    expectedWallet: walletId,
    nonceGuard: new NonceGuard(),
  });
  if (!verified) throw new Error("The wallet approval failed verification");
  const approved = message.consent.body.payload.capabilities.filter((cap) =>
    asked.includes(cap),
  );
  if (!approved.length) throw new Error("No requested capability was approved");
  return approved;
}

let pendingConsent = null;

/**
 * P0-04 bootstrap helpers. Importing a browser-generated identity is an
 * explicit, named action: it never happens inside `serve` and never silently
 * replaces an existing keystore. Only the public wallet id is ever printed;
 * the passphrase and the encrypted backup never reach logs, URLs or a clipboard.
 */
async function readInstallPackage(fromInstall) {
  if (typeof fromInstall !== "string" || !fromInstall.trim())
    throw new Error("--from-install needs the install package file");
  const file = path.resolve(
    fromInstall.startsWith("@") ? fromInstall.slice(1) : fromInstall,
  );
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the install package: ${error.message}`);
  }
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    throw new Error("The install package is not valid JSON");
  }
  if (
    !pkg ||
    pkg.format !== "ai-auth-agent-install" ||
    pkg.version !== 1 ||
    typeof pkg.walletId !== "string" ||
    !pkg.walletId
  )
    throw new Error("Not an AI Auth agent install package (v1)");
  return pkg;
}

async function importPassphrase() {
  const fromEnv = process.env.AI_AUTH_PASSPHRASE;
  if (fromEnv) return fromEnv;
  if (interactive()) return promptSecret("Recovery passphrase: ");
  throw new Error(
    "Importing needs the recovery passphrase: set AI_AUTH_PASSPHRASE or run at a TTY",
  );
}

async function bootstrapIdentity(args) {
  const keystore = createFileKeystore({ dir: args.keystoreDir });
  const existed = await keystore.exists();
  if (!args.fromInstall) {
    // Reuse is allowed, creation is not: a clean keystore needs an explicit
    // install package. This is what keeps `serve`/`setup` from minting keys.
    if (existed) return { action: "reused", id: null };
    throw new Error(
      "No keystore exists here; bootstrap needs --from-install <file> (nothing is created implicitly)",
    );
  }
  const pkg = await readInstallPackage(args.fromInstall);
  const passphrase = await importPassphrase();

  if (existed && !args.flags.has("replace")) {
    let existing;
    try {
      existing = await keystore.unlock();
    } catch (error) {
      throw new Error(
        `An identity already exists here and could not be read (${error.message}); pass --replace to archive it explicitly`,
      );
    }
    if (existing.id === pkg.walletId) {
      err(`Identity reused (no import, no replacement): ${existing.id}`);
      return { action: "reused", id: existing.id };
    }
    throw new Error(
      "A different identity already exists in this keystore; re-run with --replace to archive it explicitly",
    );
  }

  const result = await installAgentIdentity({
    dir: args.keystoreDir,
    installPackage: pkg,
    passphrase,
    replace: args.flags.has("replace") || existed,
  });
  if (existed) {
    // A new identity must never inherit the previous identity's saved
    // approvals or secret MCP endpoint: that would re-approve access without
    // consent. Clear them so the next serve requires fresh explicit approval.
    await Promise.all([
      rm(grantPath(args.keystoreDir), { force: true }),
      rm(path.join(args.keystoreDir, "runtime.json"), { force: true }),
      rm(path.join(args.keystoreDir, "http-secret"), { force: true }),
    ]);
    err(
      "Identity replaced. Saved grants and the local MCP endpoint secret were cleared; re-approve on the next serve.",
    );
  }
  err(`Identity imported for this agent: ${result.id}`);
  return { action: "imported", id: result.id };
}

async function serve(args) {
  const site = await resolveSite(args);
  const requested = requestedScopes(site);
  const keystore = createFileKeystore({ dir: args.keystoreDir });
  const wallet = await keystore.unlock();
  err(
    renderPreview({
      origin: site.origin,
      room: site.room,
      walletId: wallet.id,
      requested,
      source: site.source,
    }),
  );
  let bridge = null;
  let runtime = null;
  // Declared before makeServer: its approval callback reads this when the MCP
  // server is constructed. Creating it later was a temporal dead zone and made
  // --open-wallet fail before the consent endpoint existed.
  let http = null;
  // One agent runtime, however many MCP sessions connect (HTTP opens one per
  // client session). Approval runs once; later sessions reuse the grant.
  const makeServer = () =>
    createAIAuthMcpServer({
      wallet,
      name: "ai-auth",
      actions: buildAgentActions({
        getBridge: () => bridge,
        siteCapabilities: requested,
        codeMode: args.flags.has("code-mode"),
      }),
      approveCapabilities: async (asked) => {
        if (runtime) return [...runtime.capabilities];
        const requested = [...asked].sort();
        // A saved non-secret grant replaces approval on restart for the same
        // origin, room and requested scopes. An explicit --approve wins and
        // rewrites the snapshot when the request really changed.
        const saved =
          args.approve === null
            ? await readSavedGrant({
                dir: args.keystoreDir,
                origin: site.origin,
                room: site.room,
                requested,
              })
            : null;
        const lifetime = saved
          ? {
              sessionTtlMs: saved.sessionTtlMs,
              idleTimeoutMs: saved.idleTimeoutMs,
              approvedAt: saved.approvedAt,
            }
          : lifetimeFromEnv(process.env);
        const approved = saved
          ? [...saved.scopes]
          : args.flags.has("open-wallet") && http
            ? await approveInBrowser({
                site,
                asked,
                consentUrl: http.consentUrl,
                walletId: wallet.id,
              })
            : await resolveApproval({
                requested: asked,
                approve: args.approve,
                interactive: interactive(),
                ask: askOnTty(),
              });
        runtime = createAgentRuntime({
          keystore,
          origin: site.origin,
          room: site.room,
          capabilities: approved,
          descriptor: { name: args.name ?? "ai-auth-mcp" },
          authorization: createApprovalLease(lifetime),
        });
        const wantsRoomTools = (args.provide ?? []).includes("room");
        if (wantsRoomTools && !approved.includes("tools.invoke"))
          throw new Error(
            "--provide room needs tools.invoke; add it to --caps and --approve",
          );
        const provider = wantsRoomTools
          ? createRoomToolProvider(runtime)
          : null;
        bridge = createAgentBridge({
          runtime,
          providedTools: provider ? [...provider.tools] : [],
        });
        // HTTP mode approves on the first session, after serve() returned.
        if (pendingStart) {
          const start = pendingStart;
          pendingStart = null;
          start();
        }
        await writeSavedGrant({
          dir: args.keystoreDir,
          origin: site.origin,
          room: site.room,
          requested,
          granted: approved,
          ...lifetime,
        });
        return approved;
      },
    }).then(({ server }) => server);
  // In HTTP mode the MCP server must be built after the consent endpoint
  // exists: approveCapabilities runs during construction and --open-wallet
  // needs http.consentUrl. serveAIAuthMcpHttp calls createMcpServer on the
  // first session, so pass a lazy factory there instead of an eager server.
  let server = null;
  const shutdown = async () => {
    bridge?.close();
    await http?.close().catch(() => {});
    await runtime?.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (args.flags.has("open-wallet") && args.http === undefined)
    throw new Error("--open-wallet needs --http for the consent callback");
  if (args.http !== undefined) {
    const port = Number(args.http);
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
      throw new Error("--http needs a port number");
    let first = null;
    // The secret path is the credential. Keep it with the keystore so the same
    // agent keeps the same address across restarts (clients store the URL).
    const secretFile = path.join(args.keystoreDir, "http-secret");
    let secret = await readFile(secretFile, "utf8").then(
      (v) => v.trim(),
      () => null,
    );
    if (!secret || !/^[A-Za-z0-9_-]{24,}$/u.test(secret)) {
      secret = randomBytes(24).toString("base64url");
      await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
      await chmod(secretFile, 0o600);
    }
    http = await serveAIAuthMcpHttp({
      onConsent: (body) => {
        if (!pendingConsent) throw new Error("No wallet approval is pending");
        const resolve = pendingConsent;
        pendingConsent = null;
        return resolve(body);
      },
      port,
      secret,
      createMcpServer: () => {
        const ready = first;
        first = null;
        return ready ?? makeServer();
      },
    });
    // The runtime is approved on the first MCP session, not at startup.
    err(
      `ai-auth-mcp listening for ${site.origin} (HTTP MCP; approval completes on the first session)\nMCP endpoint: ${http.url}\nThe URL is the credential for this agent. Share it only with the client you connect.`,
    );
  } else {
    server = await makeServer();
    process.stdin.once("end", shutdown);
    await connectAIAuthMcpStdio(server);
    err(
      `ai-auth-mcp ready: ${runtime.capabilities.join(", ")} for ${site.origin} (stdio MCP; not a background service)`,
    );
  }
  const startRuntime = () => {
    const start = args.flags.has("resume")
      ? runtime.resume()
      : args.flags.has("auto-join")
        ? runtime.join()
        : null;
    start?.catch((error) => err(`auto-join failed: ${error.message}`));
  };
  if (runtime) startRuntime();
  else if (args.flags.has("resume") || args.flags.has("auto-join"))
    pendingStart = startRuntime;
}

let pendingStart = null;

async function unlink(args) {
  const yes = args.flags.has("yes") || (interactive() && (await askYes()));
  if (!yes)
    throw new Error(
      "Refusing to delete the identity without --yes or a TTY confirmation",
    );
  await createFileKeystore({ dir: args.keystoreDir }).delete();
  await rm(path.join(args.keystoreDir, "runtime.json"), { force: true });
  await rm(grantPath(args.keystoreDir), { force: true });
  await rm(path.join(args.keystoreDir, "http-secret"), { force: true });
  err(
    "Keystore removed. Remove the server from your harness config to stop it; revoke grants in the site's wallet UI.",
  );
}

function askYes() {
  return askOnTty()(["delete the agent identity — type yes"]).then(
    (a) => a.trim() === "yes",
  );
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.flags.has("help")) return err(USAGE);
  const keystore = createFileKeystore({ dir: args.keystoreDir });
  if (args.command === "init") {
    if (args.fromInstall) {
      const imported = await bootstrapIdentity(args);
      return process.stdout.write(`${imported.id}\n`);
    }
    const wallet = await keystore.create({ name: args.name ?? "ai-auth-mcp" });
    return process.stdout.write(`${wallet.id}\n`);
  }
  if (args.command === "setup") {
    await bootstrapIdentity(args);
    return serve(args);
  }
  if (args.command === "whoami")
    return process.stdout.write(`${(await keystore.unlock()).id}\n`);
  if (args.command === "unlink") return unlink(args);
  if (args.command === "preview") {
    const site = await resolveSite(args);
    const wallet = await keystore.unlock();
    return err(
      renderPreview({
        origin: site.origin,
        room: site.room,
        walletId: wallet.id,
        requested: requestedScopes(site),
        source: site.source,
      }),
    );
  }
  return serve(args);
}

main(process.argv.slice(2)).catch((error) => {
  err(`ai-auth-mcp: ${error.message}`);
  if (/Unknown|Unexpected|needs a value/u.test(error.message)) err(USAGE);
  process.exit(error.name === "ApprovalError" ? 3 : 1);
});
