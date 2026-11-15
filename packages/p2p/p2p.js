import {
  MAX_EVENT_AGE_MS,
  MAX_SEEN_EVENTS,
  randomNonce,
  signEnvelope,
  verifyEnvelope,
} from "./index.js";

const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const INBOUND_WINDOW_MS = 10_000;
const MAX_INBOUND_EVENTS_PER_SOURCE_WINDOW = 32;
const MAX_INBOUND_EVENTS_PER_PEER_WINDOW = 8;
const MAX_INBOUND_EVENTS_PER_IDENTITY_WINDOW = 32;
const MAX_INBOUND_EVENTS_PER_ROOM_WINDOW = 256;
const MAX_ATTACHED_PEERS = 16;
const MAX_CHANNELS_PER_PEER = 4;
const TRYSTERO_APP_ID = "ai-auth-wallet-v1";
const TRYSTERO_ACTION = "ai-auth-signed-v1";
const MAX_TRYSTERO_EVENT_BYTES = 64_000;
const MAX_QUEUED_OUTBOUND_EVENTS = 128;
const PRESENCE_ONLY_TYPES = new Set([
  "peer/hello",
  "peer/heartbeat",
  "peer/goodbye",
]);
const MAX_MEMBERSHIP_WIRE_CHARS = 4096;
const EVENT_CAPABILITY = new Map([
  ["peer/hello", "presence.read"],
  ["peer/heartbeat", "presence.read"],
  ["peer/goodbye", "presence.read"],
  ["presence/cursor", "presence.read"],
  ["message/text", "messages.send"],
  ["collab/text", "messages.send"],
  ["collab/element", "content.share"],
  ["collab/attachment", "content.share"],
  ["agent/action", "tools.invoke"],
  ["agent/task", "tasks.delegate"],
]);

