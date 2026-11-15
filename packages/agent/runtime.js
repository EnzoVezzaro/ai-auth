import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { joinRoom as trysteroJoinRoom } from "@trystero-p2p/nostr";
import {
  NostrWebRTC,
  P2PRoom,
  createConnectionState,
} from "@enzovezzaro/ai-auth-wallet";
import { signingIdentityFor } from "./keystore.js";
import { withNodeRtc } from "./rtc.js";

const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;
const STATE_FILE = "runtime.json";
const DEFAULT_BACKOFF = Object.freeze({
  baseMs: 1_000,
  maxMs: 30_000,
  maxAttempts: 8,
});

function validateOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError("origin must be an exact HTTP(S) origin");
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    url.origin !== origin ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local))
  )
    throw new TypeError(
      "origin must be an exact HTTPS origin (HTTP only for localhost)",
    );
  return origin;
}

function validateCapabilities(values) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((v) => typeof v !== "string" || !CAPABILITY_PATTERN.test(v))
  )
    throw new TypeError(
      "capabilities must be a non-empty list of unique explicit names (no wildcards)",
    );
  return Object.freeze([...values].sort());
}

function validateDescriptor(descriptor) {
  if (descriptor === undefined) return Object.freeze({});
  const plain =
    descriptor !== null &&
    typeof descriptor === "object" &&
    !Array.isArray(descriptor);
  if (
    !plain ||
    JSON.stringify(descriptor).length > 512 ||
    (descriptor.name !== undefined &&
      (typeof descriptor.name !== "string" || descriptor.name.length > 60))
  )
    throw new TypeError(
      "descriptor must be a small object with an optional name of at most 60 characters",
    );
  return Object.freeze(structuredClone(descriptor));
}

function validateRoom(room) {
  if (typeof room !== "string" || !ROOM_PATTERN.test(room))
    throw new TypeError("room must be 1–100 safe characters");
  return room;
}

/**
 * Headless AI Auth agent: one keystore identity joining one signed room over
 * direct WebRTC (Nostr only signals). The wire format is the SDK's own
 * P2PRoom/NostrWebRTC; this module adds lifecycle, leases and reconnection.
 */
