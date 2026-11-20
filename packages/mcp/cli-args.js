import os from "node:os";
import path from "node:path";

const COMMANDS = new Set(["serve", "init", "whoami", "preview", "unlink"]);
const VALUE_FLAGS = new Set([
  "keystore-dir",
  "connect",
  "origin",
  "room",
  "caps",
  "approve",
  "name",
  "http",
  "provide",
]);
const BOOL_FLAGS = new Set([
  "auto-join",
  "resume",
  "code-mode",
  "no-manifest",
  "yes",
  "help",
  "open-wallet",
]);

const list = (value) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function parseArgs(argv) {
  const out = {
    command: "serve",
    approve: null,
    caps: null,
    flags: new Set(),
    keystoreDir: path.join(os.homedir(), ".ai-auth", "agent"),
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) {
    const command = args.shift();
    if (!COMMANDS.has(command)) throw new Error(`Unknown command "${command}"`);
    out.command = command;
  }
  while (args.length) {
    const arg = args.shift();
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}"`);
    const [flag, inline] = arg.slice(2).split(/=(.*)/su, 2);
    if (BOOL_FLAGS.has(flag)) out.flags.add(flag);
    else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? args.shift();
      if (value === undefined || value.startsWith("--"))
        throw new Error(`--${flag} needs a value`);
      if (flag === "keystore-dir") out.keystoreDir = path.resolve(value);
      else if (flag === "approve")
        out.approve = [...(out.approve ?? []), ...list(value)];
      else if (flag === "caps") out.caps = list(value);
      else if (flag === "provide") out.provide = list(value);
      else out[flag] = value;
    } else throw new Error(`Unknown option --${flag}`);
  }
  return out;
}

export const USAGE = `ai-auth-mcp [serve|init|whoami|preview|unlink] [options]
  --keystore-dir DIR   encrypted identity (default ~/.ai-auth/agent); passphrase from AI_AUTH_PASSPHRASE or a TTY prompt
  --connect INPUT      connect instruction, its JSON, a site URL, or @file
  --origin URL --room NAME --caps a,b   explicit alternative to --connect
  --approve a,b        exact scopes to grant without a TTY (never more than the site requested)
  --auto-join | --resume   join the room at startup / restore the last room
  --code-mode          expose ai_auth_code: a sandboxed script tool that calls
                       the connection-checked aiAuth API (Cloudflare Code Mode)
  --provide room       publish the built-in read-only room tools (agent.ping,
                       agent.self) so peers can call this agent with no page open;
                       needs tools.invoke and is off unless you opt in
  --no-manifest        do not fetch /.well-known/ai-auth.json for a URL
  --yes                confirm unlink without a prompt
  --http PORT          serve MCP over Streamable HTTP on 127.0.0.1:PORT (0 picks a free port) instead of stdio;
                       the printed URL contains a secret and is the credential for this agent
  --open-wallet        when approval is needed, open the wallet in a browser and wait for its
                       signed consent on the local HTTP callback; needs --http
`;