export async function createSharedRoomTopic(origin, room) {
  if (typeof origin !== "string" || typeof room !== "string")
    throw new TypeError("A site origin and shared room name are required");
  if (!ROOM_PATTERN.test(room))
    throw new TypeError("Room names must be 1–100 safe characters");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${TRYSTERO_APP_ID}\n${origin}\n${room}`),
  );
  return `ai-auth-v1-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class P2PRoom {
  constructor(
    wallet,
    room,
    {
      privateMode = false,
      origin = globalThis.location?.origin ?? "",
      capabilities = null,
      participation = null,
    } = {},
  ) {
    if (!ROOM_PATTERN.test(room))
      throw new Error("Room names must be 1–100 safe characters");
    const policy = participation?.policy ?? null;
    if (policy && (policy.room !== room || policy.origin !== origin))
      throw new Error("Participation policy must match this origin and room");
    this.policy = policy;
    this.membership = participation?.membership ?? null;
    this.participationMode = policy?.mode ?? "open";
    this.disclosure = policy?.disclosure ?? null;
    this.sourceWallets = new WeakMap();
    this.wallet = wallet;
    this.room = room;
    this.origin = origin;
    this.privateMode = privateMode;
    this.capabilities = capabilities === null ? null : new Set(capabilities);
    this.session = crypto.randomUUID();
    this.peers = new Map();
    this.seen = new Map();
    this.inboundWindows = new WeakMap();
    this.inboundIssuerWindows = new Map();
    this.inboundRoomWindow = null;
    this.peerChannels = new Map();
    this.channelSources = new Map();
    this.peerConnectionWindow = null;
    this.localInboundSource = {};
    this.listeners = new Set();
    this.channels = new Set();
    this.directPeerCount = 0;
    this.closed = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get restricted() {
    return this.participationMode === "restricted";
  }

  // Whether a transport source has presented a still-valid member identity.
  // Open rooms deliver to everyone, exactly as before.
  isMemberSource(source, to = null) {
    if (!this.restricted) return true;
    const key = this.channelSources.get(source) ?? source;
    for (const wallet of this.sourceWallets.get(key) ?? [])
      if ((!to || wallet === to) && this.policy.isMember(wallet)) return true;
    return false;
  }

  mayDeliver(source, type, to) {
    if (!this.restricted) return true;
    if (to) return this.isMemberSource(source, to);
    return PRESENCE_ONLY_TYPES.has(type) || this.isMemberSource(source);
  }

  // Restricted rooms drop everything from wallets without a valid proof.
  async admitInbound(envelope, source) {
    const { type, issuer } = envelope.body;
    const proof = envelope.body.payload.membership;
    if (
      proof !== undefined &&
      (type === "peer/hello" || type === "peer/heartbeat") &&
      JSON.stringify(proof ?? null).length <= MAX_MEMBERSHIP_WIRE_CHARS
    ) {
      const admitted = await this.policy.admit(issuer, proof);
      if (admitted.ok) {
        const key = this.channelSources.get(source) ?? source;
        const wallets = this.sourceWallets.get(key) ?? new Set();
        if (wallets.size < 8) wallets.add(issuer);
        this.sourceWallets.set(key, wallets);
      }
    }
    if (!this.policy.isMember(issuer)) return false;
    const capability = EVENT_CAPABILITY.get(type);
    return !capability || this.policy.can(issuer, capability);
  }

  hasDirectPeer() {
    return (
      this.directPeerCount > 0 ||
      [...this.channels].some((channel) => channel.readyState === "open")
    );
  }

  notify(message) {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.error("Wallet event listener failed", error);
      }
    }
  }

  async start() {
    if (this.privateMode || this.closed) return this;
    this.broadcast = new BroadcastChannel(
      `ai-auth:${this.origin}:${this.room}`,
    );
    this.broadcast.onmessage = ({ data }) => {
      void this.receive(data, this.broadcast);
    };
    if (!this.capabilities || this.capabilities.has("presence.read")) {
      await this.send("peer/hello", { label: this.wallet.name });
      if (this.closed) return this;
      this.timer = setInterval(() => {
        void this.send("peer/heartbeat", { label: this.wallet.name });
        this.expire();
      }, 8_000);
    } else {
      this.timer = setInterval(() => this.expire(), 8_000);
    }
    return this;
  }

  async send(type, payload = {}, { to = null } = {}) {
    if (this.privateMode || this.closed)
      throw new Error("This wallet session is private or closed");
    if (this.restricted && to && !this.policy.isMember(to))
      throw new Error("Recipient is not a member of this restricted room");
    const capability = EVENT_CAPABILITY.get(type);
    if (capability && this.capabilities && !this.capabilities.has(capability))
      throw new Error(`This wallet session did not approve ${capability}`);
    const envelope = await signEnvelope(this.wallet, type, {
      ...payload,
      ...(this.membership && PRESENCE_ONLY_TYPES.has(type)
        ? { membership: this.membership }
        : {}),
      room: this.room,
      origin: this.origin,
      session: this.session,
      nonce: randomNonce(),
      expiresAt: Date.now() + MAX_EVENT_AGE_MS,
    });
    const wire = JSON.stringify(envelope);
    if (this.broadcast && (!this.restricted || PRESENCE_ONLY_TYPES.has(type)))
      this.broadcast.postMessage(envelope);
    for (const channel of this.channels) {
      if (channel.readyState === "open" && this.mayDeliver(channel, type, to))
        channel.send(wire);
    }
    this.notify({ direction: "out", envelope, ...(to ? { to } : {}) });
    return envelope;
  }

  async receive(envelope, source = this.localInboundSource) {
    if (!this.allowInbound(source)) return false;
    if (
      this.closed ||
      this.privateMode ||
      envelope?.body?.payload?.room !== this.room ||
      envelope.body.payload.origin !== this.origin
    )
      return false;
    const capability = EVENT_CAPABILITY.get(envelope.body.type);
    if (capability && this.capabilities && !this.capabilities.has(capability))
      return false;
    const payload = envelope.body.payload;
    if (
      typeof payload.session !== "string" ||
      payload.session.length < 8 ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length < 20
    )
      return false;
    if (
      typeof envelope.body.type !== "string" ||
      !/^[-a-z0-9/._]{2,64}$/u.test(envelope.body.type)
    )
      return false;
    if (
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt > Date.now() + MAX_EVENT_AGE_MS + 5_000
    )
      return false;
    if (
      envelope.body.issuer === this.wallet.id &&
      payload.session === this.session
    )
      return false;
    if (!(await verifyEnvelope(envelope, { maxAgeMs: MAX_EVENT_AGE_MS })))
      return false;
    if (this.restricted && !(await this.admitInbound(envelope, source)))
      return false;
    const replayKey = `${envelope.body.issuer}:${payload.session}:${payload.nonce}`;
    this.pruneReplayEntries();
    if (this.seen.has(replayKey) || this.seen.size >= MAX_SEEN_EVENTS)
      return false;
    const now = Date.now();
    if (!this.canRoomInbound(now)) return false;
    if (!this.allowIssuerInbound(envelope.body.issuer)) return false;
    this.allowRoomInbound(now);
    this.seen.set(replayKey, payload.expiresAt);
    const peerKey = `${envelope.body.issuer}:${payload.session}`;
    if (envelope.body.type === "peer/goodbye") this.peers.delete(peerKey);
    else if (
      envelope.body.type === "peer/hello" ||
      envelope.body.type === "peer/heartbeat"
    ) {
      this.peers.set(peerKey, {
        id: envelope.body.issuer,
        session: payload.session,
        name: String(payload.label ?? envelope.body.issuer).slice(0, 60),
        publicKey: envelope.proof.publicKey,
        seenAt: Date.now(),
      });
    }
    this.notify({ direction: "in", envelope, peer: this.peers.get(peerKey) });
    if (envelope.body.type === "peer/hello")
      await this.send("peer/heartbeat", { label: this.wallet.name });
    return true;
  }

  pruneReplayEntries(now = Date.now()) {
    for (const [key, expiresAt] of this.seen)
      if (expiresAt <= now) this.seen.delete(key);
  }

  allowInbound(source, now = Date.now()) {
    const peer = this.channelSources.get(source) ?? source;
    const window = this.inboundWindows.get(peer);
    if (!window || now - window.startedAt >= INBOUND_WINDOW_MS) {
      this.inboundWindows.set(peer, { startedAt: now, count: 1 });
      return true;
    }
    const limit = this.peerChannels.has(peer)
      ? MAX_INBOUND_EVENTS_PER_PEER_WINDOW
      : MAX_INBOUND_EVENTS_PER_SOURCE_WINDOW;
    if (window.count >= limit) return false;
    window.count += 1;
    return true;
  }

  allowIssuerInbound(issuer, now = Date.now()) {
    for (const [key, window] of this.inboundIssuerWindows) {
      if (now - window.startedAt < INBOUND_WINDOW_MS) break;
      this.inboundIssuerWindows.delete(key);
    }
    const window = this.inboundIssuerWindows.get(issuer);
    if (!window || now - window.startedAt >= INBOUND_WINDOW_MS) {
      this.inboundIssuerWindows.delete(issuer);
      this.inboundIssuerWindows.set(issuer, { startedAt: now, count: 1 });
      return true;
    }
    if (window.count >= MAX_INBOUND_EVENTS_PER_IDENTITY_WINDOW) return false;
    window.count += 1;
    return true;
  }

  allowRoomInbound(now = Date.now()) {
    if (!this.canRoomInbound(now)) return false;
    if (
      !this.inboundRoomWindow ||
      now - this.inboundRoomWindow.startedAt >= INBOUND_WINDOW_MS
    ) {
      this.inboundRoomWindow = { startedAt: now, count: 1 };
      return true;
    }
    if (this.inboundRoomWindow.count >= MAX_INBOUND_EVENTS_PER_ROOM_WINDOW)
      return false;
    this.inboundRoomWindow.count += 1;
    return true;
  }

  canRoomInbound(now = Date.now()) {
    return (
      !this.inboundRoomWindow ||
      now - this.inboundRoomWindow.startedAt >= INBOUND_WINDOW_MS ||
      this.inboundRoomWindow.count < MAX_INBOUND_EVENTS_PER_ROOM_WINDOW
    );
  }

  allowPeerConnection(now = Date.now()) {
    if (
      !this.peerConnectionWindow ||
      now - this.peerConnectionWindow.startedAt >= INBOUND_WINDOW_MS
    ) {
      this.peerConnectionWindow = { startedAt: now, count: 1 };
      return true;
    }
    if (this.peerConnectionWindow.count >= MAX_ATTACHED_PEERS) return false;
    this.peerConnectionWindow.count += 1;
    return true;
  }

  expire(now = Date.now()) {
    let expired = false;
    for (const [key, peer] of this.peers) {
      if (now - peer.seenAt > 24_000) {
        this.peers.delete(key);
        expired = true;
      }
    }
    if (expired) this.notify({ direction: "state" });
  }

  attach(channel, source = channel) {
    if (channel.readyState === "closed" || channel.readyState === "closing")
      return channel;
    if (!source || (typeof source !== "object" && typeof source !== "function"))
      source = channel;
    let peerChannels = this.peerChannels.get(source);
    if (
      !peerChannels &&
      (this.peerChannels.size >= MAX_ATTACHED_PEERS ||
        !this.allowPeerConnection())
    ) {
      channel.close();
      this.notify({
        direction: "error",
        message: "This room has reached its direct peer connection limit",
      });
      return channel;
    }
    peerChannels ??= new Set();
    if (peerChannels.size >= MAX_CHANNELS_PER_PEER) {
      channel.close();
      this.notify({
        direction: "error",
        message: "This peer already has the maximum number of data channels",
      });
      return channel;
    }
    this.peerChannels.set(source, peerChannels);
    peerChannels.add(channel);
    this.channelSources.set(channel, source);
    this.channels.add(channel);
    channel.onmessage = ({ data }) => {
      if (typeof data !== "string" || data.length > 64_000) return false;
      try {
        return this.receive(JSON.parse(data), channel);
      } catch {
        /* malformed peer data is discarded */
        return false;
      }
    };
    channel.onopen = () => {
      if (!this.privateMode && !this.closed)
        void this.send("peer/hello", { label: this.wallet.name });
    };
    channel.onclose = () => {
      this.channels.delete(channel);
      this.channelSources.delete(channel);
      const attached = this.peerChannels.get(source);
      attached?.delete(channel);
      if (attached?.size === 0) this.peerChannels.delete(source);
    };
    channel.onerror = () =>
      this.notify({ direction: "error", message: "Peer data channel failed" });
    return channel;
  }

  async close() {
    if (this.closed) return;
    if (!this.privateMode) {
      try {
        await this.send("peer/goodbye", {});
      } catch {
        /* best effort disconnect notice */
      }
    }
    this.closed = true;
    clearInterval(this.timer);
    this.broadcast?.close();
    for (const channel of this.channels) channel.close();
    this.channels.clear();
    this.peerChannels.clear();
    this.channelSources.clear();
    this.listeners.clear();
    this.peers.clear();
  }
}

