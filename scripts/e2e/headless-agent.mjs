// Child process: a real headless Node agent (packages/agent) for the E2E.
// It is driven over IPC by the harness and talks to the room over real Nostr
// signaling and real WebRTC (node-datachannel). The keystore lives in a temp
// dir passed by the parent; AI_AUTH_PASSPHRASE unlocks it.
import {
  createAgentRuntime,
  createFileKeystore,
} from "../../packages/agent/index.js";
import { createParticipationPolicy } from "../../packages/p2p/index.js";

const { dir, origin, room, name, issuer } = JSON.parse(process.env.B4A_AGENT);
const keystore = createFileKeystore({ dir });
const log = { events: [], states: [] };
let runtime;

async function prepare() {
  if (!(await keystore.exists())) await keystore.create({ name });
  const wallet = await keystore.unlock();
  return { id: wallet.id, instanceId: wallet.instanceId };
}

async function join(membership) {
  runtime = createAgentRuntime({
    keystore,
    origin,
    room,
    capabilities: ["presence.read", "messages.send"],
    descriptor: { name },
    participation: {
      policy: createParticipationPolicy({
        mode: "restricted",
        trustPolicy: { issuers: [issuer] },
        origin,
        room,
      }),
      membership,
    },
  });
  runtime.onConnectionState((s) =>
    log.states.push({ status: s.status, directPeerCount: s.directPeerCount }),
  );
  runtime.onEvent(({ direction, envelope }) => {
    if (direction !== "in" || !envelope) return;
    const { type, issuer: from, payload } = envelope.body;
    log.events.push({
      type,
      issuer: from,
      text: payload.text,
      session: payload.session,
    });
    if (log.events.length > 500) log.events.shift();
  });
  await runtime.join();
  return { id: runtime.identity.id };
}

const handlers = {
  prepare,
  join: ({ membership }) => join(membership),
  state: () => ({
    status: runtime?.connectionState.status ?? "idle",
    directPeerCount: runtime?.connectionState.directPeerCount ?? 0,
    peers: runtime?.peers().map((p) => p.id) ?? [],
    events: log.events,
    states: log.states,
  }),
  send: async ({ type, payload, to }) => {
    await runtime.send(type, payload, to ? { to } : {});
    return { sent: true };
  },
  close: async () => {
    await runtime?.close();
    return { closed: true };
  },
};

process.on("message", async ({ id, cmd, args }) => {
  try {
    process.send({ id, ok: true, result: await handlers[cmd](args ?? {}) });
  } catch (error) {
    process.send({ id, ok: false, error: String(error?.message ?? error) });
  }
});
process.send({ ready: true });
