// BODY4AI demo site entry. Mounts the SDK connect panel, collaboration
// wheel, presence list and WebMCP tools, and exposes `window.__b4a` so the E2E
// can drive and inspect the page. Every protocol decision (consent, session,
// membership, tool authorization, receipts, revocation) is made by the SDK.
import {
  CollaborationTransfers,
  NostrWebRTC,
  P2PRoom,
  approveLink,
  buildCursorPayload,
  createAIAuthAgentClient,
  createAIAuthConnectInstruction,
  createParticipationPolicy,
  createRevocationGossip,
  createWallet,
  listLinks,
  loadWallet,
  mountAIAuthInPageAgent,
  mountCollaborationWheel,
  unlink,
} from "../../../packages/p2p/browser.js";
import {
  markVerifiedPageConnection,
  renewVerifiedPageConnection,
  revokeVerifiedPageConnection,
} from "../../../packages/p2p/session.js";
import { PRODUCTS, getProduct } from "./catalog.js";
import { mountConnectPanel } from "./connect-panel.js";
import { mountPresence } from "./cursors.js";
import {
  PlainError,
  capabilityLabel,
  connectionStatusLabel,
  requirePassphrase,
  requireWallet,
  sessionEndText,
} from "./messages.js";
import { MAX_COORDINATE } from "../../../packages/p2p/presence.js";
import { negotiateSession, renewSession } from "./session.js";
import { buildActions, makeAuthorize } from "./tools.js";
import { foreignChecks } from "./foreign.js";

const DEFAULT_CAPABILITIES = [
  "presence.read",
  "messages.send",
  "content.share",
  "tools.invoke",
];
const PASSIVE = new Set(["peer/hello", "peer/heartbeat", "peer/goodbye"]);
const state = {
  config: null,
  wallet: null,
  session: null,
  room: null,
  transport: null,
  policy: null,
  transfers: null,
  client: null,
  tools: null,
  gossip: null,
  adapter: null,
  membership: null,
  connLog: [],
  events: [],
  transferLog: [],
  statusLog: [],
  catalogs: [],
  revocations: [],
  wishlist: [],
  executions: [],
  denials: [],
  lifecycle: [],
  calls: new Map(),
  cleanups: [],
  busy: false,
  error: "",
  closeReason: "",
  panel: null,
};
const $ = (selector) => document.querySelector(selector);
const storageKey = () =>
  `b4a:membership:${state.config.origin}:${state.config.room}:${state.wallet.id}`;

function guardActive(type) {
  const lease = state.session?.lease;
  const status = lease?.status() ?? "revoked";
  if (status !== "active") {
    state.adapter?.close(status);
    throw new Error("The AI Auth connection is closed");
  }
  if (!PASSIVE.has(type) && type !== "presence/cursor") lease.touch();
}

function makeAdapter() {
  const lifecycle = new Set();
  const disconnects = new Set();
  let closed = false;
  const payload = () => state.session.consent.body.payload;
  let cursorSeq = 0;
  const adapter = {
    get identity() {
      return { id: state.wallet.id, name: state.wallet.name };
    },
    get request() {
      return state.session.request;
    },
    get consent() {
      return state.session.consent;
    },
    get capabilities() {
      return Object.freeze([...payload().capabilities]);
    },
    get expiresAt() {
      return payload().expiresAt;
    },
    get walletSession() {
      return state.room?.session ?? null;
    },
    onEvent: (listener) =>
      state.room.subscribe(
        ({ direction, envelope }) =>
          direction === "in" && envelope && listener(envelope),
      ),
    onRoomReady(listener) {
      if (state.room) listener(state.room.session);
      return () => {};
    },
    // Protocol v1 cursor: the input pixel point becomes a 0..1 fraction of the
    // document, scaled by MAX_COORDINATE (PROTOCOL.md §8).
    publishCursor({ x, y }) {
      const docEl = document.documentElement;
      const width = docEl?.scrollWidth ?? docEl?.clientWidth ?? 1;
      const height = docEl?.scrollHeight ?? docEl?.clientHeight ?? 1;
      const fraction = (value, size) =>
        Math.max(0, Math.min(1, value / Math.max(1, size)));
      return state.room.send(
        "presence/cursor",
        buildCursorPayload({
          pageKey: location.pathname,
          x: Math.round(fraction(x, width) * MAX_COORDINATE),
          y: Math.round(fraction(y, height) * MAX_COORDINATE),
          seq: ++cursorSeq,
          label: state.wallet.name,
        }),
      );
    },
    publishAction({ name, state: phase, summary }) {
      void state.room
        .send("agent/action", { name, state: phase, summary })
        .catch(() => {});
    },
    publishAgentEvent(event) {
      const route = {
        targetWallet: state.wallet.id,
        targetNonce: state.session.request.nonce,
        targetSession: state.room.session,
      };
      void state.room
        .send("agent/action", { ...event, ...route })
        .catch(() => {});
    },
    onLifecycle(listener) {
      lifecycle.add(listener);
      listener({
        type: "connected",
        label: state.wallet.name,
        identity: adapter.identity,
        capabilities: adapter.capabilities,
        expiresAt: adapter.expiresAt,
      });
      return () => lifecycle.delete(listener);
    },
    onDisconnect(listener) {
      disconnects.add(listener);
      return () => disconnects.delete(listener);
    },
    async renew() {
      state.session = await renewSession(state.session, {
        wallet: state.wallet,
        origin: state.config.origin,
        room: state.config.room,
        sessionTtlMs: state.config.sessionTtlMs,
      });
      renewVerifiedPageConnection(adapter, state.session.consent);
      refreshView();
      for (const l of lifecycle)
        l({ type: "renewed", expiresAt: adapter.expiresAt });
    },
    close(reason = "closed") {
      if (closed) return;
      closed = true;
      state.session?.lease.revoke();
      revokeVerifiedPageConnection(adapter);
      state.closeReason = reason;
      state.error = "";
      void teardown(reason === "expired" || reason === "idle");
      refreshView();
      state.lifecycle.push({ type: "disconnected", reason });
      for (const l of lifecycle) l({ type: "disconnected", reason });
      for (const l of disconnects) l();
    },
  };
  return adapter;
}

