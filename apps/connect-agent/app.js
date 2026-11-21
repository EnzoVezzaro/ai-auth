// Connect an agent: Choose -> Approve/Install -> Verify & Connect.
// Status rows are independent facts. "Connected now" requires BOTH a verified
// signed proof for the expected wallet/instance AND a live authenticated
// transport. An unrelated peer, a saved grant or a reachable endpoint never
// turns it green. If the secure pairing verifier is unavailable, every proof
// dependent row stays Pending/Not verified (fail closed).
import {
  createWallet,
  loadWallet,
  P2PRoom,
  NostrWebRTC,
  createAIAuthAgentClient,
  createAIAuthConnectInstruction,
} from "@enzovezzaro/ai-auth-wallet";
import { createPairingVerifier } from "./pairing.js";
import { verifyPairingGrant } from "../../packages/agent/pairing.js";

const CAPABILITIES = ["presence.read", "messages.send", "tools.invoke"];
const params = new URLSearchParams(location.search);
const room = params.get("room") ?? "default";
const origin = location.origin;
const $ = (selector) => document.querySelector(selector);

const state = {
  phase: "start",
  harness: "mcp",
  expected: { walletId: "", instanceId: "" },
  // Independent, truthful facts. Never collapse these into one boolean.
  identityVerified: false,
  proof: null,
  proofAt: null,
  accessApproved: false,
  // A signed owner revocation is a fact about the grant, independent of the
  // transport snapshot. It clears online immediately but never rewrites the
  // historical identity verification.
  revoked: false,
  effectiveScopes: [],
  transportStatus: "idle",
  // Strict connectivity from the transport snapshot: an AUTHENTICATED live peer
  // AND an active authorization. A saved grant or a reachable endpoint never
  // sets this.
  snapshotConnected: false,
  // Identity/session of peers whose identity came from a verified signed
  // envelope. An open data channel alone is NOT in this list.
  authenticatedPeers: [],
  // The transport peer (wallet + signed session) that delivered the accepted
  // proof. Online requires that EXACT peer to still be live.
  proofTransport: null,
  online: false,
  name: null,
  id: null,
  items: [],
  error: "",
  challenge: null,
  diagnostics: {},
  pairingAvailable: false,
  lastVerifiedAt: null,
  verificationStarted: false,
};
window.__connectAgent = state;

let siteWallet;
let siteRoom;
let transport;
let client;
let verifier;
let offTransport;
let offRoom;
let instructionPrompt = "";
let reconnecting = false;
let expiryTimer = null;

const PHASE_COPY = {
  start: {
    pill: "NOT STARTED",
    eyebrow: "CONNECT AN AGENT",
    title: "Connect an agent",
    lede: "Approve your agent's local setup, then prove it controls its own identity before anything is shown as connected.",
  },
  install: {
    pill: "SETUP IN PROGRESS",
    eyebrow: "STEP 2 · APPROVE / INSTALL",
    title: "Approve the local setup",
    lede: "Run the copied instructions where your agent runs, then come back to verify its identity.",
  },
  verifying: {
    pill: "WAITING FOR PROOF",
    eyebrow: "STEP 3 · VERIFY & CONNECT",
    title: "Verify this agent",
    lede: "Waiting for a fresh signed proof from the expected wallet and instance.",
  },
  connected: {
    pill: "CONNECTED NOW",
    eyebrow: "STEP 3 · VERIFY & CONNECT",
    title: "Agent verified and online",
    lede: "Identity proved, site access approved, and the authenticated peer is live.",
  },
  offline: {
    pill: "AGENT OFFLINE",
    eyebrow: "STEP 3 · VERIFY & CONNECT",
    title: "Identity verified · Agent offline",
    lede: "Verification is a historical fact. The live connection ended; nothing is online until it reconnects and re-authenticates.",
  },
  expired: {
    pill: "AUTHORIZATION EXPIRED",
    eyebrow: "STEP 3 · VERIFY & CONNECT",
    title: "Authorization expired",
    lede: "The signed access is no longer valid. Re-approve in the wallet, then verify again.",
  },
  revoked: {
    pill: "ACCESS REVOKED",
    eyebrow: "STEP 3 · VERIFY & CONNECT",
    title: "Access revoked",
    lede: "The grant was revoked. Re-approve in the wallet before a new connection can be trusted.",
  },
  error: {
    pill: "ACTION NEEDED",
    eyebrow: "STEP 3 · VERIFY & CONNECT",
    title: "Check the connection",
    lede: "One detail needs your attention before verification can continue.",
  },
  disconnected: {
    pill: "DISCONNECTED",
    eyebrow: "STEP 3 · VERIFY & CONNECT",
    title: "Disconnected",
    lede: "The transport was closed. Verification remains a historical fact only.",
  },
};

