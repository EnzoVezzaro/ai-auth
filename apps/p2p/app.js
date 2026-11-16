import { CollaborationTransfers } from "../../packages/p2p/collaboration.js";
import {
  appendActivity,
  approvePermissionRequest,
  createCapabilityGrant,
  createInstanceId,
  createWallet,
  createPermissionRequest,
  downloadBackup,
  forgetWallet,
  importWalletBackup,
  loadWallet,
  NonceGuard,
  P2PRoom,
  readActivity,
  verifyCapabilityGrant,
  verifyEnvelope,
  verifyPermissionConsent,
  verifyPermissionRequest,
  verifyPopupPermissionRequest,
  NostrWebRTC,
  SessionLease,
  sessionLimits,
  DEFAULT_SESSION_TTL_MS,
} from "../../packages/p2p/index.js";

const $ = (selector) => document.querySelector(selector);
const externalConnectMode =
  new URLSearchParams(location.search).get("connect") === "1";
const externalHost =
  window.opener || (window.parent !== window ? window.parent : null);
const debugMode = new URLSearchParams(location.search).get("debug") === "1";
const debug = (stage, details = "") => {
  if (debugMode) console.info("[AI Auth debug]", stage, details);
};
const renewalGuard = new NonceGuard();
// One instance id per wallet tab. It is only a clone-detection hint, so a
// blocked sessionStorage just yields a fresh id for this page load.
const pageInstanceId = (() => {
  try {
    const stored = sessionStorage.getItem("ai-auth-instance-id");
    if (/^inst:[A-Za-z0-9_-]{22}$/u.test(stored ?? "")) return stored;
    const created = createInstanceId();
    sessionStorage.setItem("ai-auth-instance-id", created);
    return created;
  } catch {
    return createInstanceId();
  }
})();
const state = {
  wallet: null,
  view: externalConnectMode ? "connect" : "overview",
  room: null,
  rtc: null,
  request: null,
  consent: null,
  externalRequest: null,
  externalSource: null,
  externalOrigin: "",
  externalStatus: "",
  externalRequestReceived: false,
  externalExpiryTimer: null,
  lease: null,
  renewal: null,
  sessionTimer: null,
  messages: [],
  privateMode: true,
  externalRoomReady: false,
  externalPendingEvents: [],
  error: "",
};
const capabilityOptions = [
  [
    "presence.read",
    "See this agent's public presence",
    "Let the requesting site see that this agent is online.",
  ],
  [
    "messages.send",
    "Exchange messages",
    "Allow message exchange in this site's shared space.",
  ],
  [
    "content.share",
    "Share selected content",
    "Allow manually selected elements, screenshots, and recordings to be shared with peers.",
  ],
  [
    "tools.invoke",
    "Use approved tools",
    "The site still chooses and enforces each tool action.",
  ],
  [
    "tasks.delegate",
    "Delegate a task",
    "Allow a limited task handoff to an authorized peer.",
  ],
];
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const shortId = (value) =>
  value ? `${value.slice(0, 20)}…${value.slice(-9)}` : "Not created";