async function teardown(expired) {
  const { transport, room } = state;
  state.transport = null;
  state.room = null;
  for (const cleanup of state.cleanups.splice(0)) {
    try {
      await cleanup();
    } catch {
      // Best effort: the connection is already closed.
    }
  }
  await transport?.close({ expired }).catch(() => {});
  await room?.close().catch(() => {});
}

function adoptWallet(wallet) {
  state.wallet = wallet;
  try {
    state.membership = JSON.parse(localStorage.getItem(storageKey()));
  } catch {
    state.membership = null;
  }
  $("#identity").textContent = wallet.id;
  renderPanel();
}

async function identity({ label, passphrase }) {
  let wallet = await loadWallet();
  const created = !wallet;
  wallet ??= await createWallet({ name: label, passphrase });
  adoptWallet(wallet);
  return { walletId: wallet.id, publicKey: wallet.publicKey, created };
}

async function createVisitorWallet(passphrase) {
  state.error = "";
  try {
    await identity({
      label: "Visitor",
      passphrase: requirePassphrase(passphrase),
    });
  } catch (error) {
    state.error = plainMessage(error);
    renderPanel();
  }
}

async function connect() {
  if (state.adapter && state.session?.lease.isActive()) return state.adapter;
  requireWallet(state.wallet);
  const { config } = state;
  state.closeReason = "";
  state.session = await negotiateSession({
    wallet: state.wallet,
    origin: config.origin,
    room: config.room,
    requested: config.requested ?? DEFAULT_CAPABILITIES,
    sessionTtlMs: config.sessionTtlMs,
  });
  state.adapter = makeAdapter();
  markVerifiedPageConnection(state.adapter, state.session.consent);
  const watch = setInterval(() => {
    const status = state.session.lease.status();
    if (status !== "active") state.adapter.close(status);
  }, 500);
  const refresh = setInterval(refreshView, 15_000);
  state.cleanups.push(
    () => clearInterval(watch),
    () => clearInterval(refresh),
  );
  refreshView();
  return state.adapter;
}

// Local time with a countdown, shown under the catalog. Empty when no session
// has been granted; the panel repeats the same time.
function showExpiry() {
  const el = $("#session-expiry");
  if (!state.session) {
    el.textContent = "";
    return;
  }
  const { expiresAt } = state.session.consent.body.payload;
  const active = state.session.lease.isActive();
  el.textContent =
    active || state.closeReason === "expired"
      ? sessionEndText({ expiresAt, now: Date.now() })
      : "";
}

function plainMessage(error) {
  if (error instanceof PlainError) return error.message;
  console.error(error);
  return "Something went wrong. Click Connect agent to try again.";
}

