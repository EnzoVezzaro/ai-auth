// P0-04 (clean machine): the command the connect page hands to an agent must
// be one the CLI actually accepts, and the page must not claim `serve` mints
// an identity. Read the real page source so this test drifts with the copy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../packages/mcp/cli-args.js";

const appFile = fileURLToPath(
  new URL("../../apps/connect-agent/app.js", import.meta.url),
);

// Extract one named command template from the page source, neutralise the
// `${...}` interpolations and `\\\n` continuations, and split it into argv.
function commandArgs(source, name) {
  const match = source.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  assert.ok(match, `${name} template is present in the connect page`);
  const flat = match[1]
    .replace(/\\[ \t]*(?:\r?\n)[ \t]*/gu, " ")
    .replace(/\$\{[^}]+\}/gu, "VALUE");
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  let m;
  while ((m = re.exec(flat))) tokens.push(m[1] ?? m[2] ?? m[3]);
  const pkg = tokens.indexOf("@enzovezzaro/ai-auth-mcp");
  assert.ok(pkg >= 0, `${name} invokes the published MCP package`);
  const argv = tokens.slice(pkg + 1);
  assert.ok(argv.length > 0, `${name} has CLI arguments`);
  return { argv, flat };
}

test("connect page init command is accepted by the CLI parser", async () => {
  const source = await readFile(appFile, "utf8");
  const { argv } = commandArgs(source, "initCommand");
  const args = parseArgs(argv);
  assert.equal(args.command, "init");
  assert.ok(args.flags.has("new-identity"), "--new-identity is set");
  assert.match(args.keystoreDir, /\.ai-auth\/agent$/u);
});

test("connect page serve command is accepted by the CLI parser and options align", async () => {
  const source = await readFile(appFile, "utf8");
  const { argv } = commandArgs(source, "serveCommand");
  const args = parseArgs(argv);
  assert.equal(args.command, "serve");
  assert.equal(args.http, "0", "--http 0");
  assert.ok(
    !args.flags.has("open-wallet"),
    "the page never sends the agent to a wallet chosen by the site",
  );
  assert.ok(args.flags.has("auto-join"), "--auto-join is set");
  assert.ok(args.connect, "--connect is set");
  assert.equal(args.room, "VALUE", "--room is set");
  assert.match(args.keystoreDir, /\.ai-auth\/agent$/u, "same keystore as init");

  // Both commands target the same keystore so the identity created by init is
  // the one serve unlocks.
  const { argv: initArgv } = commandArgs(source, "initCommand");
  assert.equal(parseArgs(initArgv).keystoreDir, args.keystoreDir);
});

test("connect page copy points at the explicit setup path, not implicit creation by serve", async () => {
  const source = await readFile(appFile, "utf8");
  assert.match(source, /init --new-identity/u);
  assert.doesNotMatch(
    source,
    /agent creates and stores its own identity/u,
    "serve is not described as creating an identity",
  );
});
