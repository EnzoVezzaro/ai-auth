import os from "node:os";
import path from "node:path";

const COMMANDS = new Set([
  "serve",
  "init",
  "setup",
  "whoami",
  "preview",
  "unlink",
]);
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
  "from-install",
  "wallet-url",
]);
const BOOL_FLAGS = new Set([
  "auto-join",
  "resume",
  "code-mode",
  "no-manifest",
  "yes",
  "help",
  "open-wallet",
  "replace",
  "new-identity",
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
      else if (flag === "from-install") out.fromInstall = value;
      else if (flag === "approve")
        out.approve = [...(out.approve ?? []), ...list(value)];
      else if (flag === "caps") out.caps = list(value);
      else if (flag === "provide") out.provide = list(value);
      else out[flag] = value;
    } else throw new Error(`Unknown option --${flag}`);
  }
  return out;
}

export const USAGE = `ai-auth-mcp [serve|init|setup|whoami|preview|unlink] [options]
  --keystore-dir DIR   encrypted identity (default ~/.ai-auth/agent); passphrase from AI_AUTH_PASSPHRASE or a TTY prompt
  --connect INPUT      a site's one-time AI Auth connect link, a connect instruction, its JSON,
                       a public connect descriptor, a site URL, or @file. A link connects at
                       startup; the site then remembers this agent and later runs of "serve"
                       (with no --connect) reconnect to the last linked site automatically
  --origin URL --room NAME --caps a,b   explicit alternative to --connect
  --approve a,b        exact scopes to grant without a TTY (never more than the site requested)
  --from-install FILE  install package from the site (JSON, or @FILE for its path); init/setup only.
                       Imports the generated identity with an explicit passphrase (AI_AUTH_PASSPHRASE
                       or TTY). Nothing is created or replaced implicitly.
  --replace            archive an existing identity before importing a *different* one (init/setup only).
                       Never done automatically; clearing saved grants, runtime state and the MCP endpoint secret follows.
  --new-identity       opt in to creating a fresh local identity (init only; clean directory).
                       Uses AI_AUTH_PASSPHRASE or a TTY prompt. Never overwrites an existing
                       keystore unless --replace is also passed, which archives the old identity
                       and clears its saved grants, runtime state and MCP endpoint secret.
                       "serve" never creates an identity: run "init --new-identity" first.
  setup                bootstrap then serve: reuse an existing keystore, otherwise import --from-install,
                       then run the same MCP bridge as "serve" (all serve options apply)
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
  --open-wallet        when approval is needed, open YOUR wallet page (--wallet-url) in a browser
                       and wait for its signed consent on the local HTTP callback; needs --http.
                       A wallet URL named by the site is never opened
  --wallet-url URL     your own wallet page for --open-wallet
`;
