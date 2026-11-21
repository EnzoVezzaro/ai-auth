// A headless agent that runs an identity installed from a site.
// usage: AI_AUTH_PASSPHRASE=... node installed-peer.mjs <dir> <origin> <room> <name> [seconds]
// The site owner's grant arrives signed inside the pairing challenge; the
// responder verifies it locally and forwards only the verified authorization
// claim. The owner's private key never reaches this process.
import { createFileKeystore, createAgentRuntime } from "../index.js";
import { createPairingResponder } from "../pairing.js";
import { signingIdentityFor } from "../keystore.js";

const [dir, origin, room, name, seconds = "30"] = process.argv.slice(2);
const log = (event, data = {}) =>
  process.stdout.write(`${JSON.stringify({ event, name, ...data })}\n`);

// Optional harness seam: a pre-approved, owner-signed grant can be supplied
// explicitly. It is still verified against the challenge by the responder.
const granted = process.env.AI_AUTH_GRANT_JSON
  ? JSON.parse(process.env.AI_AUTH_GRANT_JSON)
  : null;
const capabilities = ["presence.read", "messages.send", "tools.invoke"];

const keystore = createFileKeystore({ dir });
const wallet = await keystore.unlock();
const runtime = createAgentRuntime({
  keystore,
  origin,
  room,
  capabilities,
  descriptor: { name },
});
const responder = createPairingResponder({
  wallet: signingIdentityFor(wallet),
  instanceId: wallet.instanceId,
  origin,
  room,
  siteRoom: runtime.agentRoom,
  capabilities,
  grant: granted,
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
    responder.close();
    await runtime.close();
    process.exit(0);
  },
  Number(seconds) * 1000,
);