function panelView() {
  const active = Boolean(state.adapter && state.session?.lease.isActive());
  const phase = state.busy
    ? "connecting"
    : active
      ? "connected"
      : state.closeReason
        ? "disconnected"
        : "idle";
  const payload = state.session?.consent.body.payload;
  const detail =
    phase === "connected" && payload
      ? `${sessionEndText({ expiresAt: payload.expiresAt, now: Date.now() })}. You allowed: ${payload.capabilities
          .map(capabilityLabel)
          .join(", ")}.`
      : "";
  return {
    phase,
    busy: state.busy,
    status: connectionStatusLabel({
      phase,
      transport: state.transport?.connectionState?.status,
      reason: state.closeReason,
    }),
    detail,
    error: state.error,
    hasWallet: Boolean(state.wallet),
  };
}

function renderPanel() {
  state.panel?.render(panelView());
}

function refreshView() {
  showExpiry();
  renderPanel();
}

function createRoom() {
  const { config } = state;
  const approved = state.session.consent.body.payload.capabilities;
  state.policy = config.restricted
    ? createParticipationPolicy({
        mode: "restricted",
        trustPolicy: { issuers: [config.issuer] },
        origin: config.origin,
        room: config.room,
      })
    : null;
  const room = new P2PRoom(state.wallet, config.room, {
    origin: config.origin,
    // Private presence: receive authorized events, advertise no presence.
    privateMode: Boolean(config.privatePresence),
    capabilities: approved,
    ...(state.policy
      ? {
          participation: {
            policy: state.policy,
            membership: state.membership,
          },
        }
      : {}),
  });
  const send = room.send.bind(room);
  room.send = (type, payload, options) => {
    guardActive(type);
    return send(type, payload, options);
  };
  state.room = room;
  return room;
}

function recordEvents(room) {
  return room.subscribe(({ direction, envelope }) => {
    if (direction !== "in" || !envelope) return;
    const { type, issuer, payload } = envelope.body;
    state.events.push({
      type,
      issuer,
      kind: payload.kind,
      name: payload.name,
      state: payload.state,
      session: payload.session,
    });
    if (state.events.length > 600) state.events.shift();
  });
}

function recordTransfers(transfers) {
  return transfers.subscribe((event) => {
    state.transferLog.push({
      type: event.type,
      text: event.text,
      elementText: event.metadata?.text,
      name: event.name,
      kind: event.kind,
      size: event.size ?? event.blob?.size,
      issuer: event.envelope?.body?.issuer,
      target: event.envelope?.body?.payload?.target,
      receiptMessageId: event.receipt?.messageId,
      receiptReceiver: event.receipt?.receiver,
    });
  });
}

async function join() {
  if (!state.session) await connect();
  const { config } = state;
  const room = createRoom();
  const approved = state.session.consent.body.payload.capabilities;
  state.transport = new NostrWebRTC(room, {
    origin: config.origin,
    room: config.room,
    relayUrls: config.relayUrls,
    onStatus: (message) => state.statusLog.push(message),
  });
  state.transport.onConnectionState((snapshot) => {
    state.connLog.push({
      status: snapshot.status,
      directPeerCount: snapshot.directPeerCount,
    });
    renderPanel();
  });
  state.presence = mountPresence({
    list: $("#cursor-list"),
    overlay: $("#cursor-overlay"),
    room,
    pageKey: location.pathname,
  });
  state.transfers = new CollaborationTransfers(room, {
    authorize: () => state.session.lease.isActive(),
  });
  state.cleanups.push(
    recordEvents(room),
    recordTransfers(state.transfers),
    () => state.presence.stop(),
    mountCollaborationWheel(state.transfers, {
      capabilities: approved,
      room,
      network: state.transport,
      expiresAt: state.session.lease.expiresAt,
    }),
    () => state.transfers.close(),
  );
  if (state.policy)
    state.gossip = createRevocationGossip(room, {
      policy: state.policy,
      onApplied: (record) =>
        state.revocations.push({ kind: record.kind, target: record.target }),
    });
  state.client = createAIAuthAgentClient(room, {
    timeoutMs: config.toolTimeoutMs ?? 30_000,
  });
  state.client.onCatalog((catalog) => state.catalogs.push(catalog));
  state.cleanups.push(() => state.client.close());
  await state.transport.start();
  if (config.host) await mountTools();
  return snapshot();
}

async function mountTools() {
  state.tools = await mountAIAuthInPageAgent({
    actions: buildActions(state),
    connection: state.adapter,
    // The SDK gate: every remote run needs a live membership scope and an
    // execution grant from this policy; `authorize` adds the human decision.
    policy: state.policy,
    authorize: makeAuthorize({
      target: $("#approvals"),
      log: (...entry) => state.denials.push(entry.join(": ")),
    }),
  });
  state.cleanups.push(() => state.tools.close());
}