const dateText = (value) => new Date(value).toLocaleString();
function durationText(ms) {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
function sessionTtlChoices(request) {
  const { maxSessionTtlMs } = sessionLimits(request);
  const choices = new Set(
    [5, 15, 30, 60]
      .map((minutes) => minutes * 60_000)
      .filter((ms) => ms <= maxSessionTtlMs),
  );
  choices.add(maxSessionTtlMs);
  return [...choices].sort((a, b) => a - b);
}
function remainingText(expiresAt) {
  const remaining = Math.max(0, expiresAt - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return minutes > 0
    ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 3200);
}

function fail(error) {
  state.error = error instanceof Error ? error.message : String(error);
  render();
}

function pageHead(eyebrow, title, description) {
  return `<div class="page-head"><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p class="lede">${esc(description)}</p></div>`;
}

function setupFormError() {
  return `<p class="error-text" id="form-error" role="alert">${esc(state.error)}</p>`;
}

function walletSetupView() {
  return `${pageHead("YOUR KEY. YOUR AGENT.", "Start with a wallet.", "Create an agent identity in this browser. Your signing key is stored in IndexedDB and cannot be exported by this page after creation.")}
    <div class="grid-main">
      <section class="panel">
        <div class="panel-head"><div><h2>Create a wallet</h2><p class="panel-copy">A recovery file is encrypted before it is downloaded. Keep it separate from this browser.</p></div><span class="status-tag pending">LOCAL KEY</span></div>
        <form id="create-wallet-form">
          <div class="field"><label for="wallet-name">Agent name</label><input class="control" id="wallet-name" name="name" maxlength="60" autocomplete="off" required placeholder="E.g. Research assistant" /></div>
          <div class="field"><label for="wallet-passphrase">Recovery passphrase</label><input class="control" id="wallet-passphrase" name="passphrase" type="password" minlength="12" autocomplete="new-password" required /><small>Use 12 or more characters. The wallet derives an encryption key locally.</small></div>
          <div class="field"><label for="wallet-passphrase-confirm">Confirm passphrase</label><input class="control" id="wallet-passphrase-confirm" name="confirmation" type="password" minlength="12" autocomplete="new-password" required /></div>
      ${setupFormError()}
          <div class="callout"><strong>Recovery matters.</strong> If browser data is cleared, the encrypted recovery file is the only way to restore this key.</div>
          <div class="button-row"><button class="button" type="submit">Create wallet and backup</button></div>
        </form>
        <form id="import-wallet-form" class="stack form-separated">
          <div><h3>Restore a wallet</h3><p class="panel-copy">Import an encrypted AI Auth recovery file.</p></div>
          <div class="field"><label for="backup-file">Recovery file</label><input class="control" id="backup-file" type="file" accept="application/json,.json" required /></div>
          <div class="field"><label for="restore-passphrase">Recovery passphrase</label><input class="control" id="restore-passphrase" type="password" autocomplete="current-password" required /></div>
          <button class="button secondary" type="submit">Unlock and restore</button>
        </form>
      </section>
      <aside class="stack">
        <section class="panel"><div class="panel-head"><div><p class="mini-label">WHAT THIS IS</p><h3>Agent identity without an account</h3></div></div><p class="panel-copy">A public key identifies the wallet. It can sign proof of possession and scoped consent. A signature does not grant access to someone else's site.</p></section>
        <section class="panel"><div class="panel-head"><div><p class="mini-label">NO CHAIN REQUIRED</p><h3>Web cryptography only</h3></div></div><div class="metric-line"><span>Algorithm</span><strong>ECDSA · P-256</strong></div><div class="metric-line"><span>Storage</span><strong>Browser IndexedDB</strong></div><div class="metric-line"><span>Blockchain</span><strong>None</strong></div></section>
      </aside>
    </div>`;
}

function walletView() {
  if (!state.wallet) return walletSetupView();
  return `${pageHead("IDENTITY", "Your agent has an identity.", "A public key other websites can verify. The private signing key stays in this browser's IndexedDB.")}
    <div class="grid-main">
      <div class="stack">
        <section class="key-card"><p class="mini-label">PUBLIC AGENT ID</p><code class="key-id">${esc(state.wallet.id)}</code><div class="key-meta"><div>Agent name<strong>${esc(state.wallet.name)}</strong></div><div>Created<strong>${esc(dateText(state.wallet.createdAt))}</strong></div><div>Key status<strong>Non-exportable</strong></div></div></section>
        <section class="panel"><div class="panel-head"><div><h2>Signing key</h2><p class="panel-copy">The private key cannot be read back after import into Web Crypto. The encrypted backup can be copied whenever you need it.</p></div><span class="status-tag"><span class="state-dot"></span> READY</span></div>
          <div class="metric-line"><span>Key type</span><strong>ECDSA P-256</strong></div><div class="metric-line"><span>Signature hash</span><strong>SHA-256</strong></div><div class="metric-line"><span>Exportability</span><strong>Private key: no</strong></div>
          <div class="button-row"><button class="button secondary" id="download-backup">Download encrypted recovery file</button><button class="button quiet" id="copy-agent-id">Copy public identity</button></div>
        </section>
        <section class="panel"><div class="danger-zone"><div><h3>Remove this wallet from this browser</h3><p>This clears the stored signing key and local signed activity. Restore later from the encrypted recovery file.</p></div><button class="button danger small" id="forget-wallet">Remove wallet</button></div></section>
      </div>
      <aside class="stack"><section class="panel"><div class="panel-head"><div><p class="mini-label">WALLET PRINCIPLE</p><h3>Identity travels as a signature</h3></div></div><p class="panel-copy">A website supplies its origin, a fresh nonce, requested scopes and expiry. You review and sign only what you approve.</p><div class="callout top-gap"><strong>The site still decides.</strong> It must verify the wallet signature and enforce access to its own resources.</div></section>
      <section class="panel"><div class="panel-head"><div><p class="mini-label">RECOVERY FILE</p><h3>Encrypted, not plaintext</h3></div></div><p class="panel-copy">AES-GCM encrypts the key backup with a passphrase-derived key. A wrong passphrase fails closed.</p><div class="metric-line"><span>Encryption</span><strong>AES-GCM 256</strong></div><div class="metric-line"><span>Key derivation</span><strong>PBKDF2 · SHA-256</strong></div></section></aside>
    </div>`;
}

function overviewView() {
  const peers = state.room?.peers.size ?? 0;
  const activityCount = state.activity?.length ?? 0;
  const identity = state.wallet
    ? `<section class="panel"><div class="panel-head"><div><p class="mini-label">AGENT IDENTITY</p><h2>${esc(state.wallet.name)}</h2><p class="panel-copy">This key lives in this browser and signs your agent's proofs.</p></div><span class="status-tag"><span class="state-dot"></span> READY</span></div><code class="key-id">${esc(shortId(state.wallet.id))}</code></section>`
    : `<section class="panel"><div class="panel-head"><div><p class="mini-label">AGENT IDENTITY</p><h2>Create your wallet</h2><p class="panel-copy">Generate a local signing identity and save an encrypted recovery file.</p></div><span class="status-tag pending">NOT CREATED</span></div><button class="button" data-go-wallet>Set up wallet</button></section>`;
  return `${pageHead("WALLET OVERVIEW", "Your agent, at a glance.", "Manage a local cryptographic identity, approve scoped requests, and connect directly with other wallets.")}
    ${identity}
    <div class="grid-main top-gap">
      <section class="panel"><p class="mini-label">CURRENT SESSION</p><h2>${state.privateMode ? "Private" : "Public collaboration"}</h2><p class="panel-copy">${state.privateMode ? "You receive room events but advertise no presence until you go public." : "Wallets on this site's public space discover one another through Nostr."}</p><div class="metric-line"><span>Connected peers</span><strong id="overview-peer-count">${peers}</strong></div><div class="metric-line"><span>Stored activity</span><strong>${activityCount}</strong></div><div class="callout top-gap">The website is the collaboration hub. Nostr relays coordinate discovery; signed events travel directly between wallets over WebRTC. No AI Auth server is involved.</div></section>
      <section class="panel"><p class="mini-label">QUICK ACTIONS</p><h2>What would you like to do?</h2><div class="overview-actions"><button class="button secondary" data-go-view="connect">Review a site request</button><button class="button secondary" data-go-view="permissions">Grant a capability</button><button class="button secondary" data-go-view="peer">Connect to an agent</button><button class="button quiet" data-go-view="activity">View signed activity</button></div></section>
    </div>`;
}

function connectView() {
  if (state.externalRequest) return externalPermissionView();
  if (!state.wallet)
    return `${pageHead("CONNECT", "Review a site request.", "Create a short-lived challenge for a site, choose the capabilities, and sign your approval.")}${walletRequired()}`;
  const scopes = capabilityOptions
    .map(
      ([id, title, detail], index) =>
        `<label class="checkbox-row"><input type="checkbox" name="capability" value="${esc(id)}" ${index < 2 ? "checked" : ""}/><span><strong>${esc(title)}</strong><small><code>${esc(id)}</code> · ${esc(detail)}</small></span></label>`,
    )
    .join("");
  const result = state.consent
    ? `<section class="panel"><div class="panel-head"><div><p class="mini-label">SIGNATURE VERIFIED</p><h2>Consent proof created</h2><p class="panel-copy">The wallet signed these selected scopes for ${esc(state.request.audience)}. The demo verifier checked the wallet, nonce, audience, expiry and scope subset.</p></div><span class="status-tag"><span class="state-dot"></span> VERIFIED</span></div><div class="fingerprint">${esc(JSON.stringify(state.consent, null, 2))}</div><div class="button-row"><button class="button secondary" id="copy-consent">Copy signed proof</button><button class="button quiet" id="new-request">New request</button></div><div class="callout top-gap">This sample verifier runs in the wallet page. A real relying website must issue its own challenge and enforce its own authorization policy.</div></section>`
    : "";
  return `${pageHead("SIGN-IN WITH AGENT", "Choose what this site may ask for.", "A one-use, origin-bound request is signed by your wallet. Permission is explicit and expires quickly.")}
    <div class="grid-main"><div class="stack"><section class="panel"><div class="panel-head"><div><h2>Permission request</h2><p class="panel-copy">Only the exact origin receives this consent proof.</p></div><span class="status-tag pending">REVIEW REQUIRED</span></div>
      <form id="permission-form"><div class="field"><label for="request-origin">Website origin</label><input class="control" id="request-origin" type="url" required value="${esc(location.origin)}"/><small>Use an origin only: scheme, host and optional port. No paths or wildcard hosts.</small></div><p class="scope-label">REQUESTED CAPABILITIES</p><div class="scope-list">${scopes}</div>${setupFormError()}<button class="button" type="submit">Review and sign selection</button></form>
      </section>${result}</div><aside class="stack"><section class="panel"><div class="panel-head"><div><p class="mini-label">WHAT GETS SIGNED</p><h3>One site. A few actions. A short expiry.</h3></div></div><div class="metric-line"><span>Origin</span><strong>Exact match</strong></div><div class="metric-line"><span>Challenge</span><strong>One use</strong></div><div class="metric-line"><span>Lifetime</span><strong>60 seconds</strong></div><div class="metric-line"><span>Capabilities</span><strong>Only selected</strong></div></section><section class="panel"><p class="panel-copy">The signature proves this wallet approved a request. It does not prove a human reviewed it unless a human actually confirms the selection.</p></section></aside></div>`;
}

function externalPermissionView() {
  const request = state.externalRequest;
  const displayOrigin = request.audience;
  if (!state.wallet) {
    return `${pageHead("SITE WALLET REQUEST", "Create or restore your wallet.", `${displayOrigin} is requesting a signed agent identity. The wallet key stays in this browser.`)}
      <section class="panel"><p class="mini-label">REQUESTING SITE</p><h2>${esc(displayOrigin)}</h2><p class="panel-copy">Requested capabilities: ${request.capabilities.map(esc).join(", ")}</p>${setupFormError()}<button class="button" data-go-wallet>Continue to wallet setup</button></section>`;
  }
  if (state.externalStatus === "sent") {
    const grant = state.consent?.body?.payload;
    const renewalPanel = state.renewal
      ? `<section class="panel" id="renewal-panel"><p class="mini-label">RENEWAL REQUESTED</p><h2>Keep ${esc(displayOrigin)} connected?</h2><p class="panel-copy">The site asks for another ${esc(durationText(Math.min(sessionLimits(state.renewal).maxSessionTtlMs, DEFAULT_SESSION_TTL_MS)))} session with the same capabilities: ${esc(state.renewal.capabilities.join(", "))}. Renewing never adds capabilities.</p><div class="button-row"><button class="button" id="approve-renewal">Renew session</button><button class="button quiet" id="decline-renewal">Decline</button></div></section>`
      : "";
    return `${pageHead("CONSENT SENT", "Return to the requesting site.", "The signed proof was sent to the site that opened this wallet. You can close this tab.")}
      <section class="panel"><p class="mini-label">APPROVED SITE</p><h2>${esc(displayOrigin)}</h2><p class="panel-copy">Approved capabilities: ${esc(grant?.capabilities?.join(", ") ?? "")}</p><div class="metric-line"><span>Session expires</span><strong id="session-expiry">${esc(dateText(grant?.expiresAt))} (<span id="session-countdown">${esc(remainingText(grant?.expiresAt))}</span> left)</strong></div>${grant?.idleTimeoutMs ? `<div class="metric-line"><span>Idle timeout</span><strong>${esc(durationText(grant.idleTimeoutMs))}</strong></div>` : `<p class="help">Legacy short session from a site on an older SDK; it cannot be renewed.</p>`}<div class="button-row top-gap"><button class="button quiet" id="end-session">End session now</button></div></section>${renewalPanel}`;
  }
  if (state.externalStatus === "rejected") {
    return `${pageHead("REQUEST DECLINED", "The site stays disconnected.", "No identity or permission proof was shared.")}
      <section class="panel"><p class="mini-label">REQUESTING SITE</p><h2>${esc(displayOrigin)}</h2></section>`;
  }
  if (state.externalStatus === "idle") {
    return `${pageHead("SESSION ENDED", "Return to the requesting site.", "This session ended after a period without activity. Start a new connection from the site.")}
      <section class="panel"><p class="mini-label">IDLE SESSION</p><h2>${esc(displayOrigin)}</h2></section>`;
  }
  if (state.externalStatus === "expired") {
    const ended = Boolean(state.consent);
    return `${pageHead(ended ? "SESSION EXPIRED" : "REQUEST EXPIRED", "Return to the requesting site.", ended ? "The approved session reached its expiry. Start a new connection from the site." : "This one-use request has expired. Start a new connection from the site.")}
      <section class="panel"><p class="mini-label">${ended ? "EXPIRED SESSION" : "EXPIRED REQUEST"}</p><h2>${esc(displayOrigin)}</h2></section>`;
  }
  const scopes = request.capabilities
    .map((capability) => {
      const [, title, detail] = capabilityOptions.find(
        ([id]) => id === capability,
      ) ?? [capability, capability, "This site will enforce this operation."];
      return `<label class="checkbox-row"><input type="checkbox" name="external-capability" value="${esc(capability)}"/><span><strong>${esc(title)}</strong><small><code>${esc(capability)}</code> · ${esc(detail)}</small></span></label>`;
    })
    .join("");
  return `${pageHead("EXTERNAL SITE REQUEST", "Review before you sign.", "The wallet will send a public identity and only the capabilities you select. Your private key never leaves this browser.")}
    <div class="grid-main"><section class="panel"><div class="panel-head"><div><p class="mini-label">REQUESTING SITE</p><h2>${esc(displayOrigin)}</h2><p class="panel-copy">This request expires at ${esc(dateText(request.expiresAt))}. It is valid only for this exact origin and this one connection attempt.</p></div><span class="status-tag pending">REVIEW REQUIRED</span></div>
      <form id="external-permission-form"><p class="scope-label">REQUESTED CAPABILITIES</p><div class="scope-list">${scopes}</div>${request.version === 1 ? `<p class="help">This site uses an older AI Auth SDK, so this connection lasts only until ${esc(dateText(request.expiresAt))} (under two minutes). Ask the site to upgrade for longer sessions.</p>` : ""}<div class="field"${request.version === 1 ? " hidden" : ""}><label for="session-ttl">Session lasts</label><select class="control" id="session-ttl" name="session-ttl">${sessionTtlChoices(
        request,
      )
        .map(
          (ms) =>
            `<option value="${ms}"${ms === Math.min(sessionLimits(request).maxSessionTtlMs, DEFAULT_SESSION_TTL_MS) ? " selected" : ""}>${esc(durationText(ms))}</option>`,
        )
        .join(
          "",
        )}</select><small>The session ends at this time or after ${esc(durationText(Math.min(sessionLimits(request).maxIdleTimeoutMs, sessionLimits(request).maxSessionTtlMs)))} without activity. The site must ask you again to renew it.</small></div>${setupFormError()}<div class="button-row"><button class="button" type="submit">Sign selected capabilities</button><button class="button quiet" type="button" id="reject-external-request">Decline</button></div></form>
    </section><aside class="stack"><section class="panel"><div class="panel-head"><div><p class="mini-label">YOUR KEY STAYS HERE</p><h3>Only a signed proof leaves this tab</h3></div></div><p class="panel-copy">The requesting site receives your public key and approved scopes. A signature proves control of this wallet; the site still enforces its own permissions.</p></section></aside></div>`;
}

function walletRequired() {
  return `<section class="empty-state"><h3>Create or restore a wallet first</h3><p>The wallet key is needed to sign permission proofs and delegate capabilities.</p><button class="button" data-go-wallet>Open identity setup</button></section>`;
}

function permissionsView() {
  if (!state.wallet)
    return `${pageHead("DELEGATION", "Grant a peer a narrow capability.", "Create a wallet-signed delegation record. A site must choose whether it trusts and enforces the grant.")}${walletRequired()}`;
  return `${pageHead("SCOPED DELEGATION", "Grant only what the peer needs.", "The grant names a recipient, resource, operation list and expiry. It is signed by this wallet and independently verifiable.")}
    <div class="grid-main"><section class="panel"><div class="panel-head"><div><h2>New capability grant</h2><p class="panel-copy">This wallet is the grant issuer. Revocation is not distributed by this MVP; use short expiries.</p></div><span class="status-tag pending">EXPLICIT SCOPE</span></div>
      <form id="grant-form"><div class="field"><label for="grant-recipient">Recipient agent ID</label><input class="control" id="grant-recipient" required placeholder="agent: public key fingerprint"/></div><div class="field"><label for="grant-resource">Resource</label><input class="control" id="grant-resource" required maxlength="512" placeholder="site:example.com/room:research"/></div><div class="field"><label for="grant-capabilities">Allowed operations</label><input class="control" id="grant-capabilities" required placeholder="messages.send, presence.read"/><small>Comma-separated names. Wildcards are rejected.</small></div><div class="field"><label for="grant-hours">Expires in hours</label><input class="control" id="grant-hours" type="number" min="1" max="720" value="24" required/></div>${setupFormError()}<button class="button" type="submit">Sign delegation</button></form>
    </section><aside class="stack"><section class="panel"><div class="panel-head"><div><p class="mini-label">AUTHORITY BOUNDARY</p><h3>Wallet signature is not site permission</h3></div></div><p class="panel-copy">The site owning the resource must trust this grant issuer, verify the recipient and scope, apply expiry, and check revocation policy before acting.</p></section><section id="grant-result"></section></aside></div>`;
}

function peerRows() {
  const peers = [...(state.room?.peers.values() ?? [])];
  if (!peers.length)
    return `<div class="empty-state"><h3>No other agents here yet</h3><p>Keep public presence on and connect another wallet to this site's shared space. Public Nostr relays coordinate discovery.</p></div>`;
  return `<div class="event-list">${peers.map((peer) => `<div class="peer-chip"><div><strong>${esc(peer.name)}</strong><code>${esc(peer.id)}</code><small class="help">Session ${esc(peer.session.slice(0, 8))} · verified signed presence</small></div><button class="button quiet small" type="button" data-grant-peer="${esc(peer.id)}">Grant</button></div>`).join("")}</div>`;
}

function connectPeerView() {
  if (!state.wallet)
    return `${pageHead("DIRECT CONNECTION", "Connect two agent wallets.", "Approve presence sharing to discover wallets on this page. Signed messages travel over direct peer connections.")}${walletRequired()}`;
  const msgs =
    state.messages
      .map(
        (message) =>
          `<div class="message-item ${message.direction === "in" ? "remote" : ""}">${esc(message.text)}<span class="message-meta">${message.direction === "in" ? `Verified ${esc(shortId(message.issuer))}` : "Signed by this wallet"} · ${esc(dateText(message.at))}</span></div>`,
      )
      .join("") ||
    `<p class="help">No signed messages yet. Connect a peer to begin.</p>`;
  return `${pageHead("PEER CONNECTION", "Find agents on this site.", "Public Nostr relays coordinate discovery. Once paired, signed events travel over direct WebRTC data channels.")}
    <div class="stack"><section class="panel"><div class="panel-head"><div><h2>Agent presence</h2><p class="panel-copy">Wallets connected to this site's public space can discover one another. Private mode receives room events but advertises no presence.</p></div><button class="button ${state.privateMode ? "" : "secondary"} small" id="toggle-private" aria-pressed="${state.privateMode}">${state.privateMode ? "Go public" : "Go private"}</button></div><div class="metric-line"><span>Local wallet</span><strong>${esc(state.wallet.name)}</strong></div><div class="metric-line"><span>Visibility</span><strong>${state.privateMode ? "Private" : "Public site space"}</strong></div><div class="metric-line"><span>Peer sessions</span><strong>${state.room?.peers.size ?? 0}</strong></div>${peerRows()}</section>
    <div class="grid-main"><section class="panel"><div class="panel-head"><div><h2>Signed messages</h2><p class="panel-copy">Received messages are accepted only after their signature, expiry, origin and replay nonce pass verification.</p></div></div><div class="message-list" id="message-list" aria-live="polite">${msgs}</div><form id="message-form" class="split-form"><div class="field"><label for="peer-message">Message to connected peers</label><input class="control" id="peer-message" maxlength="3000" required placeholder="Write a short message" ${state.privateMode ? "disabled" : ""}/></div><button class="button" type="submit" ${state.privateMode ? "disabled" : ""}>Send signed</button></form></section>
      <section class="panel"><div class="panel-head"><div><h2>Connection details</h2><p class="panel-copy">The browser exchanges discovery metadata through public Nostr relays, then opens a direct WebRTC channel for peer events.</p></div></div><div class="metric-line"><span>Discovery</span><strong>Nostr relays</strong></div><div class="metric-line"><span>Peer data</span><strong>Direct WebRTC</strong></div><div class="callout">No TURN relay is configured. Some restrictive networks may not establish a direct connection. Public relay operators can observe room participation and timing.</div></section></div></div>`;
}

function activityView() {
  if (!state.wallet)
    return `${pageHead("SIGNED ACTIVITY", "A local record of wallet actions.", "Activity entries are signed by this wallet and stay in this browser's IndexedDB.")}${walletRequired()}`;
  const entries = state.activity ?? [];
  return `${pageHead("SIGNED ACTIVITY", "Your activity, with proof.", "Entries are stored locally and signed individually. They are verifiable records, not tamper-proof storage; browser data can still be deleted.")}
    <section class="panel"><div class="panel-head"><div><h2>Wallet history</h2><p class="panel-copy">${entries.length} signed entries on this browser</p></div><button class="button secondary small" id="refresh-activity">Refresh</button></div>${
      entries.length
        ? `<div class="event-list">${entries
            .slice()
            .reverse()
            .map(
              (entry) =>
                `<div class="event-row"><span class="event-icon" aria-hidden="true"></span><div><div class="event-title">${esc(entry.body.type)}</div><div class="event-detail">${esc(JSON.stringify(entry.body.payload))}</div><div class="event-detail">Signature ${entry.verified ? "verified" : "invalid"} · ${esc(shortId(entry.body.issuer))}</div></div><time class="event-time">${esc(dateText(entry.body.createdAt))}</time></div>`,
            )
            .join("")}</div>`
        : `<div class="empty-state"><h3>No signed activity yet</h3><p>Creating a wallet, approving a request, granting a capability and sending a message will add signed entries here.</p></div>`
    }</section>`;
}

async function render() {
  const root = $("#view");
  if (state.view === "overview" && state.wallet)
    state.activity = await readActivity();
  if (state.view === "activity" && state.wallet) {
    const stored = await readActivity();
    state.activity = await Promise.all(
      stored.map(async (entry) => ({
        ...entry,
        verified: await verifyEnvelope(entry, {
          expectedIssuer: state.wallet.id,
          maxAgeMs: 20 * 365 * 24 * 60 * 60 * 1000,
        }),
      })),
    );
  }
  $("#view-label").textContent = state.view.toUpperCase();
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#topbar-status").innerHTML =
    `<span class="state-dot" aria-hidden="true"></span><span>${state.wallet ? esc(shortId(state.wallet.id)) : "Wallet not created"}</span>`;
  root.setAttribute("aria-busy", "true");
  root.innerHTML =
    state.view === "overview"
      ? overviewView()
      : state.view === "wallet"
        ? walletView()
        : state.view === "connect"
          ? connectView()
          : state.view === "permissions"
            ? permissionsView()
            : state.view === "activity"
              ? activityView()
              : connectPeerView();
  root.setAttribute("aria-busy", "false");
  bindView();
}

function downloadJson(filename, text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let roomGeneration = 0;
async function startRoom() {
  const generation = ++roomGeneration;
  const oldRtc = state.rtc;
  const oldRoom = state.room;
  state.rtc = null;
  state.room = null;
  state.transfers?.close();
  state.transfers = null;
  await oldRtc?.close();
  await oldRoom?.close();
  if (
    generation !== roomGeneration ||
    (externalConnectMode && state.consent && !externalSessionActive())
  )
    return;
  const external =
    externalConnectMode && state.externalRequest && state.consent;
  const roomName = external
    ? (state.externalRequest.room ?? "default")
    : "default";
  const roomOrigin = external ? state.externalOrigin : location.origin;
  const capabilities = external
    ? state.consent.body.payload.capabilities
    : ["presence.read", "messages.send", "tools.invoke"];
  // Private mode joins as a silent participant: it receives room events but
  // advertises no presence or cursor. Its actions stay signed and audited.
  state.room = new P2PRoom(state.wallet, roomName, {
    privateMode: state.privateMode,
    origin: roomOrigin,
    capabilities,
  });
  state.room.subscribe(({ direction, envelope, message }) => {
    debug("room-event", { direction, type: envelope?.body?.type });
    if (direction === "error") {
      toast(message);
      return;
    }
    const type = envelope?.body?.type;
    if (type === "peer/heartbeat") {
      if (state.view === "overview") {
        const peerCount = $("#overview-peer-count");
        if (peerCount)
          peerCount.textContent = String(state.room?.peers.size ?? 0);
      }
      return;
    }
    const refreshPeerView =
      type === "peer/hello" ||
      type === "peer/goodbye" ||
      type === "message/text" ||
      type === "presence/cursor";
    if (type === "message/text") {
      state.messages.push({
        direction,
        text: String(envelope.body.payload.text ?? ""),
        issuer: envelope.body.issuer,
        at: envelope.body.createdAt,
      });
      if (state.messages.length > 100) state.messages.shift();
    }
    if (
      externalConnectMode &&
      direction === "in" &&
      !type?.startsWith("collab/") &&
      externalSessionActive() &&
      state.externalSource === externalHost &&
      state.externalOrigin === state.externalRequest?.audience
    ) {
      const payload = envelope.body.payload;
      const targetedRequest =
        type === "agent/action" &&
        ["tool-request", "tool-cancel"].includes(payload?.kind);
      const routeMatches =
        payload?.targetWallet === state.wallet?.id &&
        payload?.targetNonce === state.externalRequest?.nonce &&
        payload?.targetSession === state.room?.session;
      if (!targetedRequest || routeMatches) {
        if (!["peer/hello", "peer/goodbye", "presence/cursor"].includes(type))
          state.lease?.touch();
        externalHost.postMessage(
          { type: "ai-auth/collaboration-event", envelope },
          state.externalOrigin,
        );
        debug(
          targetedRequest
            ? `${payload.kind}-forwarded-to-target-site`
            : "event-forwarded-to-site",
          type,
        );
      }
    }
    if (
      direction === "in" &&
      type &&
      type !== "collab/attachment" &&
      !(
        type === "agent/action" &&
        [
          "tool-request",
          "tool-cancel",
          "tool-response",
          "tool-catalog",
        ].includes(envelope.body.payload?.kind)
      )
    ) {
      void appendActivity(
        state.wallet,
        `peer/received-${type.split("/").at(-1)}`,
        { issuer: envelope.body.issuer, payload: envelope.body.payload },
      )
        .then(async () => {
          if (state.view === "overview") state.activity = await readActivity();
          if (state.view === "overview") await render();
          else if (state.view === "peer" && refreshPeerView) await render();
        })
        .catch(() => {});
    } else if (
      state.view === "overview" ||
      (state.view === "peer" && (refreshPeerView || direction === "state"))
    ) {
      void render();
    }
  });
  if (external) {
    // Collaboration transfers stay fail-closed to the issuer that was actually
    // approved: the authorization gate keeps verifying that the active signed
    // consent still belongs to the same verified wallet identity.
    const approvedIssuer = state.consent.body.issuer;
    state.transfers = new CollaborationTransfers(state.room, {
      authorize: () =>
        externalSessionActive() &&
        typeof state.consent?.body?.issuer === "string" &&
        state.consent.body.issuer === approvedIssuer,
    });
    state.transfers.subscribe((transfer) => {
      if (
        state.externalStatus === "sent" &&
        state.consent?.body?.payload?.expiresAt > Date.now()
      )
        state.externalSource.postMessage(
          { type: "ai-auth/transfer-event", transfer },
          state.externalOrigin,
        );
    });
  }
  if (externalConnectMode) {
    state.rtc = new NostrWebRTC(state.room, {
      origin: roomOrigin,
      room: roomName,
      onDiagnostic: (event) => debug("p2p-diagnostic", event),
      onStatus: (status) => {
        state.externalStatusText = status;
        const topbar = $("#topbar-status span:last-child");
        if (topbar) topbar.textContent = status;
      },
    });
  } else {
    state.rtc = new NostrWebRTC(state.room, {
      origin: location.origin,
      room: "default",
      onDiagnostic: (event) => debug("p2p-diagnostic", event),
      onStatus: (status) => {
        const topbar = $("#topbar-status span:last-child");
        if (topbar) topbar.textContent = status;
      },
    });
  }
  const rtc = state.rtc;
  const room = state.room;
  await rtc.start();
  if (generation !== roomGeneration || (external && !externalSessionActive())) {
    await rtc.close();
    await room.close();
    return;
  }
  if (externalConnectMode) {
    state.externalRoomReady = true;
    if (externalHost && externalSessionActive())
      externalHost.postMessage(
        {
          type: "ai-auth/room-ready",
          requestNonce: state.externalRequest.nonce,
          walletId: state.wallet.id,
          session: state.room.session,
          // This wallet signs `target`/`messageId` into the payload and
          // forwards verified receipts; older wallets do not say so.
          features: { targets: true, receipts: true },
        },
        state.externalOrigin,
      );
    for (const message of state.externalPendingEvents.splice(0))
      await handleExternalSiteEvent(message);
  }
}

function bindView() {
  rootViewButtons();
  $("#create-wallet-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    const data = new FormData(event.currentTarget);
    if (data.get("passphrase") !== data.get("confirmation"))
      return fail(new Error("Recovery passphrases do not match"));
    try {
      state.wallet = await createWallet({
        name: data.get("name"),
        passphrase: data.get("passphrase"),
      });
      downloadJson(
        "ai-auth-wallet-recovery.json",
        downloadBackup(state.wallet),
      );
      await appendActivity(state.wallet, "wallet/created", {
        name: state.wallet.name,
        publicIdentity: state.wallet.id,
      });
      if (!externalConnectMode) await startRoom();
      state.view = state.externalRequest ? "connect" : "wallet";
      if (externalConnectMode && state.externalRequest) {
        state.externalRequestReceived = false;
        externalHost.postMessage(
          { type: "ai-auth/connect-ready" },
          state.externalOrigin,
        );
      }
      render();
      toast("Wallet created. Save the encrypted recovery file.");
    } catch (error) {
      fail(error);
    }
  });
  $("#import-wallet-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    const file = $("#backup-file").files?.[0];
    if (!file) return fail(new Error("Choose a recovery file first"));
    try {
      state.wallet = await importWalletBackup(
        await file.text(),
        $("#restore-passphrase").value,
      );
      if (!externalConnectMode) await startRoom();
      state.view = state.externalRequest ? "connect" : "wallet";
      if (externalConnectMode && state.externalRequest) {
        state.externalRequestReceived = false;
        externalHost.postMessage(
          { type: "ai-auth/connect-ready" },
          state.externalOrigin,
        );
      }
      render();
      toast("Wallet restored in this browser.");
    } catch (error) {
      fail(error);
    }
  });
  $("#download-backup")?.addEventListener("click", () =>
    downloadJson("ai-auth-wallet-recovery.json", downloadBackup(state.wallet)),
  );
  $("#copy-agent-id")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.wallet.id);
    toast("Public identity copied.");
  });
  $("#forget-wallet")?.addEventListener("click", async () => {
    if (
      !window.confirm(
        "Remove this wallet and its local activity? This cannot be undone without the recovery file.",
      )
    )
      return;
    await state.room?.close();
    await forgetWallet();
    state.wallet = null;
    state.room = null;
    state.activity = [];
    render();
    toast("Wallet removed from this browser.");
  });
  $("#permission-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    state.consent = null;
    try {
      const originField = $("#request-origin");
      const origin = new URL(originField.value).origin;
      if (origin !== originField.value)
        throw new Error("Enter an exact origin with no path or wildcard");
      const requested = [
        ...event.currentTarget.querySelectorAll(
          "input[name=capability]:checked",
        ),
      ].map((input) => input.value);
      const request = await createPermissionRequest(origin, requested);
      if (!(await verifyPermissionRequest(request, { expectedOrigin: origin })))
        throw new Error("Demo website challenge failed verification");
      const approval = await approvePermissionRequest(
        state.wallet,
        request,
        requested,
      );
      const guard = new NonceGuard();
      const verified = await verifyPermissionConsent(approval, request, {
        expectedOrigin: origin,
        expectedWallet: state.wallet.id,
        nonceGuard: guard,
      });
      if (!verified)
        throw new Error(
          "Signed approval did not pass the demo website verifier",
        );
      if (
        await verifyPermissionConsent(approval, request, {
          expectedOrigin: origin,
          expectedWallet: state.wallet.id,
          nonceGuard: guard,
        })
      )
        throw new Error("Replay defense did not reject a duplicate approval");
      state.request = request;
      state.consent = approval;
      await appendActivity(state.wallet, "connect/consent-created", {
        origin,
        capabilities: requested,
        expiresAt: request.expiresAt,
      });
      render();
    } catch (error) {
      fail(error);
    }
  });
  $("#external-permission-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    try {
      if (!state.wallet)
        throw new Error("Create or restore a wallet before connecting");
      if (state.externalStatus || !state.externalRequest)
        throw new Error("This wallet request is no longer active");
      if (!externalHost || state.externalSource !== externalHost)
        throw new Error("The requesting site tab is no longer available");
      const approved = [
        ...event.currentTarget.querySelectorAll(
          "input[name=external-capability]:checked",
        ),
      ].map((input) => input.value);
      if (!approved.length)
        throw new Error(
          "Select at least one capability or decline the request",
        );
      const consent = await approvePermissionRequest(
        state.wallet,
        state.externalRequest,
        approved,
        {
          // The descriptor fields are self-declared claims, not attestations.
          ...(state.externalRequest.version === 1
            ? {}
            : {
                agent: {
                  instanceId: pageInstanceId,
                  agentType: "ai-auth-wallet",
                  runtime: { name: "ai-auth-wallet-page" },
                },
              }),
          sessionTtlMs:
            state.externalRequest.version === 1
              ? undefined
              : Number(
                  event.currentTarget.querySelector("#session-ttl")?.value,
                ),
        },
      );
      externalHost.postMessage(
        {
          type: "ai-auth/connect-consent",
          requestNonce: state.externalRequest.nonce,
          consent,
          // The identity id must match the signed consent issuer; the site
          // verifies it. The name is display-only peer labeling.
          wallet: { id: state.wallet.id, name: state.wallet.name },
        },
        state.externalOrigin,
      );
      state.consent = consent;
      state.lease = new SessionLease(consent.body.payload);
      state.externalStatus = "sent";
      clearTimeout(state.externalExpiryTimer);
      scheduleSessionExpiry();
      state.privateMode = false;
      state.externalRoomReady = false;
      void startRoom().catch((error) => {
        state.externalRoomReady = false;
        toast(
          `Permission was sent, but peer discovery failed: ${error.message}`,
        );
      });
      await appendActivity(state.wallet, "connect/external-consent", {
        origin: state.externalOrigin,
        capabilities: approved,
        expiresAt: consent.body.payload.expiresAt,
      });
      render();
    } catch (error) {
      fail(error);
    }
  });
  $("#approve-renewal")?.addEventListener("click", async () => {
    const renewal = state.renewal;
    try {
      if (!renewal || !externalSessionActive())
        throw new Error("This session is no longer active");
      const consent = await approvePermissionRequest(
        state.wallet,
        renewal,
        renewal.capabilities,
        {
          sessionTtlMs: Math.min(
            sessionLimits(renewal).maxSessionTtlMs,
            DEFAULT_SESSION_TTL_MS,
          ),
          previousConsent: state.consent,
        },
      );
      if (!state.lease.renew(consent.body.payload))
        throw new Error("This session is no longer active");
      externalHost.postMessage(
        {
          type: "ai-auth/renew-consent",
          requestNonce: renewal.nonce,
          consent,
        },
        state.externalOrigin,
      );
      state.consent = consent;
      state.renewal = null;
      scheduleSessionExpiry();
      await appendActivity(state.wallet, "connect/external-renewal", {
        origin: state.externalOrigin,
        capabilities: consent.body.payload.capabilities,
        expiresAt: consent.body.payload.expiresAt,
      });
      render();
    } catch (error) {
      fail(error);
    }
  });
  $("#decline-renewal")?.addEventListener("click", () => {
    if (state.renewal)
      externalHost?.postMessage(
        {
          type: "ai-auth/renew-rejected",
          requestNonce: state.renewal.nonce,
        },
        state.externalOrigin,
      );
    state.renewal = null;
    render();
  });
  $("#end-session")?.addEventListener("click", () => {
    expireExternalSession("ended");
  });
  $("#reject-external-request")?.addEventListener("click", () => {
    if (externalHost && state.externalSource === externalHost)
      externalHost.postMessage(
        {
          type: "ai-auth/connect-rejected",
          requestNonce: state.externalRequest?.nonce,
        },
        state.externalOrigin,
      );
    state.externalStatus = "rejected";
    clearTimeout(state.externalExpiryTimer);
    render();
  });
  $("#copy-consent")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(state.consent));
    toast("Signed consent copied.");
  });
  $("#new-request")?.addEventListener("click", () => {
    state.request = null;
    state.consent = null;
    state.error = "";
    render();
  });
  $("#grant-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    try {
      const input = {
        recipient: $("#grant-recipient").value.trim(),
        resource: $("#grant-resource").value.trim(),
        capabilities: $("#grant-capabilities")
          .value.split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        expiresAt:
          Date.now() + Number($("#grant-hours").value) * 60 * 60 * 1000,
      };
      const grant = await createCapabilityGrant(state.wallet, input);
      if (
        !(await verifyCapabilityGrant(grant, {
          expectedIssuer: state.wallet.id,
          expectedRecipient: input.recipient,
          resource: input.resource,
          requiredCapability: input.capabilities[0],
        }))
      )
        throw new Error("The signed grant failed local verification");
      await appendActivity(state.wallet, "capability/grant-issued", {
        recipient: input.recipient,
        resource: input.resource,
        capabilities: input.capabilities,
        expiresAt: input.expiresAt,
      });
      $("#grant-result").innerHTML =
        `<section class="panel"><div class="panel-head"><div><p class="mini-label">VERIFIED LOCALLY</p><h3>Signed grant</h3></div></div><div class="fingerprint">${esc(JSON.stringify(grant, null, 2))}</div><div class="button-row"><button class="button secondary small" id="copy-grant">Copy grant</button></div></section>`;
      $("#copy-grant").addEventListener("click", async () => {
        await navigator.clipboard.writeText(JSON.stringify(grant));
        toast("Signed grant copied.");
      });
    } catch (error) {
      fail(error);
    }
  });
  document.querySelectorAll("[data-grant-peer]").forEach((button) =>
    button.addEventListener("click", () => {
      state.view = "permissions";
      render().then(() => {
        $("#grant-recipient").value = button.dataset.grantPeer;
      });
    }),
  );
  $("#toggle-private")?.addEventListener("click", async () => {
    state.privateMode = !state.privateMode;
    state.rtc?.close();
    state.rtc = null;
    if (!externalConnectMode) await startRoom();
    render();
    toast(
      state.privateMode
        ? "Private mode is on. You receive room events but advertise no presence."
        : "Public site-space presence is on.",
    );
  });
  $("#message-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#peer-message").value.trim();
    if (!text) return;
    try {
      await state.room.send("message/text", { text });
      await appendActivity(state.wallet, "peer/message-sent", {
        text,
        room: "default",
      });
      render();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#refresh-activity")?.addEventListener("click", async () => {
    state.activity = await readActivity();
    render();
  });
  $("[data-go-wallet]")?.addEventListener("click", () => {
    state.view = "wallet";
    render();
  });
}