const shortWallet = (value) =>
  value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "Not verified";

// A scope is a lowercase dotted identifier (e.g. "presence.read"). Anything
// else — wildcards, empty strings, injected markup — is never shown as approved.
const SCOPE_PATTERN = /^[a-z][a-z0-9-]{0,63}(?:\.[a-z0-9-]{1,63})*$/u;
const SENSITIVE_KEY = /privateKey|secret|passphrase|signature|proof$/iu;
const IDENTITY_KEY =
  /walletId|instanceId|sessionId|nonce|challengeId|issuer|bridge/u;

function authorizationClaim(proof) {
  const claims = proof?.claims ?? {};
  return claims.authorization ?? claims.grant ?? null;
}

function authorizationExpiresAt(proof) {
  const auth = authorizationClaim(proof);
  return auth && Number.isFinite(auth.expiresAt) ? auth.expiresAt : null;
}

function authorizationExpired(proof, at = Date.now()) {
  const expiresAt = authorizationExpiresAt(proof);
  return expiresAt !== null && expiresAt <= at;
}

function redactProofValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactProofValue);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) out[key] = "[redacted]";
    else if (IDENTITY_KEY.test(key) && typeof child === "string")
      out[key] = shortWallet(child);
    else out[key] = redactProofValue(child);
  }
  return out;
}

function sanitizedProofJson(proof) {
  if (!proof) return null;
  let text = JSON.stringify(redactProofValue(proof));
  // Belt and braces: a full identifier must never survive under an unusual key.
  const full = [
    state.expected.walletId,
    state.expected.instanceId,
    state.challenge?.nonce,
    state.challenge?.challengeId,
    state.id,
  ].filter((value) => typeof value === "string" && value.length > 6);
  for (const value of full) text = text.split(value).join(shortWallet(value));
  return text;
}

function setPhase(phase) {
  state.phase = phase;
  const copy = PHASE_COPY[phase] ?? PHASE_COPY.verifying;
  $("#status-text").textContent = copy.pill;
  $("#state-eyebrow").textContent = copy.eyebrow;
  $("#state-title").textContent = copy.title;
  $("#state-lede").textContent = copy.lede;

  const chapter = phase === "start" ? 1 : phase === "install" ? 2 : 3;
  for (const [selector, step] of [
    ["#chapter-choose", 1],
    ["#chapter-approve", 2],
    ["#chapter-verify", 3],
  ]) {
    $(selector).classList.toggle("active", chapter === step);
    if (chapter === step) $(selector).setAttribute("aria-current", "step");
    else $(selector).removeAttribute("aria-current");
  }
  $("#start").hidden = phase !== "start";
  $("#waiting").hidden = phase !== "install";
  $("#session").hidden = chapter !== 3;
}

// Text labels and symbols carry the meaning; colour is only a secondary cue.
function setRow(row, level, text) {
  const mark = $(`#${row}-mark`);
  mark.textContent = level === "ok" ? "✓" : level === "warn" ? "!" : "○";
  $(`#${row}-status`).textContent = text;
  $(`#row-${row}`).dataset.level = level;
}

