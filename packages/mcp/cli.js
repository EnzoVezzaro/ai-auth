#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  createFileKeystore,
  createAgentRuntime,
} from "@enzovezzaro/ai-auth-agent";
import { createAIAuthMcpServer, connectAIAuthMcpStdio } from "./index.js";
import { serveAIAuthMcpHttp } from "./http.js";
import { parseArgs, USAGE } from "./cli-args.js";
import { parseConnectInput, fetchSiteManifest } from "./connect-input.js";
import { resolveApproval, renderPreview, askOnTty } from "./approval.js";
import { createAgentBridge, buildAgentActions } from "./bridge.js";

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
      site = { ...(await fetchSiteManifest(site.origin)), source: "manifest" };
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
  // One agent runtime, however many MCP sessions connect (HTTP opens one per
  // client session). Approval runs once; later sessions reuse the grant.
  const makeServer = () =>
    createAIAuthMcpServer({
      wallet,
      name: "ai-auth",
      actions: buildAgentActions({
        getBridge: () => bridge,
        siteCapabilities: requested,
      }),
      approveCapabilities: async (asked) => {
        if (runtime) return [...runtime.capabilities];
        const approved = await resolveApproval({
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
        });
        bridge = createAgentBridge({ runtime });
        return approved;
      },
    }).then(({ server }) => server);
  const server = await makeServer();
  const shutdown = async () => {
    bridge?.close();
    await runtime?.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (args.http !== undefined) {
    const port = Number(args.http);
    if (!Number.isInteger(port) || port < 0 || port > 65_535)
      throw new Error("--http needs a port number");
    let first = server;
    const http = await serveAIAuthMcpHttp({
      port,
      createMcpServer: () => {
        const ready = first;
        first = null;
        return ready ?? makeServer();
      },
    });
    err(
      `ai-auth-mcp ready: ${runtime.capabilities.join(", ")} for ${site.origin} (HTTP MCP; runs until stopped)\nMCP endpoint: ${http.url}\nThe URL is the credential for this agent. Share it only with the client you connect.`,
    );
  } else {
    process.stdin.once("end", shutdown);
    await connectAIAuthMcpStdio(server);
    err(
      `ai-auth-mcp ready: ${runtime.capabilities.join(", ")} for ${site.origin} (stdio MCP; not a background service)`,
    );
  }
  const start = args.flags.has("resume")
    ? runtime.resume()
    : args.flags.has("auto-join")
      ? runtime.join()
      : null;
  start?.catch((error) => err(`auto-join failed: ${error.message}`));
}

async function unlink(args) {
  const yes = args.flags.has("yes") || (interactive() && (await askYes()));
  if (!yes)
    throw new Error(
      "Refusing to delete the identity without --yes or a TTY confirmation",
    );
  await createFileKeystore({ dir: args.keystoreDir }).delete();
  await rm(path.join(args.keystoreDir, "runtime.json"), { force: true });
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
    const wallet = await keystore.create({ name: args.name ?? "ai-auth-mcp" });
    return process.stdout.write(`${wallet.id}\n`);
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