export class ManualWebRTC {
  constructor(room, { iceServers = [] } = {}) {
    this.room = room;
    this.peer = new RTCPeerConnection({ iceServers });
    this.peer.ondatachannel = ({ channel }) => room.attach(channel, this.peer);
  }

  async offer() {
    this.room.attach(
      this.peer.createDataChannel("ai-auth-wallet-v1"),
      this.peer,
    );
    await this.peer.setLocalDescription(await this.peer.createOffer());
    return this.waitForIce();
  }

  async answer(offerText) {
    const offer = JSON.parse(offerText);
    if (offer.type !== "offer" || typeof offer.sdp !== "string")
      throw new Error("Paste a valid WebRTC offer");
    await this.peer.setRemoteDescription(offer);
    await this.peer.setLocalDescription(await this.peer.createAnswer());
    return this.waitForIce();
  }

  async finish(answerText) {
    const answer = JSON.parse(answerText);
    if (answer.type !== "answer" || typeof answer.sdp !== "string")
      throw new Error("Paste a valid WebRTC answer");
    await this.peer.setRemoteDescription(answer);
  }

  async waitForIce(timeoutMs = 15_000) {
    if (this.peer.iceGatheringState === "complete")
      return JSON.stringify(this.peer.localDescription);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new Error("ICE gathering timed out; retry offer creation")),
        timeoutMs,
      );
      this.peer.addEventListener("icegatheringstatechange", () => {
        if (this.peer.iceGatheringState === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    return JSON.stringify(this.peer.localDescription);
  }

  close() {
    this.peer.close();
  }
}

export class NostrWebRTC {
  constructor(
    coreRoom,
    {
      origin,
      room,
      relayUrls,
      onStatus = () => {},
      onDiagnostic = () => {},
      joinRoom: joinRoomOverride,
    } = {},
  ) {
    if (!coreRoom || typeof coreRoom.receive !== "function")
      throw new TypeError("An authenticated AI Auth room is required");
    this.coreRoom = coreRoom;
    this.origin = origin ?? coreRoom.origin;
    this.roomName = room ?? coreRoom.room;
    this.relayUrls = relayUrls;
    this.onStatus = onStatus;
    this.onDiagnostic = onDiagnostic;
    this.joinRoomOverride = joinRoomOverride;
    this.peerSources = new Map();
    this.directPeers = new Set();
    this.outbox = [];
    this.flushingOutbox = false;
    this.closed = false;
  }

  async start() {
    if (this.coreRoom.privateMode)
      throw new Error("Private wallets do not join public collaboration rooms");
    if (this.closed) throw new Error("This collaboration room is closed");
    this.onStatus("Connecting to public Nostr relays");
    const [trystero, topic] = await Promise.all([
      this.joinRoomOverride
        ? Promise.resolve(null)
        : import("@trystero-p2p/nostr"),
      createSharedRoomTopic(this.origin, this.roomName),
    ]);
    if (this.closed) throw new Error("This collaboration room is closed");
    const joinRoom = this.joinRoomOverride ?? trystero.joinRoom;
    this.transport = joinRoom(
      {
        appId: TRYSTERO_APP_ID,
        ...(this.relayUrls?.length
          ? { relayConfig: { urls: this.relayUrls } }
          : {}),
        turnConfig: [],
      },
      topic,
    );
    this.stopTransportError = this.transport.onError((error) => {
      this.onStatus(
        error.code === "peer-connect-failed"
          ? error.turnConfigured
            ? "Direct ICE failed while using relay configuration"
            : "Direct ICE failed after SDP exchange; this network may block peer candidates"
          : error.code === "relay-failed"
            ? "Could not reach a Nostr relay"
            : "The peer collaboration room reported an error",
      );
    });
    const action = this.transport.makeAction(TRYSTERO_ACTION);
    this.stopReceiving = action.onMessage((envelope, { peerId }) => {
      if (this.closed || typeof peerId !== "string") return;
      let wire;
      try {
        wire = JSON.stringify(envelope);
      } catch {
        return;
      }
      if (!wire || wire.length > MAX_TRYSTERO_EVENT_BYTES) return;
      let source = this.peerSources.get(peerId);
      if (!source) {
        source = { peerId };
        this.peerSources.set(peerId, source);
      }
      this.onDiagnostic({
        stage: "transport-received",
        type: envelope?.body?.type,
        peerId,
      });
      void this.coreRoom.receive(envelope, source).then((accepted) => {
        this.onDiagnostic({
          stage: accepted ? "event-accepted" : "event-rejected",
          type: envelope?.body?.type,
          peerId,
        });
      });
    });
    this.sendAction = action.send;
    this.stopForwarding = this.coreRoom.subscribe(
      ({ direction, envelope, to }) => {
        if (this.closed) return;
        if (direction === "out") this.forward(envelope, to);
        else if (direction === "in" && this.coreRoom.restricted)
          void this.flushOutbox();
      },
    );
    this.stopPeerJoin = this.transport.onPeerJoin(
      ({ peerId }) => {
        this.directPeers.add(peerId);
        this.coreRoom.directPeerCount = this.directPeers.size;
        this.onStatus("Connected to agent peers");
        void this.flushOutbox();
        if (
          !this.coreRoom.capabilities ||
          this.coreRoom.capabilities.has("presence.read")
        )
          void this.coreRoom
            .send("peer/hello", {
              label: this.coreRoom.wallet.name,
            })
            .catch(() => this.onStatus("Could not announce wallet presence"));
      },
      { replay: true },
    );
    this.stopPeerLeave = this.transport.onPeerLeave(({ peerId }) => {
      this.directPeers.delete(peerId);
      if (this.coreRoom.restricted) this.peerSources.delete(peerId);
      this.coreRoom.directPeerCount = this.directPeers.size;
      if (this.transport && Object.keys(this.transport.getPeers()).length === 0)
        this.onStatus("Waiting for agents on this page");
    });
    await this.coreRoom.start();
    if (this.closed) throw new Error("This collaboration room is closed");
    return this;
  }

  // Restricted rooms deliver only to peers that proved membership; presence
  // announcements (which carry only our own proof) go to every direct peer.
  // Returns undefined in open rooms (broadcast, unchanged) or a peer id list.
  targetsFor(envelope, to) {
    if (!this.coreRoom.restricted) return undefined;
    const everyone = !to && PRESENCE_ONLY_TYPES.has(envelope?.body?.type);
    return [...this.directPeers].filter(
      (peerId) =>
        everyone ||
        (this.peerSources.has(peerId) &&
          this.coreRoom.isMemberSource(this.peerSources.get(peerId), to)),
    );
  }

  deliver(envelope, to) {
    const targets = this.targetsFor(envelope, to);
    return targets === undefined
      ? this.sendAction(envelope)
      : targets.length
        ? this.sendAction(envelope, targets)
        : null;
  }

  forward(envelope, to) {
    if (this.closed) return;
    const wire = JSON.stringify(envelope);
    const expiresAt = envelope?.body?.payload?.expiresAt;
    if (
      !wire ||
      wire.length > MAX_TRYSTERO_EVENT_BYTES ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      this.onStatus("A collaboration event was too large or expired");
      return;
    }
    const targets = this.targetsFor(envelope, to);
    if (this.directPeers.size === 0 || targets?.length === 0) {
      if (to) {
        this.onStatus("The recipient is not connected as a verified member");
        return;
      }
      if (envelope?.body?.type === "collab/attachment") {
        this.onStatus(
          "Attachment transfer stopped: no direct peer is connected",
        );
        return;
      }
      this.outbox = this.outbox.filter(
        ({ expiresAt: expiry }) => expiry > Date.now(),
      );
      if (this.outbox.length >= MAX_QUEUED_OUTBOUND_EVENTS) {
        this.onStatus("Waiting for peers; the outgoing event queue is full");
        return;
      }
      this.outbox.push({ envelope, expiresAt, to });
      this.onDiagnostic({
        stage: "event-queued-until-direct-peer",
        type: envelope?.body?.type,
      });
      return;
    }
    this.onDiagnostic({
      stage: "transport-sending",
      type: envelope?.body?.type,
    });
    void this.deliver(envelope, to)
      .then(() =>
        this.onDiagnostic({
          stage: "transport-sent",
          type: envelope?.body?.type,
        }),
      )
      .catch(() => {
        if (envelope?.body?.type === "collab/attachment") {
          this.onStatus("An attachment chunk could not be sent");
          return;
        }
        this.outbox.unshift({ envelope, expiresAt, to });
        this.onStatus(
          "A peer message could not be sent; it is queued for retry",
        );
      });
  }

  async flushOutbox() {
    if (this.flushingOutbox || this.closed || this.directPeers.size === 0)
      return;
    this.flushingOutbox = true;
    try {
      const waiting = [];
      while (
        !this.closed &&
        this.directPeers.size > 0 &&
        this.outbox.length > 0
      ) {
        const queued = this.outbox.shift();
        if (queued.expiresAt <= Date.now()) continue;
        if (this.targetsFor(queued.envelope, queued.to)?.length === 0) {
          waiting.push(queued);
          continue;
        }
        try {
          await this.deliver(queued.envelope, queued.to);
          this.onDiagnostic({
            stage: "transport-sent",
            type: queued.envelope?.body?.type,
          });
        } catch {
          this.outbox.unshift(queued);
          this.onStatus("A queued peer event could not be sent yet");
          break;
        }
      }
      this.outbox.unshift(...waiting);
    } finally {
      this.flushingOutbox = false;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stopReceiving?.();
    this.stopForwarding?.();
    this.stopPeerJoin?.();
    this.stopPeerLeave?.();
    this.stopTransportError?.();
    this.peerSources.clear();
    this.directPeers.clear();
    this.coreRoom.directPeerCount = 0;
    this.outbox.length = 0;
    await this.transport?.leave();
    this.onStatus("Collaboration is off");
  }
}