function connectionOfflineText() {
  // Revocation is about the grant, not the transport: even if the data channel
  // is still open, the connection row must never imply approved access.
  if (state.revoked) return "Access revoked";
  if (authorizationExpired(state.proof)) return "Authorization expired";
  return (
    {
      idle: "Offline",
      connecting: "Waiting for agent",
      signaling: "Waiting for agent",
      "waiting-for-peers": "Waiting for agent",
      "approval-pending": "Approve in wallet",
      "wallet-authorized": "Waiting for agent",
      // A channel may still be open for a DIFFERENT peer after the expected
      // agent left. Say the agent is offline, not that the room is disconnected.
      "direct-peer-connected": "Agent offline",
      reconnecting: "Reconnecting",
      degraded: "Degraded",
      expired: "Authorization expired",
      revoked: "Access revoked",
      disconnected: "Agent offline",
    }[state.transportStatus] ?? "Offline"
  );
}

// The effective scopes come only from a verified authorization claim. The
// hardcoded request list is never rendered as approved capabilities.
function authorizationScopes(proof, at = Date.now()) {
  const auth = authorizationClaim(proof);
  if (!auth || typeof auth !== "object") return null;
  // Every binding must hold: a missing/non-string audience, a revoked grant or
  // an expired/unparseable expiry is never an approved permission.
  if (auth.audience !== origin) return null;
  if (auth.revoked === true) return null;
  if (!Number.isFinite(auth.expiresAt) || auth.expiresAt <= at) return null;
  const scopes = auth.scopes ?? auth.capabilities ?? auth.effectiveScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) return null;
  if (
    !scopes.every(
      (scope) => typeof scope === "string" && SCOPE_PATTERN.test(scope),
    )
  )
    return null;
  return [...new Set(scopes)];
}

function renderDiagnosis() {
  let message = "";
  let action = "";
  if (state.error) {
    message = state.error;
    action = "Try again";
  } else if (!state.expected.walletId || !state.expected.instanceId) {
    message =
      "Add the expected agent wallet ID and instance ID in Choose before verifying.";
    action = "Try again";
  } else if (!state.pairingAvailable) {
    message =
      "Secure proof verification is not available in this build. Nothing can be marked verified.";
    action = "Try again";
  } else if (state.revoked || state.transportStatus === "revoked") {
    message = "Access was revoked for this identity.";
    action = "Re-approve";
  } else if (authorizationExpired(state.proof)) {
    message =
      "The signed authorization expired. Re-approve in the wallet, then verify again.";
    action = "Re-approve";
  } else if (state.transportStatus === "expired") {
    message = "Authorization expired. The agent is no longer online.";
    action = "Re-approve in wallet";
  } else if (
    state.transportStatus === "disconnected" ||
    state.transportStatus === "idle"
  ) {
    message = "Agent offline. The authenticated transport is not open.";
    action = "Try again";
  } else if (state.identityVerified && !state.accessApproved) {
    message = "Identity proved, but no effective site authorization was found.";
    action = "Approve in wallet";
  } else if (!state.identityVerified) {
    message =
      "Waiting for the agent's signed proof. Joining the room alone is not proof.";
    action = "Waiting for agent";
  }
  $("#diagnosis").textContent = message;
  $("#action-hint").textContent = action ? `Next: ${action}.` : "";
}

