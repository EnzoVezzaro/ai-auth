// Site side of AI Auth agent connect links. No wallet is opened or chosen:
// the page joins its room with a short-lived site key, verifies agents that
// bring a valid link, and re-verifies remembered agents with a fresh signed
// challenge. See agent-link.js for the link format and proof.
import {
  AGENT_LINK_EVENTS,
  DEFAULT_AGENT_LINK_TTL_MS,
  agentLinkUrl,
  agentPairProof,
  createAgentLinkPayload,
  createPairKeyPair,
  deriveAgentPairSecret,
  isAgentPairSecret,
  isPairPublicKey,
  isAgentId,
  isAgentLinkNonce,
  randomAgentLinkNonce,
  validLinkOrigin,
  verifyAgentLinkProof,
  verifyAgentPairProof,
} from "./agent-link.js";
import {
  markVerifiedPageConnection,
  revokeVerifiedPageConnection,
} from "./session.js";
import { TOOL_ERROR_CODES, filterCatalogTools } from "./webmcp.js";

const STORAGE_PREFIX = "ai-auth:linked-agents:";
const MAX_REMEMBERED = 16;
const CHALLENGE_TTL_MS = 30_000;
const PRESENCE_CHECK_MS = 4_000;
const DEFAULT_CHECK_MS = 6_000;
const CHALLENGE_RETRY_MS = 3_000;
const DENIAL_INTERVAL_MS = 2_000;
const MAX_DENIAL_TRACK = 64;

const intersect = (a, b) => a.filter((value) => b.includes(value)).sort();

function rememberedStore(storage, key) {
  const read = () => {
    try {
      const parsed = JSON.parse(storage?.getItem(key) ?? "[]");
      return Array.isArray(parsed)
        ? parsed
            .filter(
              (entry) =>
                isAgentId(entry?.id) && isAgentPairSecret(entry?.secret),
            )
            .slice(0, MAX_REMEMBERED)
        : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      storage?.setItem(key, JSON.stringify(list.slice(0, MAX_REMEMBERED)));
    } catch {
      // Storage may be blocked; the agent can still connect with a new link.
    }
  };
  return {
    list: read,
    get: (id) => read().find((entry) => entry.id === id) ?? null,
    put(entry) {
      write([entry, ...read().filter((item) => item.id !== entry.id)]);
    },
    remove(id) {
      write(read().filter((item) => item.id !== id));
    },
  };
}

/** Default browser room: an ephemeral site key, P2PRoom and NostrWebRTC. */
async function openBrowserRoom({ origin, room, capabilities, siteName }) {
  const { createWallet } = await import("./index.js");
  const { P2PRoom, NostrWebRTC } = await import("./p2p.js");
  const wallet = await createWallet({
    name: `${siteName} site key`.slice(0, 60),
    passphrase: randomAgentLinkNonce(),
    persist: false,
  });
  const core = new P2PRoom(wallet, room, { origin, capabilities });
  const transport = new NostrWebRTC(core, { origin, room });
  await transport.start();
  return {
    room: core,
    close: async () => {
      await transport.close().catch(() => {});
      await core.close?.().catch?.(() => {});
    },
  };
}

/**
 * Connect agents to this site with one-time links.
 *
 * phase: "idle" (nothing checked yet) | "checking" (asking remembered agents)
 *        | "needs-link" (show the link) | "connected" (at least one agent).
 */
