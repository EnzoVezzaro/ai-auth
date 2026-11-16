// A headless agent that publishes tools from its own runtime. No browser,
// visitor, or site is involved: this process is the tool provider.
// usage: AI_AUTH_PASSPHRASE=... node examples/tool-peer.mjs <keystoreDir> <room> <name> [seconds]
import { createFileKeystore, createAgentRuntime } from "../index.js";

const [dir, room, name, seconds = "30"] = process.argv.slice(2);
const origin = process.env.AI_AUTH_ORIGIN ?? "https://agent-demo.example";
const log = (event, data = {}) =>
  console.log(JSON.stringify({ name, event, ...data }));

const keystore = createFileKeystore({ dir });
if (!(await keystore.exists())) await keystore.create({ name });
const runtime = createAgentRuntime({
  keystore,
  origin,
  room,
  capabilities: ["presence.read", "tools.invoke"],
  descriptor: { name },
});
runtime.onError((e) => log("error", { message: e.message }));

await runtime.join();
log("joined", { id: runtime.identity.id });
const provider = runtime.provideTools({
  tools: [
    {
      name: "room.echo",
      description:
        "Returns the text it receives, prefixed with the agent name.",
      inputSchema: { text: { type: "string" } },
      handler: ({ text }) => ({ echo: String(text).slice(0, 200), by: name }),
    },
    {
      name: "room.secret",
      description: "Only the owner may run this tool.",
      inputSchema: {},
      handler: () => ({ secret: "owner-only" }),
    },
  ],
  authorize: (requester, toolName) => toolName !== "room.secret",
});
log("providing", { tools: provider.tools });
setTimeout(
  async () => {
    provider.close();
    await runtime.close();
    log("closed");
    process.exit(0);
  },
  Number(seconds) * 1000,
);