function render() {
  setPhase(state.phase);

  const live = state.online;
  $("#status-pill").classList.toggle("live", live);

  setRow(
    "identity",
    state.identityVerified ? "ok" : "pending",
    state.identityVerified ? "Verified" : "Not verified",
  );

  const scopes = authorizationScopes(state.proof);
  if (state.revoked) {
    setRow("access", "warn", "Revoked");
    $("#cap-label").textContent = "Permissions revoked";
    $("#capabilities").innerHTML =
      '<span class="cap-note">The owner revoked this grant. Re-approve before it can be trusted again.</span>';
  } else if (state.accessApproved && scopes?.length) {
    setRow("access", "ok", "Approved for this site");
    $("#cap-label").textContent = "Approved permissions";
    $("#capabilities").innerHTML = scopes
      .map((scope) => `<span class="cap-chip ok">${escapeHtml(scope)}</span>`)
      .join("");
  } else if (state.proof && !scopes) {
    setRow("access", "warn", "Permissions not verified");
    $("#cap-label").textContent = "Permissions not verified";
    $("#capabilities").innerHTML =
      '<span class="cap-note">No verifiable authorization was included in the proof.</span>';
  } else {
    setRow("access", "pending", "Not yet authorized");
    $("#cap-label").textContent = "Permissions requested";
    $("#capabilities").innerHTML =
      '<span class="cap-note">Not yet authorized — effective permissions appear here after approval.</span>';
  }

  setRow(
    "connected",
    live ? "ok" : "pending",
    live ? "Online now" : connectionOfflineText(),
  );

  const label = state.identityVerified
    ? (state.name ?? shortWallet(state.id))
    : "Not verified yet";
  $("#agent-name").textContent = label;
  $("#agent-avatar").textContent = label.charAt(0).toUpperCase();
  // Public ids are shown masked; the full value stays in proof/advanced state.
  $("#agent-id").textContent = state.identityVerified
    ? shortWallet(state.id)
    : "";

  $("#session-note").textContent = state.proofAt
    ? `Last verified ${new Date(state.proofAt).toLocaleString()}. Verification does not imply presence.`
    : "No signed proof has been verified in this session.";

  $("#error").textContent = state.error ?? "";
  renderDiagnosis();
  renderAdvanced();
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/gu,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
}

function renderAdvanced() {
  const d = state.diagnostics ?? {};
  $("#adv-did").textContent = state.expected.walletId
    ? shortWallet(state.expected.walletId)
    : "—";
  $("#adv-instance").textContent = state.expected.instanceId
    ? shortWallet(state.expected.instanceId)
    : "Not bound";
  $("#adv-challenge").textContent = state.challenge
    ? `${state.challenge.challengeId ? shortWallet(state.challenge.challengeId) : "—"} / ${state.challenge.nonce ? shortWallet(state.challenge.nonce) : "—"}`
    : "—";
  $("#adv-proof").textContent = state.proof
    ? sanitizedProofJson(state.proof)
    : state.pairingAvailable
      ? "No verified proof yet"
      : "Secure pairing module unavailable";
  $("#adv-verified-at").textContent = state.lastVerifiedAt
    ? `${new Date(state.lastVerifiedAt).toLocaleString()} (previous session)`
    : "Never";
  $("#adv-context").textContent = `room: ${room} · origin: ${origin}`;
  $("#adv-transport").textContent = state.transportStatus;
  $("#adv-diagnostics").textContent = [
    `directPeers: ${d.directPeerCount ?? 0}`,
    `authenticatedPeers: ${d.authenticatedCount ?? state.authenticatedPeers.length}`,
    `generation: ${d.generation ?? "none"}`,
    `relays: ${d.relaysConnected ?? "unknown"}`,
    d.lastIceError ? `ICE: ${d.lastIceError}` : "ICE: no error",
  ].join(" · ");
}

function clearExpiryTimer() {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

// An accepted grant has a hard expiry. Without a timer the UI could stay green
// indefinitely until some unrelated event happened to call recompute().
function scheduleExpiryTimer() {
  clearExpiryTimer();
  if (state.revoked) return;
  const expiresAt = authorizationExpiresAt(state.proof);
  if (expiresAt === null) return;
  const delay = expiresAt - Date.now();
  if (delay <= 0) {
    recompute();
    return;
  }
  // The small margin makes the expiry check true when this callback runs.
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    recompute();
  }, delay + 5);
}

// The peer that delivered the accepted proof must still be live. Matching only
// the transport's global status would let any other data channel keep the page
// "Connected" after the expected agent left (audit B02). The wallet + signed
// session pair binds online to that exact authenticated peer: a new session
// after a reconnect is a different peer and needs a fresh proof.
function proofPeerLive() {
  const proofPeer = state.proofTransport;
  if (!proofPeer?.walletId || !proofPeer?.sessionId) return false;
  if (proofPeer.walletId !== state.expected.walletId) return false;
  return (state.authenticatedPeers ?? []).some(
    (peer) =>
      peer.walletId === proofPeer.walletId &&
      peer.sessionId === proofPeer.sessionId,
  );
}