function externalSessionActive() {
  return state.externalStatus === "sent" && state.lease?.isActive() === true;
}

// One timer follows the earlier of grant expiry and idle deadline and
// re-checks the lease each time, so renewal and activity move it forward.
function scheduleSessionExpiry() {
  clearTimeout(state.sessionTimer);
  if (state.externalStatus !== "sent" || !state.lease) return;
  if (!state.lease.isActive()) {
    expireExternalSession(state.lease.status());
    return;
  }
  state.sessionTimer = setTimeout(
    scheduleSessionExpiry,
    Math.max(1, state.lease.deadline - Date.now()),
  );
}

function expireExternalSession(reason = "expired") {
  if (state.externalStatus !== "sent") return;
  clearTimeout(state.sessionTimer);
  state.lease?.revoke();
  state.renewal = null;
  if (externalHost && state.externalOrigin)
    externalHost.postMessage(
      {
        type: "ai-auth/session-ended",
        reason: ["idle", "ended"].includes(reason) ? reason : "expired",
      },
      state.externalOrigin,
    );
  roomGeneration++;
  state.externalStatus = reason === "idle" ? "idle" : "expired";
  state.externalRoomReady = false;
  state.externalPendingEvents.length = 0;
  state.transfers?.close();
  state.transfers = null;
  void state.rtc?.close();
  void state.room?.close();
  state.rtc = null;
  state.room = null;
  render();
}

