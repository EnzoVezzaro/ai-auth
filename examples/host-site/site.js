// Minimal host-site integration: the ONLY thing this page demonstrates is the
// external wallet flow driven by the "Connect agent" button. The wallet is a
// real in-page modal that the owner approves; this site creates no identity and
// never invents scopes. It reads the effective capabilities the SDK derived
// from the verified, signed consent and reports presence/signed events.
//
// Truthfulness contract (B07): signed consent yields Authorized, never
// Connected. Connected additionally requires a verified, live peer that is the
// agent bound to this authorized session. Consent alone has no agent, and a
// peer in the open room is signed presence, not a site grant.
import { connectAIAuthModal } from "../../../packages/p2p/browser.js";

const REQUESTED_CAPABILITIES = ["presence.read", "messages.send"];
const ROOM = "host-demo";
const MAX_EVENTS = 20;
const PRESENCE_IN = new Set(["peer/hello", "peer/heartbeat"]);
const PRESENCE_OUT = new Set(["peer/goodbye"]);
// Heartbeats are signed every 8 s. Allow three missed beats plus skew before a
// bound agent is declared offline; an explicit goodbye is immediate.
const AGENT_LIVENESS_MS = 30_000;
const LIVENESS_TIMER_MS = 5_000;

const state = {
  phase: "idle", // idle | connecting | authorized | connected | disconnected
  connection: null,
  walletIdMasked: "",
  effectiveCapabilities: [],
  peers: new Map(), // issuer -> last signed presence timestamp
  events: [], // { type, issuer }
  error: "",
  // The first verified non-wallet peer seen after consent is the agent this
  // session talks to. Only THAT issuer may make the site "Connected"; once
  // chosen, its departure or expiry takes the site back to Authorized and no
  // other peer can silently inherit the green state.
  expectedAgentId: null,
  agentLive: false,
  agentLost: false,
};

const $ = (selector) => document.querySelector(selector);
const els = {
  connect: $("#connect"),
  disconnect: $("#disconnect"),
  status: $("#status"),
  scopes: $("#scopes"),
  peers: $("#peers"),
  events: $("#events"),
};

// Show at most a fragment of an id. The full wallet id is never rendered.
function maskId(id) {
  if (typeof id !== "string" || !id.trim()) return "unknown";
  const clean = id.trim();
  if (clean.length <= 8) return `${clean.slice(0, 2)}…`;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

function shortIssuer(issuer) {
  if (typeof issuer !== "string" || !issuer) return "unknown";
  return issuer.length <= 8 ? issuer : `${issuer.slice(0, 8)}…`;
}

// Only verified scopes. connection.capabilities is derived from the signed
// consent; the consent payload is the fallback. We never substitute the
// requested list, so an owner's narrowed subset is shown faithfully.
function effectiveCapabilitiesOf(connection) {
  if (connection && Array.isArray(connection.capabilities))
    return [...connection.capabilities];
  const payload = connection?.consent?.body?.payload;
  if (payload && Array.isArray(payload.capabilities))
    return [...payload.capabilities];
  return [];
}

function isSelf(issuer) {
  return !issuer || issuer === state.connection?.identity?.id;
}

function addPeer(issuer) {
  if (isSelf(issuer)) return false;
  state.peers.set(issuer, Date.now());
  renderPeers();
  return true;
}

function removePeer(issuer) {
  if (!issuer) return;
  state.peers.delete(issuer);
  renderPeers();
}

function recordEvent(type, issuer) {
  state.events.unshift({ type, issuer: shortIssuer(issuer) });
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
  renderEvents();
}

// The SDK closes the connection on expiry, idle or revocation. Treat the
// signed expiry as an additional bound so we never paint Connected on a grant
// that is already past its end while the teardown is in flight.
function authorizationActive() {
  const connection = state.connection;
  if (!connection) return false;
  const expiresAt = connection.expiresAt;
  return typeof expiresAt !== "number" || expiresAt > Date.now();
}

function recomputePhase() {
  if (state.phase !== "authorized" && state.phase !== "connected") return;
  if (!authorizationActive()) {
    handleDisconnected();
    return;
  }
  state.phase = state.agentLive ? "connected" : "authorized";
}

// Signed hello/heartbeat means a verified peer is live for this site's room;
// signed goodbye means it is gone. The wallet itself is not the agent.
function notePresence(issuer, type) {
  if (isSelf(issuer)) return;
  if (PRESENCE_OUT.has(type)) {
    if (issuer === state.expectedAgentId && state.agentLive) {
      state.agentLive = false;
      state.agentLost = true;
    }
  } else if (PRESENCE_IN.has(type)) {
    if (state.expectedAgentId === null && !state.agentLost) {
      state.expectedAgentId = issuer;
      state.agentLost = false;
    }
    if (issuer === state.expectedAgentId) {
      state.agentLive = true;
      state.agentLost = false;
    }
  }
  recomputePhase();
  render();
}

function renderStatus() {
  const base =
    state.phase === "authorized" && state.agentLost
      ? "Authorized — agent offline"
      : ({
          idle: "Not connected",
          connecting: "Waiting for approval…",
          authorized: "Authorized",
          connected: "Connected",
          disconnected: "Disconnected",
        }[state.phase] ?? "Not connected");
  const parts = [base];
  if (
    (state.phase === "authorized" || state.phase === "connected") &&
    state.walletIdMasked
  )
    parts.push(`wallet ${state.walletIdMasked}`);
  if (state.error) parts.push(state.error);
  els.status.textContent = parts.join(" · ");
}

function renderScopes() {
  els.scopes.replaceChildren();
  if (!state.effectiveCapabilities.length) {
    els.scopes.textContent =
      els.scopes.dataset.empty || "No approved scopes yet.";
    els.scopes.classList.add("empty");
    return;
  }
  els.scopes.classList.remove("empty");
  for (const scope of state.effectiveCapabilities) {
    const chip = document.createElement("span");
    chip.className = "scope";
    chip.textContent = scope;
    els.scopes.append(chip);
  }
}

function renderList(el, makeItem) {
  el.replaceChildren();
  const items = makeItem();
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = el.dataset.empty || "Nothing here yet.";
    el.append(li);
    return;
  }
  for (const item of items) el.append(item);
}