// One source of truth: online is only ever derived from a verified proof PLUS a
// live authenticated transport AND the exact peer that proved it. Any negative
// lifecycle transition clears it immediately while identity verification stays
// a separate historical fact.
function recompute() {
  const expired = authorizationExpired(state.proof);
  const live =
    state.transportStatus === "direct-peer-connected" &&
    state.snapshotConnected === true &&
    proofPeerLive();
  if (expired) {
    state.accessApproved = false;
    state.effectiveScopes = [];
  }
  state.online = Boolean(
    live &&
    !state.revoked &&
    !expired &&
    state.identityVerified &&
    state.accessApproved,
  );

  // Lifecycle snapshots must not advance the wizard before the user has chosen
  // to verify; chapters 1 and 2 are user-driven.
  if (!state.verificationStarted) {
    render();
    return;
  }

  if (state.error) state.phase = "error";
  else if (state.online) state.phase = "connected";
  else if (state.revoked) state.phase = "revoked";
  else if (expired) state.phase = "expired";
  else if (state.transportStatus === "expired") state.phase = "expired";
  else if (state.transportStatus === "revoked") state.phase = "revoked";
  else if (state.transportStatus === "disconnected")
    state.phase = "disconnected";
  else if (state.identityVerified) state.phase = "offline";
  else state.phase = "verifying";
  render();
}

