// A headless agent that runs an identity installed from a site.
// usage: AI_AUTH_PASSPHRASE=... node installed-peer.mjs <dir> <origin> <room> <name> [seconds]
import { createFileKeystore, createAgentRuntime } from "../index.js";

const [dir, origin, room, name, seconds = "30"] = process.argv.slice(2);
const log = (event, data = {}) =>
  process.stdout.write(`${JSON.stringify({ event, name, ...data })}\n`);

const keystore = createFileKeystore({ dir });
const wallet = await keystore.unlock();
const runtime = createAgentRuntime({
  keystore,
  origin,
  room,
  capabilities: ["presence.read", "messages.send", "tools.invoke"],
  descriptor: { name },
});
let sent = false;
runtime.onConnectionState(async (state) => {
  if (state.status === "direct-peer-connected" && !sent) {
    sent = true;
    await runtime.send("message/text", {
      text: `hello from ${name}`,
      messageId: crypto.randomUUID(),
    });
    log("sent");
  }
});
await runtime.join();
log("joined", { id: wallet.id, instanceId: wallet.instanceId });
setTimeout(
  async () => {
    await runtime.close();
    process.exit(0);
  },
  Number(seconds) * 1000,
);