export function createAgentRuntime(options = {}) {
  const { keystore, origin, capabilities, descriptor } = options;
  if (
    !keystore ||
    typeof keystore.unlock !== "function" ||
    typeof keystore.dir !== "string"
  )
    throw new TypeError("A file keystore is required");
  const site = validateOrigin(origin);
  const caps = validateCapabilities(capabilities);
  const meta = validateDescriptor(descriptor);
  const configuredRoom =
    options.room === undefined ? undefined : validateRoom(options.room);
  const backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 24_000;
  const rejoinAfterMs = options.rejoinAfterMs ?? 120_000;
  const delay = options.delay ?? ((ms) => sleep(ms));
  const random = options.random ?? Math.random;
  const stateFile =
    options.stateFile === undefined
      ? path.join(keystore.dir, STATE_FILE)
      : options.stateFile;
  const joinRoom = withNodeRtc(options.joinRoom ?? trysteroJoinRoom);

  const state = createConnectionState({ now });
  const listeners = { event: new Set(), error: new Set(), stale: new Set() };
  const registry = new Map();
  let wallet = null;
  let core = null;
  let net = null;
  let stopMirror = null;
  let stopCore = null;
  let currentRoom = null;
  let closed = false;
  let pending = null;
  let noPeerSince = null;
  let timer = null;

  const emit = (set, value) => {
    for (const fn of [...set]) {
      try {
        fn(value);
      } catch {
        // A failing subscriber must not break the runtime.
      }
    }
  };
  const subscribe = (set) => (fn) => {
    if (typeof fn !== "function")
      throw new TypeError("listener must be a function");
    set.add(fn);
    return () => set.delete(fn);
  };

  function mirror(snapshot) {
    // Peers first: adding one enters direct-peer-connected with a true count.
    const have = new Set(state.snapshot.peers.map((p) => p.peerId));
    const want = new Set(snapshot.peers.map((p) => p.peerId));
    for (const peer of snapshot.peers)
      if (!have.has(peer.peerId)) state.addPeer(peer);
    for (const id of have) if (!want.has(id)) state.removePeer(id);
    state.tryTransition(snapshot.status);
    const waiting =
      snapshot.directPeerCount === 0 &&
      ["signaling", "waiting-for-peers"].includes(snapshot.status);
    noPeerSince = waiting ? (noPeerSince ?? now()) : null;
  }

  function observe(message) {
    if (message.direction === "in" && message.envelope) {
      const { type, issuer } = message.envelope.body;
      if (type === "peer/goodbye") registry.delete(issuer);
      else if (message.peer && issuer !== wallet?.id)
        registry.set(issuer, {
          id: issuer,
          name: message.peer.name,
          session: message.peer.session,
          seenAt: now(),
          flagged: false,
        });
    }
    emit(listeners.event, message);
  }

  async function teardown({ goodbye }) {
    stopMirror?.();
    stopCore?.();
    stopMirror = stopCore = null;
    const [oldCore, oldNet] = [core, net];
    core = net = null;
    registry.clear();
    if (goodbye) await oldCore?.close().catch(() => {});
    else if (oldCore) oldCore.closed = true;
    await oldNet?.close().catch(() => {});
    if (!goodbye) await oldCore?.close().catch(() => {});
  }

  async function startOnce(room) {
    const signer = signingIdentityFor(wallet);
    const roomWallet = Object.freeze({
      ...signer,
      name: meta.name ?? wallet.name,
      sign: wallet.sign,
    });
    core = new P2PRoom(roomWallet, room, {
      origin: site,
      capabilities: [...caps],
      participation: options.participation ?? null,
    });
    net = new NostrWebRTC(core, {
      origin: site,
      room,
      relayUrls: options.relayUrls,
      joinRoom,
      onStatus: options.onStatus,
    });
    stopMirror = net.onConnectionState(mirror);
    stopCore = core.subscribe(observe);
    await net.start();
    mirror(net.connectionState);
  }

  async function connect(room) {
    for (let attempt = 1; attempt <= backoff.maxAttempts; attempt += 1) {
      try {
        await startOnce(room);
        return;
      } catch (error) {
        await teardown({ goodbye: false });
        if (closed) throw new Error("The agent runtime is closed");
        state.tryTransition("degraded");
        if (attempt === backoff.maxAttempts) {
          state.tryTransition("disconnected");
          const failure = new Error(
            `Could not join the room after ${attempt} attempts`,
            { cause: error },
          );
          emit(listeners.error, failure);
          throw failure;
        }
        const base = Math.min(
          backoff.maxMs,
          backoff.baseMs * 2 ** (attempt - 1),
        );
        await delay(Math.round(base * (0.8 + 0.4 * random())));
      }
    }
  }

  async function persist(room) {
    if (!stateFile) return;
    await writeFile(
      stateFile,
      JSON.stringify({
        v: 1,
        origin: site,
        room,
        joinedAt: new Date(now()).toISOString(),
      }),
      { mode: 0o600 },
    );
    await chmod(stateFile, 0o600);
  }

  async function join(roomArg) {
    if (closed) throw new Error("The agent runtime is closed");
    if (pending) return pending;
    pending = (async () => {
      const room = validateRoom(
        roomArg ?? currentRoom ?? configuredRoom ?? "default",
      );
      if (core) await teardown({ goodbye: true });
      wallet ??= await keystore.unlock();
      if (["disconnected", "expired"].includes(state.snapshot.status))
        state.transition("idle");
      state.tryTransition("wallet-authorized");
      currentRoom = room;
      await connect(room);
      await persist(room);
      timer ??= setInterval(
        () => void api.checkLeases().catch(() => {}),
        Math.max(1_000, Math.min(leaseMs / 3, 5_000)),
      );
      timer.unref?.();
      return api.connectionState;
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function stop({ forget, final }) {
    clearInterval(timer);
    timer = null;
    await teardown({ goodbye: true });
    state.tryTransition("disconnected");
    if (forget && stateFile) await rm(stateFile, { force: true });
    if (final) closed = true;
  }

  async function checkLeases() {
    const t = now();
    for (const [id, peer] of registry) {
      if (t > peer.seenAt + leaseMs && !peer.flagged) {
        peer.flagged = true;
        emit(listeners.stale, {
          id,
          name: peer.name,
          session: peer.session,
          seenAt: peer.seenAt,
          leaseExpiresAt: peer.seenAt + leaseMs,
        });
      } else if (t > peer.seenAt + 2 * leaseMs) registry.delete(id);
    }
    if (
      core &&
      !pending &&
      noPeerSince !== null &&
      t - noPeerSince > rejoinAfterMs
    ) {
      noPeerSince = null;
      state.tryTransition("degraded");
      await join(currentRoom);
    }
  }

  const api = {
    get connectionState() {
      return state.snapshot;
    },
    get identity() {
      return wallet;
    },
    get room() {
      return currentRoom;
    },
    capabilities: caps,
    descriptor: meta,
    origin: site,
    onConnectionState: (fn) => state.subscribe(fn),
    onEvent: subscribe(listeners.event),
    onError: subscribe(listeners.error),
    onPeerStale: subscribe(listeners.stale),
    join,
    async resume() {
      if (!stateFile) return false;
      let saved;
      try {
        saved = JSON.parse(await readFile(stateFile, "utf8"));
      } catch {
        return false;
      }
      if (
        saved?.v !== 1 ||
        saved.origin !== site ||
        !ROOM_PATTERN.test(saved.room ?? "")
      )
        return false;
      await join(saved.room);
      return true;
    },
    peers() {
      const t = now();
      return [...registry.values()].map(({ id, name, session, seenAt }) =>
        Object.freeze({
          id,
          name,
          session,
          seenAt,
          leaseExpiresAt: seenAt + leaseMs,
          stale: t > seenAt + leaseMs,
        }),
      );
    },
    async send(type, payload = {}, sendOptions = {}) {
      if (!core || core.closed) throw new Error("Join a room before sending");
      return core.send(type, payload, sendOptions);
    },
    checkLeases,
    leave: () => stop({ forget: true, final: false }),
    close: () =>
      closed ? Promise.resolve() : stop({ forget: false, final: true }),
  };
  return Object.freeze(api);
}