function applyVerifiedProof(proof) {
  if (state.revoked) return false;
  if (!proof || typeof proof !== "object") return false;
  const walletMatches =
    Boolean(state.expected.walletId) &&
    proof.walletId === state.expected.walletId;
  const instanceMatches =
    !state.expected.instanceId ||
    proof.instanceId === state.expected.instanceId;
  if (!walletMatches || !instanceMatches) {
    state.error =
      "The signed proof belongs to a different wallet or instance. Nothing was marked verified.";
    recompute();
    return false;
  }

  state.proof = proof;
  state.proofAt = Number.isFinite(proof.verifiedAt)
    ? proof.verifiedAt
    : Date.now();
  state.lastVerifiedAt = state.proofAt;
  state.identityVerified = true;
  state.id = proof.walletId;
  state.name =
    proof.claims?.name ??
    proof.claims?.label ??
    (typeof proof.claims?.agent?.name === "string"
      ? proof.claims.agent.name
      : shortWallet(proof.walletId));

  const expired = authorizationExpired(proof);
  const scopes = authorizationScopes(proof);
  state.effectiveScopes = expired ? [] : (scopes ?? []);
  state.accessApproved = Boolean(!expired && scopes?.length);
  state.error = "";
  recompute();
  // Even a proof that is already expired goes through recompute(); scheduling
  // only arms a timer for a still-live grant.
  scheduleExpiryTimer();
  return true;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function buildInstructions() {
  const instruction = createAIAuthConnectInstruction({
    siteName: "AI Auth workspace",
    siteOrigin: origin,
    walletUrl: new URL("../wallet/", location.href).href,
    capabilities: CAPABILITIES,
    room,
  });
  // Public setup page only: no query string acts as a credential and no
  // private endpoint, key or recovery material is copied. The page query is a
  // location hint, never a grant. `room` was validated by
  // createAIAuthConnectInstruction above, so pass it explicitly: otherwise the
  // parser treats the URL as discovery-only and resolveSite falls back to the
  // manifest's first room ("default"), losing a custom ?room= from the link.
  const setupPage = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
  // Identity creation is an explicit, one-time opt-in step. `serve` only ever
  // unlocks the existing keystore; it never mints an identity. Both commands
  // share the same keystore directory so serve uses what init created.
  const initCommand = `npx -y @enzovezzaro/ai-auth-mcp init --new-identity \
  --keystore-dir ~/.ai-auth/agent`;
  const serveCommand = `npx -y @enzovezzaro/ai-auth-mcp serve \
  --keystore-dir ~/.ai-auth/agent \
  --http 0 \
  --connect "${setupPage}" \
  --room "${room}" \
  --open-wallet \
  --auto-join`;

  return `${instruction.instruction}

Local setup (manual — review before running in your agent):

1) Create the agent identity once (passphrase from AI_AUTH_PASSPHRASE or a TTY prompt):
${initCommand}

2) Start the MCP bridge (uses the existing identity only; it never creates one):
${serveCommand}

Steps:
1. Run command 1 once. It prints a public wallet ID; "serve" does not create an identity.
2. Run command 2. It prints a loopback MCP URL, and the wallet window on first connect asks you to approve the exact scopes.
3. Paste the printed MCP URL into your agent's MCP config and start the agent runtime.
4. Copy the public wallet ID printed by command 1, paste it into "Expected agent wallet ID" on this page, then choose Verify & connect.

This page marks a connection verified only after a fresh signed proof from that exact wallet and instance. Joining the room alone is not proof.

Never paste private keys, passphrases or recovery files into chat.`;
}

async function copyInstructions() {
  const ok = await copy(instructionPrompt);
  if (!ok) {
    state.error =
      "Could not copy to the clipboard. Allow clipboard access and try again.";
    render();
    return false;
  }
  state.error = "";
  return true;
}

// Imported statically so the production bundle contains the verifier. If the
// factory is unavailable for any reason, every proof-dependent row stays
// Pending/Not verified — never a fabricated success.
let pairingFactory = null;

async function startVerification() {
  if (!state.expected.walletId || !state.expected.instanceId) {
    state.error =
      "Enter both the expected agent wallet ID and instance ID in Choose, then try again.";
    state.phase = "start";
    render();
    $(
      !state.expected.walletId ? "#expected-wallet" : "#expected-instance",
    )?.focus();
    return;
  }
  verifier?.close?.();
  verifier = null;
  clearExpiryTimer();
  state.challenge = null;
  state.proof = null;
  state.proofAt = null;
  state.identityVerified = false;
  state.accessApproved = false;
  state.revoked = false;
  state.effectiveScopes = [];
  // A new challenge needs a fresh proof from a fresh peer session.
  state.proofTransport = null;
  state.online = false;
  state.error = "";
  state.verificationStarted = true;

  // Show the verification chapter first, then publish the challenge. This
  // gives a local responder a moment to attach to the room before the signed
  // challenge is broadcast (it is not replayed to late subscribers).
  exposeControls();
  recompute();

  if (state.pairingAvailable) {
    try {
      verifier = pairingFactory({
        siteWallet,
        siteRoom,
        origin,
        room,
        expected: { ...state.expected },
        now: () => Date.now(),
        ttlMs: 120_000,
      });
      verifier.onVerified((proof) => applyVerifiedProof(proof));
      verifier.onRevoked(() => {
        // A valid owner revocation invalidates the grant immediately. The live
        // transport may still be open; online is recomputed from the revoked
        // grant and cleared, while identityVerified stays a historical fact.
        state.revoked = true;
        clearExpiryTimer();
        state.accessApproved = false;
        state.effectiveScopes = [];
        state.error = "";
        recompute();
      });
      exposeControls();
      await new Promise((resolve) => setTimeout(resolve, 350));
      state.challenge = await verifier.start();
    } catch (error) {
      state.error = `Secure verification could not start: ${error.message} Status stays Not verified.`;
    }
  } else {
    state.error =
      "Secure proof verification is not available in this build. Status stays Not verified.";
  }

  exposeControls();
  render();
}

function handleSnapshot(snapshot) {
  state.transportStatus = snapshot.status;
  // Strict: an open channel for some other peer is not the expected agent.
  state.snapshotConnected = snapshot.authenticatedConnected === true;
  state.authenticatedPeers = (snapshot.authenticatedPeers ?? []).map(
    (peer) => ({
      ...peer,
    }),
  );
  state.diagnostics = {
    directPeerCount: snapshot.directPeerCount,
    authenticatedCount: state.authenticatedPeers.length,
    generation: snapshot.generation,
    relaysConnected: snapshot.diagnostics?.relaysConnected,
    lastIceError: snapshot.diagnostics?.lastIceError,
    waitingSinceMs: snapshot.diagnostics?.waitingSinceMs,
  };
  recompute();
}

function handleRoomEvent({ direction, envelope, peer }) {
  if (direction !== "in") return;
  const { type, issuer, payload = {} } = envelope.body ?? {};
  // The accepted proof travels on a verified signed envelope. Bind online to
  // the transport peer (wallet + signed session) that actually delivered it;
  // the verifier independently checks the signature and wallet/instance. A
  // different peer's channel never satisfies this binding.
  if (
    type === "agent/pair-proof" &&
    issuer === state.expected.walletId &&
    typeof peer?.session === "string" &&
    peer.session
  ) {
    const next = { walletId: issuer, sessionId: peer.session };
    if (
      state.proofTransport?.walletId !== next.walletId ||
      state.proofTransport?.sessionId !== next.sessionId
    ) {
      state.proofTransport = next;
      recompute();
    }
  }
  // An inbound hello/heartbeat only shows up in advanced diagnostics. It never
  // sets the verified identity or the connected state.
  if (
    (type === "peer/hello" || type === "presence/heartbeat") &&
    issuer !== siteWallet?.id
  ) {
    state.items.push(`Peer seen: ${shortWallet(issuer)} (unverified)`);
    if (state.items.length > 12) state.items.shift();
    renderAdvanced();
  } else if (type === "message/text" && typeof payload.text === "string") {
    state.items.push(`Message: ${payload.text.slice(0, 120)}`);
  } else if (type === "agent/action" && payload.name) {
    state.items.push(
      `${payload.name}: ${String(payload.summary ?? payload.state ?? "").slice(0, 120)}`,
    );
  }
}

async function resetTransport() {
  offTransport?.();
  offRoom?.();
  await transport?.close();
  await siteRoom?.close();
  siteRoom = new P2PRoom(siteWallet, room, {
    origin,
    capabilities: CAPABILITIES,
  });
  transport = new NostrWebRTC(siteRoom, { origin, room });
  client = createAIAuthAgentClient(siteRoom);
  offTransport = transport.onConnectionState(handleSnapshot);
  offRoom = siteRoom.subscribe(handleRoomEvent);
  state.transportStatus = transport.connectionState.status;
  state.snapshotConnected =
    transport.connectionState.authenticatedConnected === true;
  state.authenticatedPeers = [];
  // A fresh transport/generation invalidates any proof-to-peer binding.
  state.proofTransport = null;
  state.online = false;
  await transport.start();
}

// Debug/test seam. A caller-supplied proof is never trusted for authorization:
// its grant envelope is re-verified against the active challenge before it can
// affect the access-approved state. Identity-only synthetic proofs stay usable
// for accessibility screenshots, but can never turn the connection green
// without a live, signed, challenge-bound grant (recompute() enforces that).
async function applyVerifiedProofSeam(proof) {
  const auth = authorizationClaim(proof);
  if (!auth || typeof auth !== "object") return applyVerifiedProof(proof);
  const challengePayload = state.challenge?.challenge?.body?.payload ?? {};
  const reverified = await verifyPairingGrant(auth, {
    expectedIssuer: siteWallet?.id,
    audience: origin,
    room,
    walletId: state.expected.walletId,
    instanceId: state.expected.instanceId,
    sessionId: challengePayload.sessionId,
    nonce: challengePayload.nonce,
    expiresAt: challengePayload.expiresAt,
    now: () => Date.now(),
  }).catch(() => null);
  const claims = { ...(proof.claims ?? {}) };
  if (reverified) claims.authorization = reverified;
  else {
    // Never let an unverified grant grant access.
    delete claims.authorization;
    delete claims.grant;
  }
  return applyVerifiedProof({ ...proof, claims });
}

function exposeControls() {
  window.__connectAgentControls = {
    siteRoom,
    transport,
    client,
    siteWallet,
    verifier,
    // Signature-checking seam (see applyVerifiedProofSeam). It still validates
    // the expected wallet + instance and requires a live transport before
    // anything is shown as connected.
    applyVerifiedProof: applyVerifiedProofSeam,
    startVerification,
    get challenge() {
      return state.challenge;
    },
  };
}

async function testConnection() {
  const ping = `ping:${Date.now()}`;
  $("#test-connection").disabled = true;
  $("#diagnosis").textContent = "Sending a signed ping to the expected agent…";
  try {
    if (!siteRoom || !state.online)
      throw new Error("No verified live peer to ping.");
    await siteRoom.send("verification/ping", {
      nonce: ping,
      walletId: state.expected.walletId,
    });
    const pong = await new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        offRoom?.();
        offRoom = siteRoom.subscribe(handleRoomEvent);
        resolve(ok);
      };
      offRoom?.();
      offRoom = siteRoom.subscribe((event) => {
        handleRoomEvent(event);
        if (event.direction !== "in") return;
        const { type, issuer, payload = {} } = event.envelope.body ?? {};
        if (
          type === "verification/pong" &&
          payload.nonce === ping &&
          issuer === state.expected.walletId
        )
          finish(true);
      });
      setTimeout(() => finish(false), 5_000);
    });
    state.error = "";
    if (pong) {
      $("#diagnosis").textContent =
        "Signed ping answered by the expected agent — connection is live.";
    } else {
      $("#diagnosis").textContent =
        "No signed reply from the expected agent. The peer may be offline or not supporting verification pings.";
    }
  } catch (error) {
    state.error = `Connection test failed: ${error.message}`;
    render();
  } finally {
    $("#test-connection").disabled = false;
  }
}

