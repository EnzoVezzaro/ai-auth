import {
  MAX_EVENT_AGE_MS,
  MAX_SEEN_EVENTS,
  randomNonce,
  signEnvelope,
  verifyEnvelope,
} from "./index.js";

const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;

export class P2PRoom {
  constructor(
    wallet,
    room,
    { privateMode = false, origin = globalThis.location?.origin ?? "" } = {},
  ) {
    if (!ROOM_PATTERN.test(room))
      throw new Error("Room names must be 1–100 safe characters");
    this.wallet = wallet;
    this.room = room;
    this.origin = origin;
    this.privateMode = privateMode;
    this.session = crypto.randomUUID();
    this.peers = new Map();
    this.seen = new Map();
    this.listeners = new Set();
    this.channels = new Set();
    this.closed = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      void this.receive(data);
    };
    await this.send("peer/hello", { label: this.wallet.name });
    this.timer = setInterval(() => {
      void this.send("peer/heartbeat", { label: this.wallet.name });
      this.expire();
    }, 8_000);
    return this;
  }

  async send(type, payload = {}) {
    if (this.privateMode || this.closed)
      throw new Error("This wallet session is private or closed");
    const envelope = await signEnvelope(this.wallet, type, {
      ...payload,
      room: this.room,
      origin: this.origin,
      session: this.session,
      nonce: randomNonce(),
      expiresAt: Date.now() + MAX_EVENT_AGE_MS,
    });
    const wire = JSON.stringify(envelope);
    if (this.broadcast) this.broadcast.postMessage(envelope);
    for (const channel of this.channels) {
      if (channel.readyState === "open") channel.send(wire);
    }
    this.notify({ direction: "out", envelope });
    return envelope;
  }

  async receive(envelope) {
    if (
      this.closed ||
      this.privateMode ||
      envelope?.body?.payload?.room !== this.room ||
      envelope.body.payload.origin !== this.origin
    )
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
    const replayKey = `${envelope.body.issuer}:${payload.session}:${payload.nonce}`;
    this.pruneReplayEntries();
    if (this.seen.has(replayKey) || this.seen.size >= MAX_SEEN_EVENTS)
      return false;
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

  expire(now = Date.now()) {
    for (const [key, peer] of this.peers)
      if (now - peer.seenAt > 24_000) this.peers.delete(key);
  }

  attach(channel) {
    this.channels.add(channel);
    channel.onmessage = ({ data }) => {
      if (typeof data !== "string" || data.length > 64_000) return;
      try {
        void this.receive(JSON.parse(data));
      } catch {
        /* malformed peer data is discarded */
      }
    };
    channel.onopen = () => {
      if (!this.privateMode && !this.closed)
        void this.send("peer/hello", { label: this.wallet.name });
    };
    channel.onclose = () => this.channels.delete(channel);
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
    this.listeners.clear();
    this.peers.clear();
  }
}

export class ManualWebRTC {
  constructor(room, { iceServers = [] } = {}) {
    this.room = room;
    this.peer = new RTCPeerConnection({ iceServers });
    this.peer.ondatachannel = ({ channel }) => room.attach(channel);
  }

  async offer() {
    this.room.attach(this.peer.createDataChannel("ai-auth-wallet-v1"));
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
