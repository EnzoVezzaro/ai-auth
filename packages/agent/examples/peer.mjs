// A headless AI Auth agent peer. Real Nostr signaling + real WebRTC.
// usage: AI_AUTH_PASSPHRASE=... node examples/peer.mjs <keystoreDir> <room> <name> [seconds]
import { createFileKeystore, createAgentRuntime } from "../index.js";

const [dir, room, name, seconds = "30"] = process.argv.slice(2);
const origin = process.env.AI_AUTH_ORIGIN ?? "https://agent-demo.example";
const t0 = Date.now();
const log = (event, data = {}) =>
  console.log(JSON.stringify({ t: Date.now() - t0, name, event, ...data }));

const keystore = createFileKeystore({ dir });
if (!(await keystore.exists())) await keystore.create({ name });
const runtime = createAgentRuntime({
  keystore,
  origin,
  room,
  capabilities: ["presence.read", "messages.send"],
  descriptor: { name },
});
runtime.onConnectionState((s) =>
  log("state", { status: s.status, peers: s.directPeerCount }),
);
runtime.onError((e) => log("error", { message: e.message }));
let sent = false;
runtime.onEvent(({ direction, envelope }) => {
  if (direction === "in" && envelope.body.type === "message/text")
    log("received", {
      from: envelope.body.issuer,
      text: envelope.body.payload.text,
    });
});
runtime.onConnectionState(async (s) => {
  if (s.status === "direct-peer-connected" && !sent) {
    sent = true;
    await runtime.send("message/text", { text: `hello from ${name}` });
    log("sent");
  }
});
await runtime.join();
log("joined", { id: runtime.identity.id });
setTimeout(
  async () => {
    await runtime.close();
    log("closed");
    process.exit(0);
  },
  Number(seconds) * 1000,
);