async function start() {
  pairingFactory =
    typeof createPairingVerifier === "function" ? createPairingVerifier : null;
  state.pairingAvailable = Boolean(pairingFactory);

  instructionPrompt = buildInstructions();

  try {
    siteWallet = await loadWallet();
  } catch {
    siteWallet = null;
  }
  if (!siteWallet)
    siteWallet = await createWallet({
      name: "Connect Agent workspace",
      passphrase: crypto.randomUUID(),
    });

  try {
    await resetTransport();
  } catch (error) {
    state.error = `Transport could not start: ${error.message}`;
    state.transportStatus = "disconnected";
  }
  exposeControls();

  $("#connect").addEventListener("click", async () => {
    state.expected.walletId = $("#expected-wallet").value.trim();
    state.expected.instanceId = $("#expected-instance").value.trim();
    state.harness = $("#harness").value;
    if (!(await copyInstructions())) return;
    state.phase = "install";
    render();
  });
  $("#again").addEventListener("click", copyInstructions);
  $("#begin-verify").addEventListener("click", () => {
    void startVerification();
  });
  $("#retry").addEventListener("click", async () => {
    if (reconnecting) return;
    reconnecting = true;
    try {
      if (
        state.transportStatus === "disconnected" ||
        state.transportStatus === "idle"
      )
        await resetTransport();
      await startVerification();
    } catch (error) {
      state.error = `Could not reconnect: ${error.message}`;
      recompute();
    } finally {
      reconnecting = false;
    }
  });
  $("#disconnect").addEventListener("click", async () => {
    verifier?.close?.();
    verifier = null;
    clearExpiryTimer();
    state.challenge = null;
    await transport?.close();
    state.transportStatus = "disconnected";
    state.authenticatedPeers = [];
    state.proofTransport = null;
    state.online = false;
    recompute();
  });
  $("#test-connection").addEventListener("click", () => void testConnection());

  render();
}

start().catch((error) => {
  state.error = error.message;
  state.transportStatus = "disconnected";
  recompute();
});