async function handleExternalSiteEvent(data) {
  debug("site-event-received", data?.type);
  if (
    !state.externalRequest ||
    !state.consent ||
    !externalSessionActive() ||
    !state.room ||
    !data
  )
    return;
  const capabilities = state.consent.body.payload.capabilities;
  if (data.type === "ai-auth/site-cursor") {
    if (!capabilities.includes("presence.read")) return;
    const { x, y, visible = true, scroll } = data.cursor ?? {};
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 1 ||
      y < 0 ||
      y > 1 ||
      typeof visible !== "boolean"
    )
      return;
    // Only normalized coordinates and an optional scroll fraction are signed
    // and shared. Keystrokes, form values, passwords, and hidden page data are
    // never part of this event path.
    const payload = { x, y, visible, label: state.wallet.name };
    if (scroll !== undefined) {
      if (!Number.isFinite(scroll) || scroll < 0 || scroll > 1) return;
      payload.scroll = scroll;
    }
    await state.room.send("presence/cursor", payload);
    debug("wallet-signed-site-cursor");
    return;
  }
  if (data.type === "ai-auth/site-action") {
    if (!capabilities.includes("tools.invoke")) return;
    const action = data.action;
    if (
      !action ||
      typeof action.name !== "string" ||
      !/^[a-z][a-z0-9._-]{0,63}$/u.test(action.name) ||
      ![
        "started",
        "progress",
        "completed",
        "failed",
        "cancelled",
        "needs-human",
      ].includes(action.state) ||
      typeof action.summary !== "string" ||
      action.summary.length > 240
    )
      return;
    await state.room.send("agent/action", {
      name: action.name,
      state: action.state,
      summary: action.summary,
      label: state.wallet.name,
    });
    debug("wallet-signed-site-action", action.name);
    return;
  }
  if (data.type === "ai-auth/site-agent-event") {
    if (!capabilities.includes("tools.invoke")) return;
    const agentEvent = data.event;
    let wire;
    try {
      wire = JSON.stringify(agentEvent);
    } catch {
      return;
    }
    if (!wire || new TextEncoder().encode(wire).byteLength > 8_192) return;
    if (agentEvent?.kind === "tool-catalog") {
      if (!Array.isArray(agentEvent.tools) || agentEvent.tools.length > 32)
        return;
      for (const tool of agentEvent.tools) {
        if (
          typeof tool?.name !== "string" ||
          !/^[a-z][a-z0-9._-]{0,63}$/u.test(tool.name) ||
          typeof tool.description !== "string" ||
          tool.description.length > 240 ||
          tool.inputSchema?.type !== "object" ||
          !tool.inputSchema.properties ||
          typeof tool.inputSchema.properties !== "object"
        )
          return;
      }
      await state.room.send("agent/action", {
        kind: "tool-catalog",
        tools: agentEvent.tools,
        targetWallet: state.wallet.id,
        targetNonce: state.externalRequest.nonce,
        targetSession: state.room.session,
      });
      debug("wallet-signed-tool-catalog", agentEvent.tools.length);
      return;
    }
    if (agentEvent?.kind === "tool-response") {
      if (
        typeof agentEvent.requestId !== "string" ||
        !/^[A-Za-z0-9_-]{8,80}$/u.test(agentEvent.requestId) ||
        typeof agentEvent.toWallet !== "string" ||
        typeof agentEvent.toSession !== "string" ||
        agentEvent.toSession.length > 100
      )
        return;
      await state.room.send("agent/action", {
        kind: "tool-response",
        requestId: agentEvent.requestId,
        toWallet: agentEvent.toWallet,
        toSession: agentEvent.toSession,
        ...(Object.hasOwn(agentEvent, "result")
          ? { result: agentEvent.result }
          : {}),
        ...(typeof agentEvent.error === "string"
          ? { error: agentEvent.error.slice(0, 240) }
          : {}),
        targetWallet: state.wallet.id,
        targetNonce: state.externalRequest.nonce,
        targetSession: state.room.session,
      });
      debug("wallet-signed-tool-response", agentEvent.requestId);
    }
  }
}