// The roster may only show scopes backed by signed membership data the SDK has
// already verified locally. An open room, a revoked peer or a peer without a
// verified membership has no grant to show; nothing is inferred from a name.
function grantedScopesFor(walletId) {
  if (typeof walletId !== "string" || !walletId) return [];
  let info;
  try {
    info = state.policy?.inspect?.(walletId);
  } catch {
    return [];
  }
  if (
    !info ||
    info.walletRevoked ||
    info.membershipRevoked ||
    !info.member ||
    !Array.isArray(info.member.scopes)
  )
    return [];
  return [...new Set(info.member.scopes.filter((s) => typeof s === "string"))];
}

function snapshot() {
  const room = state.room;
  const net = state.transport?.connectionState;
  const peers = new Map();
  for (const peer of room?.peers.values() ?? [])
    if (peer.id !== state.wallet.id) peers.set(peer.id, peer.session);
  return {
    walletId: state.wallet?.id ?? null,
    // After a close the transport is gone; report the same state the panel shows.
    status: net?.status ?? (state.closeReason ? "disconnected" : "idle"),
    directPeerCount: net?.directPeerCount ?? 0,
    peers: [...peers.keys()],
    peerList: [...(room?.peers.values() ?? [])]
      .filter((peer) => peer.id !== state.wallet.id)
      .map((peer) => ({
        id: peer.id,
        session: peer.session,
        name: peer.name,
        scopes: grantedScopesFor(peer.id),
      })),
    session: room?.session ?? null,
    sessionStatus: state.session?.lease.status() ?? "none",
    capabilities: state.session?.consent.body.payload.capabilities ?? [],
    expiresAt: state.session?.lease.expiresAt ?? null,
    issuedAt: state.session?.consent.body.payload.issuedAt ?? null,
    hasMembership: Boolean(state.membership),
    mode: room?.participationMode ?? null,
    privateMode: room?.privateMode ?? false,
    cursors: [...document.querySelectorAll("[data-cursor]")].map((node) => ({
      issuer: node.dataset.issuer,
      session: node.dataset.session,
      state: node.dataset.state,
      page: node.dataset.page ?? null,
      x: node.dataset.x === undefined ? null : Number(node.dataset.x),
      y: node.dataset.y === undefined ? null : Number(node.dataset.y),
      text: node.textContent,
    })),
    catalogs: state.catalogs.map((c) => ({
      wallet: c.wallet,
      tools: c.tools.map((t) => t.name),
    })),
  };
}

function findCatalog(hostWallet) {
  const catalogs = state.client.catalogs.filter(
    (c) => !hostWallet || c.wallet === hostWallet,
  );
  return catalogs.at(-1) ?? null;
}

const describeError = (error) => ({
  error: String(error?.message ?? error),
  name: error?.name ?? "Error",
});

async function callTool({ host, name, input, callId, giveUpMs }) {
  const catalog = findCatalog(host);
  if (!catalog) return { error: "no catalog", name: "NoCatalog" };
  const controller = new AbortController();
  if (callId) state.calls.set(callId, controller);
  // For calls that are expected to get no answer at all (a dropped request).
  const giveUp = giveUpMs
    ? setTimeout(() => controller.abort(), giveUpMs)
    : null;
  try {
    const result = await state.client.callTool(catalog, name, input ?? {}, {
      signal: controller.signal,
    });
    return { ok: true, result };
  } catch (error) {
    return {
      ...describeError(error),
      gaveUp: Boolean(giveUp) && controller.signal.aborted,
    };
  } finally {
    clearTimeout(giveUp);
    if (callId) state.calls.delete(callId);
  }
}

async function rawToolRequest({ host, name, input, requestId }) {
  const catalog = findCatalog(host);
  if (!catalog) return { error: "no catalog" };
  try {
    await state.room.send("agent/action", {
      kind: "tool-request",
      requestId,
      name,
      input,
      targetWallet: catalog.wallet,
      targetSession: catalog.session,
      targetNonce: catalog.requestNonce,
    });
    return { sent: true };
  } catch (error) {
    return describeError(error);
  }
}

async function sendAttachment({ size, kind, name, mime, target }) {
  try {
    const blob = new Blob([new Uint8Array(size).fill(7)], { type: mime });
    await state.transfers.sendAttachment(blob, { kind, name, target });
    return { ok: true };
  } catch (error) {
    return describeError(error);
  }
}

async function sendText({ text, target }) {
  try {
    const sent = await state.transfers.sendText(text, target ? { target } : {});
    return { ok: true, messageId: sent.body.payload.messageId };
  } catch (error) {
    return describeError(error);
  }
}