// Presence only proves a signed hello/heartbeat was seen in the open room. This
// example does not verify the owner's membership authority for other peers, so
// a peer row is never an authorization claim. Label every one explicitly.
function renderPeers() {
  renderList(els.peers, () =>
    [...state.peers.keys()].map((issuer) => {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = shortIssuer(issuer);
      const note = document.createElement("small");
      note.className = "peer-auth";
      note.textContent = " — signed presence — not authorized";
      li.append(code, note);
      return li;
    }),
  );
}

function renderEvents() {
  renderList(els.events, () =>
    state.events.map(({ type, issuer }) => {
      const li = document.createElement("li");
      const typeEl = document.createElement("code");
      typeEl.textContent = type;
      li.append(typeEl, document.createTextNode(` · ${issuer}`));
      return li;
    }),
  );
}

function render() {
  renderStatus();
  renderScopes();
  renderPeers();
  renderEvents();
  const active = state.phase === "authorized" || state.phase === "connected";
  els.connect.disabled = state.phase === "connecting" || active;
  els.disconnect.disabled = !active;
}

function friendlyError(error) {
  return typeof error?.message === "string" && error.message
    ? error.message
    : "The connection could not be established.";
}

function handleDisconnected() {
  state.phase = "disconnected";
  state.connection = null;
  state.walletIdMasked = "";
  state.effectiveCapabilities = [];
  state.peers.clear();
  state.expectedAgentId = null;
  state.agentLive = false;
  state.agentLost = false;
  render();
}

async function connect() {
  if (
    state.phase === "connecting" ||
    state.phase === "authorized" ||
    state.phase === "connected"
  )
    return;
  state.error = "";
  state.phase = "connecting";
  render();

  // Same-origin wallet served by scripts/serve.mjs from dist-p2p/wallet/.
  const walletUrl = new URL("../wallet/", location.href).href;
  try {
    const connection = await connectAIAuthModal({
      walletUrl,
      capabilities: [...REQUESTED_CAPABILITIES],
      room: ROOM,
    });

    state.connection = connection;
    // Consent proves authorization. There is no agent peer yet, so this is
    // Authorized and must not be presented as Connected (B07).
    state.phase = "authorized";
    state.walletIdMasked = maskId(connection.identity?.id);
    state.effectiveCapabilities = effectiveCapabilitiesOf(connection);

    connection.onEvent((envelope) => {
      const type = envelope?.body?.type;
      const issuer = envelope?.body?.issuer;
      if (!type) return;
      recordEvent(type, issuer);
      if (PRESENCE_IN.has(type)) addPeer(issuer);
      else if (PRESENCE_OUT.has(type)) removePeer(issuer);
      notePresence(issuer, type);
    });
    connection.onDisconnect(handleDisconnected);

    render();
  } catch (error) {
    state.error = friendlyError(error);
    state.phase = "disconnected";
    render();
  }
}

function disconnect() {
  const connection = state.connection;
  state.connection = null;
  try {
    connection?.close();
  } catch {
    // The connection may already be gone; the UI state is authoritative.
  }
  handleDisconnected();
}

// A signed goodbye is immediate; a crashed agent has no goodbye, so age out
// signed presence. Either path drops the green state without touching the
// authorization grant, which the SDK alone ends on expiry/idle/revoke.
setInterval(() => {
  if (state.phase !== "authorized" && state.phase !== "connected") return;
  if (!authorizationActive()) {
    handleDisconnected();
    return;
  }
  if (!state.agentLive || !state.expectedAgentId) return;
  const lastSeen = state.peers.get(state.expectedAgentId);
  if (
    typeof lastSeen !== "number" ||
    Date.now() - lastSeen > AGENT_LIVENESS_MS
  ) {
    state.agentLive = false;
    state.agentLost = true;
    recomputePhase();
    render();
  }
}, LIVENESS_TIMER_MS);

els.connect.addEventListener("click", connect);
els.disconnect.addEventListener("click", disconnect);

// Inspection hook for the E2E worker. The approval itself is performed through
// the real wallet modal, not through this object.
window.__hostSite = {
  state,
  get connection() {
    return state.connection;
  },
};

render();