function rootViewButtons() {
  document.querySelectorAll("#view [data-go-view]").forEach((button) =>
    button.addEventListener("click", () => {
      state.view = button.dataset.goView;
      state.error = "";
      render();
    }),
  );
}

if (externalConnectMode) {
  window.addEventListener("message", async (event) => {
    // A session that lapsed while no timer could fire (for example a sleeping
    // tab) is ended before any further message is honored.
    if (
      state.externalStatus === "sent" &&
      state.lease &&
      !state.lease.isActive()
    )
      expireExternalSession(state.lease.status());
    if (
      event.data?.type === "ai-auth/transfer-request" &&
      event.source === state.externalSource &&
      event.origin === state.externalOrigin &&
      event.origin === state.externalRequest?.audience &&
      state.externalStatus === "sent" &&
      state.consent?.body?.payload?.expiresAt > Date.now()
    ) {
      state.lease?.touch();
      const { id, method, args } = event.data;
      if (
        typeof id !== "string" ||
        id.length > 100 ||
        !Array.isArray(args) ||
        !["sendText", "sendElement", "sendAttachment"].includes(method)
      )
        return;
      try {
        if (!state.externalRoomReady || !state.transfers)
          throw new Error("Wallet peer connection is not ready");
        await state.transfers[method](...args);
        event.source.postMessage(
          { type: "ai-auth/transfer-result", id },
          event.origin,
        );
      } catch (error) {
        event.source.postMessage(
          {
            type: "ai-auth/transfer-result",
            id,
            error: String(error.message || "Transfer failed"),
          },
          event.origin,
        );
      }
      return;
    }
    if (
      event.source === externalHost &&
      event.origin === state.externalOrigin &&
      event.origin === state.externalRequest?.audience &&
      externalSessionActive() &&
      [
        "ai-auth/site-cursor",
        "ai-auth/site-action",
        "ai-auth/site-agent-event",
      ].includes(event.data?.type)
    ) {
      debug("opener-event-matched", event.data?.type);
      state.lease?.touch();
      if (!state.externalRoomReady) {
        if (state.externalPendingEvents.length < 32)
          state.externalPendingEvents.push(event.data);
        return;
      }
      try {
        await handleExternalSiteEvent(event.data);
      } catch (error) {
        toast(`Could not sign the site event: ${error.message}`);
      }
      return;
    }
    if (
      event.data?.type === "ai-auth/renew-request" &&
      event.source === externalHost &&
      event.origin === state.externalOrigin &&
      externalSessionActive()
    ) {
      const renewal = event.data.request;
      const current = state.consent.body.payload;
      const valid =
        (await verifyPermissionRequest(renewal, {
          expectedOrigin: state.externalOrigin,
          nonceGuard: renewalGuard,
        })) &&
        renewal.renews === current.requestNonce &&
        (renewal.room ?? "default") === (current.room ?? "default") &&
        renewal.capabilities.every((capability) =>
          current.capabilities.includes(capability),
        );
      if (!valid || !externalSessionActive()) {
        externalHost.postMessage(
          { type: "ai-auth/renew-rejected", requestNonce: renewal?.nonce },
          state.externalOrigin,
        );
        return;
      }
      state.renewal = renewal;
      state.view = "connect";
      render();
      return;
    }
    if (
      event.data?.type !== "ai-auth/connect-request" ||
      event.source !== externalHost ||
      state.externalRequestReceived
    )
      return;
    if (!(await verifyPopupPermissionRequest(event, externalHost))) {
      state.error =
        "The requesting site or its permission request could not be verified";
      render();
      return;
    }
    state.externalRequestReceived = true;
    if (!state.wallet)
      externalHost.postMessage({ type: "ai-auth/wallet-setup" }, event.origin);
    clearTimeout(state.externalExpiryTimer);
    state.request = event.data.request;
    state.externalRequest = event.data.request;
    state.externalOrigin = event.origin;
    state.externalSource = event.source;
    state.externalStatus = "";
    state.error = "";
    state.view = "connect";
    state.externalExpiryTimer = setTimeout(
      () => {
        if (state.externalStatus) return;
        state.externalStatus = "expired";
        state.error =
          "This request has expired. Start a new connection from the site.";
        render();
      },
      Math.max(0, event.data.request.expiresAt - Date.now()),
    );
    render();
  });
}

document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", async () => {
    state.view = button.dataset.view;
    state.error = "";
    render();
  }),
);

try {
  state.wallet = await loadWallet();
  if (state.wallet && !externalConnectMode) {
    if (!state.privateMode) await startRoom();
  }
  render();
  if (externalConnectMode && externalHost)
    externalHost.postMessage({ type: "ai-auth/connect-ready" }, "*");
} catch (error) {
  state.error = error.message;
  render();
}

setInterval(() => {
  const countdown = $("#session-countdown");
  if (countdown && state.consent?.body?.payload?.expiresAt)
    countdown.textContent = remainingText(state.consent.body.payload.expiresAt);
}, 1000);