function renderPage() {
  const params = new URLSearchParams(location.search);
  const list = $("#products");
  const detail = $("#product-detail");
  if (list)
    for (const product of PRODUCTS) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `./product.html?id=${product.id}`;
      link.textContent = `${product.name} ($${product.price})`;
      item.append(link);
      list.append(item);
    }
  if (detail) {
    const product = getProduct(params.get("id") ?? PRODUCTS[0].id);
    $("#product-name").textContent = product?.name ?? "Unknown product";
    $("#product-blurb").textContent = product?.blurb ?? "";
  }
}

function defaultConfig() {
  return {
    origin: location.origin,
    room: "body4ai-demo",
    restricted: true,
    host: false,
  };
}

// Visitor flow: connect with the button, approve in the site dialog, and the
// panel follows the live connection. Errors become one plain line.
async function startConnection() {
  state.error = "";
  state.busy = true;
  renderPanel();
  try {
    await connect();
    if (!state.room) await join();
  } catch (error) {
    state.error = plainMessage(error);
  } finally {
    state.busy = false;
    refreshView();
    if (state.error) state.panel?.focusConnect();
  }
}

async function extendSession() {
  state.error = "";
  renderPanel();
  try {
    await state.adapter.renew();
  } catch (error) {
    state.error = plainMessage(error);
  }
  refreshView();
}

function mountPanel() {
  if (state.panel) return;
  const walletUrl = new URL("../wallet/", location.href).href;
  const instruction = createAIAuthConnectInstruction({
    siteOrigin: location.origin,
    walletUrl,
    capabilities: DEFAULT_CAPABILITIES,
    room: state.config.room,
    siteName: "BODY4AI",
  });
  state.panel = mountConnectPanel({
    target: $("#agent-connect-panel"),
    instruction:
      typeof instruction === "string" ? instruction : instruction.instruction,
    handlers: {
      onConnect: startConnection,
      onCreateWallet: (passphrase) => createVisitorWallet(passphrase),
      onExtend: extendSession,
      onDisconnect: () => state.adapter?.close("closed"),
    },
  });
  renderPanel();
}

function admitMembership(proof) {
  state.membership = proof;
  localStorage.setItem(storageKey(), JSON.stringify(proof));
  if (state.room) state.room.membership = proof;
  return true;
}

window.__b4a = {
  state,
  init(config) {
    state.config = { ...defaultConfig(), ...config };
    mountPanel();
    return state.config;
  },
  identity,
  connect: async () => {
    await connect();
    return snapshot();
  },
  join,
  snapshot,
  admitMembership,
  admitGrant: (walletId, grant) => state.policy.admitGrant(walletId, grant),
  authorize: (walletId, scope) => ({
    isMember: state.policy.isMember(walletId),
    can: state.policy.can(walletId, scope),
  }),
  isRevoked: (kind, target) => state.policy.isRevoked(kind, target),
  publishRevocation: (record) => state.gossip.publish(record),
  renew: async () => {
    await state.adapter.renew();
    return snapshot();
  },
  disconnect: () => state.adapter?.close("closed"),
  moveCursor: (x, y) =>
    state.adapter.publishCursor({ x, y }).then(
      () => ({ ok: true }),
      (error) => describeError(error),
    ),
  audit: () =>
    state.room
      .audit()
      .map(({ type, private: hidden }) => ({ type, private: hidden })),
  overlay: () =>
    [...document.querySelectorAll("#cursor-overlay .remote-cursor")].map(
      (node) => node.dataset.issuer,
    ),
  sendText,
  sendAttachment,
  callTool,
  abortCall: (callId) => state.calls.get(callId)?.abort(),
  rawToolRequest,
  sendSigned: (type, payload, to) =>
    state.room.send(type, payload, to ? { to } : {}).then(
      () => ({ ok: true }),
      (error) => describeError(error),
    ),
  probeSign: async () => {
    try {
      guardActive("probe/ping");
      await state.wallet.sign("probe/ping", { at: Date.now() });
      return { ok: true };
    } catch (error) {
      return describeError(error);
    }
  },
  linkApprove: (challenge, capabilities) =>
    approveLink(state.wallet, challenge, { capabilities }),
  links: async () =>
    (await listLinks(state.wallet)).map(({ linkId, capabilities }) => ({
      linkId,
      capabilities,
    })),
  unlinkSite: (linkId) => unlink(state.wallet, linkId),
  foreignChecks: (artifacts) => foreignChecks(artifacts, state),
};

state.config = defaultConfig();
renderPage();
mountPanel();
// Restore a wallet from an earlier visit; never create one without the visitor.
loadWallet()
  .then((wallet) => {
    if (wallet) adoptWallet(wallet);
  })
  .catch((error) => console.error(error));