export function createAIAuthAgentLink({
  siteName,
  capabilities,
  room = "default",
  origin = globalThis.location?.origin,
  // Origin + path only: a page's query string never goes into a link.
  linkBaseUrl = globalThis.location
    ? `${globalThis.location.origin}${globalThis.location.pathname}`
    : undefined,
  storage = globalThis.localStorage,
  linkTtlMs = DEFAULT_AGENT_LINK_TTL_MS,
  checkTimeoutMs = DEFAULT_CHECK_MS,
  openRoom = openBrowserRoom,
  now = Date.now,
} = {}) {
  if (typeof siteName !== "string" || !siteName.trim())
    throw new TypeError("siteName is required");
  if (!validLinkOrigin(origin))
    throw new TypeError(
      "origin must be an exact https origin (http only for localhost)",
    );
  const offered = [...new Set(capabilities ?? [])].sort();
  if (!offered.length) throw new TypeError("capabilities are required");
  const remembered = rememberedStore(
    storage,
    `${STORAGE_PREFIX}${origin}|${room}`,
  );
  const listeners = new Set();
  const connected = new Map(); // agentId -> { id, name, capabilities, connectedAt }
  const challenges = new Map(); // agentId -> { challenge, expiresAt }
  let opened = null;
  let core = null;
  let link = null; // { payload, url, used, redeemed }
  let phase = "idle";
  let stopRoom = null;
  let presenceTimer = null;
  let closed = false;
  let starting = null;
  let checkWaiters = [];

  const snapshot = () =>
    Object.freeze({
      phase,
      siteName,
      origin,
      room,
      siteKey: core?.wallet?.id ?? null,
      link:
        link && !link.used && link.payload.expiresAt > now()
          ? Object.freeze({ url: link.url, expiresAt: link.payload.expiresAt })
          : null,
      agents: Object.freeze(
        [...connected.values()].map((a) => Object.freeze({ ...a })),
      ),
      // Public fields only: the pair secret never leaves the store.
      remembered: Object.freeze(
        remembered
          .list()
          .map(({ id, name, capabilities: caps, linkedAt }) =>
            Object.freeze({ id, name, capabilities: caps, linkedAt }),
          ),
      ),
    });
  const notify = () => {
    const view = snapshot();
    for (const fn of [...listeners]) {
      try {
        fn(view);
      } catch {
        // A failing listener must not break the controller.
      }
    }
  };
  const setPhase = (next) => {
    phase = next;
    notify();
  };
  const present = (agentId) => {
    for (const peer of core?.peers?.values?.() ?? [])
      if (peer?.id === agentId) return true;
    return false;
  };

  async function send(type, payload, to) {
    try {
      await core.send(type, payload, { to });
      return true;
    } catch {
      return false;
    }
  }

  function markConnected(agent) {
    connected.set(agent.id, { ...agent, connectedAt: now() });
    for (const resolve of checkWaiters) resolve(true);
    checkWaiters = [];
    setPhase("connected");
  }

  function dropAgent(agentId) {
    if (!connected.delete(agentId)) return;
    if (!connected.size && phase === "connected") setPhase("idle");
    else notify();
  }

  const pairFields = (role, agent, value) => ({
    role,
    origin,
    room,
    site: core.wallet.id,
    agent,
    challenge: value,
  });

  // One outstanding challenge per agent. It is re-sent (same value) every few
  // seconds while unanswered, so an agent that was not listening yet still
  // gets it, and a failed send is retried rather than blocking for 30 s.
  async function challenge(agentId) {
    const known = remembered.get(agentId);
    if (!known || connected.has(agentId) || !core) return;
    let pending = challenges.get(agentId);
    if (pending && pending.expiresAt > now() && pending.retryAt > now()) return;
    if (!pending || pending.expiresAt <= now()) {
      pending = {
        challenge: randomAgentLinkNonce(),
        expiresAt: now() + CHALLENGE_TTL_MS,
      };
      challenges.set(agentId, pending);
    }
    pending.retryAt = now() + CHALLENGE_RETRY_MS;
    try {
      const siteProof = await agentPairProof(
        known.secret,
        pairFields("site-challenge", agentId, pending.challenge),
      );
      const sent = await send(
        AGENT_LINK_EVENTS.challenge,
        { target: agentId, challenge: pending.challenge, siteProof },
        agentId,
      );
      if (!sent) pending.retryAt = 0;
    } catch {
      pending.retryAt = 0;
    }
  }

  const sendAccept = (redeemed) =>
    send(
      AGENT_LINK_EVENTS.accept,
      {
        target: redeemed.issuer,
        linkNonce: redeemed.linkNonce,
        name: siteName,
        capabilities: redeemed.granted,
        pairKey: redeemed.pairKey,
      },
      redeemed.issuer,
    );

  async function onHello(issuer, payload) {
    if (!link || link.payload.expiresAt <= now()) return;
    if (
      payload?.target !== core.wallet.id ||
      !isAgentLinkNonce(payload.linkNonce) ||
      !isPairPublicKey(payload.pairKey)
    )
      return;
    const current = link;
    // The agent repeats its hello until it sees the accept. A repeat from the
    // agent that already redeemed this link gets the same accept again, so a
    // lost accept never strands it.
    if (current.used) {
      const done = current.redeemed;
      if (done?.issuer === issuer && done.linkNonce === payload.linkNonce)
        await sendAccept(done);
      return;
    }
    const ok = await verifyAgentLinkProof(current.payload, {
      agent: issuer,
      linkNonce: payload.linkNonce,
      proof: payload.proof,
    });
    if (!ok || current.used || link !== current) return;
    current.used = true;
    try {
      const asked = Array.isArray(payload.capabilities)
        ? payload.capabilities
        : [];
      const granted = intersect(asked, current.payload.capabilities);
      const name =
        String(payload.name ?? "Agent")
          .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
          .trim()
          .slice(0, 60) || "Agent";
      const keys = await createPairKeyPair();
      const secret = await deriveAgentPairSecret({
        code: current.payload.code,
        agent: issuer,
        linkNonce: payload.linkNonce,
        privateKey: keys.privateKey,
        peerPublicKey: payload.pairKey,
      });
      remembered.put({
        id: issuer,
        name,
        capabilities: granted,
        linkedAt: now(),
        secret,
      });
      current.redeemed = {
        issuer,
        linkNonce: payload.linkNonce,
        granted,
        pairKey: keys.publicKey,
      };
      await sendAccept(current.redeemed);
      markConnected({ id: issuer, name, capabilities: granted });
    } catch {
      // Could not complete the pairing: release the link so the agent can retry.
      current.used = false;
      current.redeemed = undefined;
    }
  }

  async function onResponse(issuer, payload) {
    const pending = challenges.get(issuer);
    const known = remembered.get(issuer);
    if (!pending || !known || pending.expiresAt <= now()) return;
    if (
      payload?.target !== core.wallet.id ||
      payload.challenge !== pending.challenge
    )
      return;
    const ok = await verifyAgentPairProof(
      known.secret,
      pairFields("agent-response", issuer, pending.challenge),
      payload.agentProof,
    );
    if (!ok || challenges.get(issuer) !== pending) return;
    challenges.delete(issuer);
    markConnected({
      id: issuer,
      name: known.name,
      capabilities: intersect(known.capabilities ?? [], offered),
    });
  }

  function onRoomEvent({ direction, envelope }) {
    if (closed || !core || direction !== "in" || !envelope?.body) return;
    const { type, issuer, payload } = envelope.body;
    if (!isAgentId(issuer) || issuer === core.wallet.id) return;
    if (type === "peer/goodbye") dropAgent(issuer);
    else if (type === "peer/hello" || type === "peer/heartbeat")
      void challenge(issuer);
    else if (type === AGENT_LINK_EVENTS.hello) void onHello(issuer, payload);
    else if (type === AGENT_LINK_EVENTS.response)
      void onResponse(issuer, payload);
  }

  async function start() {
    if (closed) throw new Error("This agent link controller is closed");
    starting ??= (async () => {
      const room_ = await openRoom({
        origin,
        room,
        capabilities: offered,
        siteName,
      });
      // close() may have run while the room was opening.
      if (closed) {
        await room_?.close?.();
        throw new Error("This agent link controller is closed");
      }
      opened = room_;
      core = opened.room;
      stopRoom = core.subscribe(onRoomEvent);
      presenceTimer = setInterval(() => {
        for (const id of [...connected.keys()]) if (!present(id)) dropAgent(id);
        for (const peer of core.peers?.values?.() ?? [])
          void challenge(peer.id);
      }, PRESENCE_CHECK_MS);
      presenceTimer.unref?.();
      notify();
    })().catch((error) => {
      // A failed start (relay down, key creation failed) must not be cached:
      // the next Connect press tries again.
      starting = null;
      throw error;
    });
    return starting;
  }

  /** Create (or reuse) the one-time link for this page session. */
  function createLink() {
    if (!core) throw new Error("Call start() before creating a link");
    if (link && !link.used && link.payload.expiresAt > now() + 30_000)
      return snapshot().link;
    const payload = createAgentLinkPayload({
      origin,
      room,
      site: core.wallet.id,
      name: siteName,
      capabilities: offered,
      ttlMs: linkTtlMs,
      now: now(),
    });
    link = { payload, url: agentLinkUrl(linkBaseUrl, payload), used: false };
    notify();
    return snapshot().link;
  }

  /**
   * The Connect button: ask remembered agents to prove they are here. If one
   * answers, the site is connected; otherwise show a fresh link.
   */
  async function check() {
    await start();
    if (connected.size) {
      setPhase("connected");
      return snapshot();
    }
    try {
      const knownHere = remembered.list().filter((agent) => present(agent.id));
      if (!knownHere.length) {
        // Nobody we know is in the room yet: show the link straight away and
        // keep listening, so a remembered agent that arrives still connects.
        createLink();
        setPhase("needs-link");
        return snapshot();
      }
      setPhase("checking");
      let timer;
      let waiter;
      const answered = new Promise((resolve) => {
        waiter = resolve;
        checkWaiters.push(resolve);
        // Bounded and deliberately not unref'd: the caller is awaiting it.
        timer = setTimeout(() => resolve(false), checkTimeoutMs);
      });
      for (const agent of knownHere) void challenge(agent.id);
      const ok = await answered;
      clearTimeout(timer);
      checkWaiters = checkWaiters.filter((fn) => fn !== waiter);
      if (!ok && !connected.size) {
        createLink();
        setPhase("needs-link");
      }
      return snapshot();
    } catch (error) {
      if (!connected.size) setPhase("idle");
      throw error;
    }
  }

  /** A page "connection" for mountAIAuthInPageAgent: only connected agents may call tools. */
  function toolConnection() {
    if (!core) throw new Error("Call start() before publishing tools");
    if (!offered.includes("tools.invoke"))
      throw new Error("Offer tools.invoke to publish site tools to agents");
    const targetNonce = randomAgentLinkNonce();
    // One denial reply per requester every few seconds: an unconnected peer
    // cannot turn the site into a signing amplifier.
    const deniedAt = new Map();
    const mayDeny = (id) => {
      const last = deniedAt.get(id) ?? 0;
      if (now() - last < DENIAL_INTERVAL_MS) return false;
      if (deniedAt.size >= MAX_DENIAL_TRACK) deniedAt.clear();
      deniedAt.set(id, now());
      return true;
    };
    const mayInvoke = (id) =>
      connected.get(id)?.capabilities?.includes("tools.invoke") === true;
    const connection = {
      identity: Object.freeze({ id: core.wallet.id }),
      request: Object.freeze({ nonce: targetNonce }),
      capabilities: Object.freeze([...offered]),
      get walletSession() {
        return core.session;
      },
      onRoomReady(fn) {
        fn(core.session);
        return () => {};
      },
      onEvent(fn) {
        return core.subscribe(({ direction, envelope }) => {
          if (direction !== "in" || envelope?.body?.type !== "agent/action")
            return;
          const payload = envelope.body.payload;
          const issuer = envelope.body.issuer;
          if (payload?.kind === "tool-request" && !mayInvoke(issuer)) {
            if (!mayDeny(issuer)) return;
            void send(
              "agent/action",
              {
                kind: "tool-response",
                requestId: payload.requestId,
                toWallet: issuer,
                toSession: payload.session,
                error: `Connect to ${siteName} with its AI Auth connect link first`,
                code: TOOL_ERROR_CODES.DENIED,
                targetWallet: core.wallet.id,
                targetNonce,
                targetSession: core.session,
              },
              issuer,
            );
            return;
          }
          if (payload?.kind === "tool-cancel" && !mayInvoke(issuer)) return;
          fn(envelope);
        });
      },
      publishAgentEvent(event) {
        const target = {
          targetWallet: core.wallet.id,
          targetNonce,
          targetSession: core.session,
        };
        if (event?.kind === "tool-catalog")
          return core.send("agent/action", {
            kind: "tool-catalog",
            tools: filterCatalogTools(event.tools ?? []),
            ...target,
          });
        if (event?.kind === "tool-response")
          return core.send(
            "agent/action",
            {
              kind: "tool-response",
              requestId: event.requestId,
              toWallet: event.toWallet,
              toSession: event.toSession,
              ...(Object.hasOwn(event, "result")
                ? { result: event.result }
                : {}),
              ...(typeof event.error === "string"
                ? { error: event.error.slice(0, 240) }
                : {}),
              ...(typeof event.code === "string" ? { code: event.code } : {}),
              ...target,
            },
            { to: event.toWallet },
          );
        return undefined;
      },
      // Site action status stays local; the tool response already tells the agent.
      publishAction() {},
    };
    markVerifiedPageConnection(connection, {
      body: { payload: { capabilities: [...offered], expiresAt: null } },
    });
    toolConnections.add(connection);
    return connection;
  }
  const toolConnections = new Set();

  return Object.freeze({
    start,
    check,
    createLink,
    toolConnection,
    get state() {
      return snapshot();
    },
    /** The verified agent for a signed requester id, or null. */
    agent: (id) =>
      connected.has(id) ? Object.freeze({ ...connected.get(id) }) : null,
    onChange(fn) {
      if (typeof fn !== "function")
        throw new TypeError("A listener function is required");
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Stop trusting an agent on this browser; it needs a new link next time. */
    forget(id) {
      remembered.remove(id);
      dropAgent(id);
      notify();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(presenceTimer);
      stopRoom?.();
      for (const connection of toolConnections)
        revokeVerifiedPageConnection(connection);
      connected.clear();
      link = null;
      await opened?.close?.();
      phase = "idle";
      notify();
    },
  });
}
