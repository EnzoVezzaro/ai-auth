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

function setPhase(phase) {
  state.phase = phase;
  const copy = PHASE_COPY[phase] ?? PHASE_COPY.verifying;
  $("#status-text").textContent = copy.pill;
  $("#state-eyebrow").textContent = copy.eyebrow;
  $("#state-title").textContent = copy.title;
  $("#state-lede").textContent = copy.lede;

  const chapter = phase === "start" ? 1 : phase === "install" ? 2 : 3;
  $("#chapter-choose").classList.toggle("active", chapter === 1);
  $("#chapter-approve").classList.toggle("active", chapter === 2);
  $("#chapter-verify").classList.toggle("active", chapter === 3);
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
  return (
    {
      idle: "Offline",
      connecting: "Waiting for agent",
      signaling: "Waiting for agent",
      "waiting-for-peers": "Waiting for agent",
      "approval-pending": "Approve in wallet",
      "wallet-authorized": "Waiting for agent",
      "direct-peer-connected": "Offline",
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
function authorizationScopes(proof) {
  const claims = proof?.claims ?? {};
  const auth = claims.authorization ?? claims.grant ?? null;
  if (!auth || typeof auth !== "object") return null;
  const audienceOk =
    typeof auth.audience !== "string" || auth.audience === origin;
  const scopes = auth.scopes ?? auth.capabilities ?? auth.effectiveScopes;
  if (!audienceOk || !Array.isArray(scopes) || scopes.length === 0) return null;
  if (!scopes.every((scope) => typeof scope === "string")) return null;
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
  $("#adv-did").textContent = state.expected.walletId || "—";
  $("#adv-instance").textContent = state.expected.instanceId || "Not bound";
  $("#adv-challenge").textContent = state.challenge
    ? `${state.challenge.challengeId ?? "—"} / ${state.challenge.nonce ?? "—"}`
    : "—";
  $("#adv-proof").textContent = state.proof
    ? JSON.stringify(state.proof)
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
    `generation: ${d.generation ?? "none"}`,
    `relays: ${d.relaysConnected ?? "unknown"}`,
    d.lastIceError ? `ICE: ${d.lastIceError}` : "ICE: no error",
  ].join(" · ");
}

// One source of truth: online is only ever derived from a verified proof PLUS a
// live authenticated transport. Any negative lifecycle transition clears it
// immediately while identity verification stays a separate historical fact.
function recompute() {
  const live = state.transportStatus === "direct-peer-connected";
  state.online = Boolean(
    live && !state.revoked && state.identityVerified && state.accessApproved,
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

  const scopes = authorizationScopes(proof);
  state.effectiveScopes = scopes ?? [];
  state.accessApproved = Boolean(scopes?.length);
  state.error = "";
  recompute();
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
  // private endpoint, key or recovery material is copied.
  const setupPage = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
  const command = `npx -y @enzovezzaro/ai-auth-mcp serve \\
  --http 0 \\
  --connect "${setupPage}" \\
  --open-wallet \\
  --auto-join`;

  return `${instruction.instruction}

Local setup (manual — review before running in your agent):

${command}

Steps:
1. Run the command above. It prints a loopback MCP URL.
2. Approve the wallet window that opens on first connect. The agent creates and stores its own identity in a local encrypted keystore.
3. Paste the printed MCP URL into your agent's MCP config and start the agent runtime.
4. Copy the public wallet ID your agent prints, paste it into "Expected agent wallet ID" on this page, then choose Verify & connect.

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
  state.challenge = null;
  state.proof = null;
  state.proofAt = null;
  state.identityVerified = false;
  state.accessApproved = false;
  state.revoked = false;
  state.effectiveScopes = [];
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
  state.diagnostics = {
    directPeerCount: snapshot.directPeerCount,
    generation: snapshot.generation,
    relaysConnected: snapshot.diagnostics?.relaysConnected,
    lastIceError: snapshot.diagnostics?.lastIceError,
    waitingSinceMs: snapshot.diagnostics?.waitingSinceMs,
  };
  recompute();
}

function handleRoomEvent({ direction, envelope }) {
  if (direction !== "in") return;
  const { type, issuer, payload = {} } = envelope.body ?? {};
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
  state.online = false;
  await transport.start();
}

function exposeControls() {
  window.__connectAgentControls = {
    siteRoom,
    transport,
    client,
    siteWallet,
    verifier,
    // Test/debug seam: still validates expected wallet + instance and requires
    // a live transport before anything is shown as connected.
    applyVerifiedProof,
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
    state.challenge = null;
    await transport?.close();
    state.transportStatus = "disconnected";
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
