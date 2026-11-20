import { CollaborationTransfers } from "../../packages/p2p/collaboration.js";
import {
  WALLET_REQUIRED_MESSAGE,
  INLINE_WALLET_NOTICE,
  capabilityCopy,
  connectionStatusLabel,
  extendLabel,
  extensionPhrase,
  renewalKeptText,
  requestEndText,
  sessionEndText,
} from "../../packages/p2p/copy.js";
import { inlineCreateWalletForm } from "../../packages/p2p/wallet-setup-copy.js";
import { canResumeStoredSession } from "../../packages/p2p/resume-verification.js";
import {
  createGrantStore,
  indexedDbGrantAdapter,
} from "../../packages/p2p/grant-store.js";
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
import {
  TOOL_NAME_PATTERN,
  filterCatalogTools,
} from "../../packages/p2p/webmcp.js";

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
const urlParams = new URLSearchParams(location.search);
const urlRequestParam = urlParams.get("connect-request");
const consentCallbackParam = urlParams.get("callback");
// A local MCP server may open this wallet and ask for the signed consent back
// on a loopback URL. Never post a consent to an arbitrary origin.
function trustedCallback(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.href;
    if (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      return url.href;
  } catch {}
  return null;
}
const consentCallback = trustedCallback(consentCallbackParam);

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
  consentCallback: null,
  externalExpiryTimer: null,
  lease: null,
  renewal: null,
  sessionTimer: null,
  messages: [],
  grants: [],
  privateMode: true,
  externalRoomReady: false,
  externalPendingEvents: [],
  error: "",
  connectionLabel: "",
  // Set synchronously at the start of wallet create/restore so a second
  // submit cannot generate a second key or download a second recovery file.
  submitting: false,
  // Guards the private/public toggle while startRoom tears down the old room.
  togglingPrivate: false,
  // Distinguishes "you ended" from "the site ended" on the ended view.
  endedBySite: false,
};
// Approved grants are durable in the wallet origin, so a wallet reload can
// still confirm a resume. The adapter is a thin IndexedDB wrapper.
const grantStore = createGrantStore({ adapter: indexedDbGrantAdapter() });
const capabilityOptions = [
  "presence.read",
  "messages.send",
  "content.share",
  "tools.invoke",
].map((id) => [id, capabilityCopy(id).title, capabilityCopy(id).detail]);
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
  if (ms === null) return "Never";
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
// Session choices in ms, with null as "Never". Never is offered only when the
// site did not cap the session; a site's numeric cap bounds every choice.
function sessionTtlChoices(request) {
  const { maxSessionTtlMs } = sessionLimits(request);
  const timed = new Set(
    [5, 15, 30, 60]
      .map((minutes) => minutes * 60_000)
      .filter((ms) => maxSessionTtlMs === null || ms <= maxSessionTtlMs),
  );
  if (maxSessionTtlMs !== null) timed.add(maxSessionTtlMs);
  const sorted = [...timed].sort((a, b) => a - b);
  return maxSessionTtlMs === null ? [...sorted, null] : sorted;
}
// The wallet pre-selects Never when the site allows it, otherwise the usual
// 30 minutes or the site's cap, whichever is shorter.
function defaultSessionTtl(limits) {
  return limits.maxSessionTtlMs === null
    ? null
    : Math.min(limits.maxSessionTtlMs, DEFAULT_SESSION_TTL_MS);
}
function parseSessionTtl(value) {
  return value === "never" ? null : Number(value);
}
function sessionLimitCopy(request) {
  return "Choose how long this session may last. Shorter sessions also end after the idle time shown, up to 10 minutes. Never has no time or idle limit: the session stays active and resumable after a refresh until you end it or the site stops it.";
}
// A grant with no fixed end (Never) stays open until it is ended or revoked.
function grantOpen(payload) {
  return (
    Boolean(payload) &&
    (payload.expiresAt === null || payload.expiresAt > Date.now())
  );
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
  // There is deliberately no create form here. An identity is created because
  // a site asks an agent to connect (the inline request screen), never on its
  // own. This page only restores an identity that already exists.
  return `${pageHead("NO WALLET YET", "Identities are created for agents, not on demand.", "Agents create their own identity in their own encrypted keystore. An owner wallet is created when a site asks you to approve its tools, right inside that request. There is nothing to set up here in advance.")}
    <div class="grid-main">
      <section class="panel">
        <div class="panel-head"><div><h2>Start with an agent</h2><p class="panel-copy">Share a connect link. The agent joins with its own self-custodied identity and you watch it work. No wallet is needed for this.</p></div><span class="status-tag pending">AGENT FIRST</span></div>
        <div class="button-row"><a class="button" href="../connect-agent/">Connect an agent →</a></div>
        <form id="import-wallet-form" class="stack form-separated">
          <div><h3>Restore an existing wallet</h3><p class="panel-copy">Only for an identity you already own. Import its encrypted AI Auth recovery file and passphrase.</p></div>
          <div class="field"><label for="backup-file">Recovery file</label><input class="control" id="backup-file" type="file" accept="application/json,.json" required /></div>
          <div class="field"><label for="restore-passphrase">Recovery passphrase</label><input class="control" id="restore-passphrase" type="password" autocomplete="current-password" required /></div>
          ${setupFormError()}
          <button class="button secondary" type="submit">Unlock and restore</button>
        </form>
      </section>
      <aside class="stack">
        <section class="panel"><div class="panel-head"><div><p class="mini-label">WHEN A WALLET IS CREATED</p><h3>Only from a site request</h3></div></div><p class="panel-copy">When a site wants to connect an agent, its request screen creates the wallet and downloads the encrypted recovery file. That is the only time a new owner key is made.</p></section>
        <section class="panel"><div class="panel-head"><div><p class="mini-label">WHAT THIS OWNER KEY DOES</p><h3>Approves site capabilities</h3></div></div><p class="panel-copy">Your key signs the exact scopes you allow. A signature proves approval; the site still checks its own rules.</p><div class="metric-line"><span>Algorithm</span><strong>ECDSA · P-256</strong></div><div class="metric-line"><span>Storage</span><strong>This browser's storage</strong></div><div class="metric-line"><span>Account</span><strong>None</strong></div></section>
      </aside>
    </div>`;
}

function walletView() {
  if (!state.wallet) return walletSetupView();
  const id = state.wallet.id;
  const initial = String(state.wallet.name ?? "A")
    .charAt(0)
    .toUpperCase();
  const hue = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  const grants = state.grants ?? [];
  const activity = state.activity ?? [];
  const connections = grants.length
    ? grants
        .map(
          (grant) => `<div class="connection-card">
            <div class="connection-head"><span class="connection-orb" aria-hidden="true"></span><div><strong>${esc(grant.audience)}</strong><small>${esc(grant.room ?? "default")}</small></div><span class="status-tag"><span class="state-dot"></span> ACTIVE</span></div>
            <div class="cap-row">${(grant.capabilities ?? [])
              .map(
                (capability) =>
                  `<span class="cap-chip">${esc(capabilityCopy(capability).title)}</span>`,
              )
              .join("")}</div>
            <small class="help">${esc(sessionEndText(grant.expiresAt, Date.now()))}</small>
          </div>`,
        )
        .join("")
    : `<div class="empty-state"><h3>No connected sites</h3><p>A site appears here after it asks to connect an agent and you approve its permissions.</p><a class="button secondary small" href="../connect-agent/">Connect an agent →</a></div>`;
  const recent = activity.length
    ? activity
        .slice(-3)
        .reverse()
        .map(
          (entry) =>
            `<div class="event-row"><span class="event-icon" aria-hidden="true">✓</span><div><div class="event-title">${esc(entry.body.type)}</div><div class="event-detail">${esc(shortId(entry.body.issuer))}</div></div><time class="event-time">${esc(dateText(entry.body.createdAt))}</time></div>`,
        )
        .join("")
    : `<p class="panel-copy">No signed activity yet. Approving a site request adds the first entry.</p>`;

  return `${pageHead("OWNER KEY", "Your identity, at a glance.", "This key signs the capabilities you approve. Agents keep their own identity and do not need this key to connect.")}
    <div class="dashboard">
      <section class="account-card" style="--avatar-hue:${hue}">
        <div class="avatar" aria-hidden="true">${esc(initial)}</div>
        <div class="account-main"><p class="mini-label">OWNER IDENTITY</p><h2>${esc(state.wallet.name)}</h2><code class="account-id">${esc(id)}</code></div>
        <span class="status-tag"><span class="state-dot"></span> LOCAL KEY</span>
      </section>
      <div class="stat-grid">
        <div class="stat"><b>${grants.length}</b><span>connected sites</span></div>
        <div class="stat"><b>${state.room?.peers.size ?? 0}</b><span>agents nearby</span></div>
        <div class="stat"><b>${activity.length}</b><span>signed entries</span></div>
        <div class="stat"><b>ECDSA</b><span>P-256 · local</span></div>
      </div>
      <div class="grid-main">
        <div class="stack">
          <section class="panel"><div class="panel-head"><div><p class="mini-label">CONNECTIONS</p><h2>Where this key is used</h2><p class="panel-copy">Each entry is a signed approval for one exact site. Your key never leaves this browser.</p></div></div><div class="connection-list">${connections}</div></section>
          <section class="panel"><div class="panel-head"><div><p class="mini-label">RECENT ACTIVITY</p><h2>Signed by this key</h2></div><button class="button quiet small" data-go-view="activity">View all</button></div><div class="event-list">${recent}</div></section>
        </div>
        <aside class="stack">
          <section class="panel"><div class="panel-head"><div><p class="mini-label">QUICK ACTIONS</p><h2>What next?</h2></div></div><div class="overview-actions"><a class="button secondary" href="../connect-agent/">Connect an agent</a><button class="button secondary" data-go-view="connect">Review a request</button><button class="button secondary" data-go-view="permissions">Grant access</button><button class="button quiet" data-go-view="peer">Shared room</button></div></section>
          <section class="panel"><div class="panel-head"><div><p class="mini-label">KEY DETAILS</p><h3>Stored on this device</h3></div></div><div class="metric-line"><span>Created</span><strong>${esc(dateText(state.wallet.createdAt))}</strong></div><div class="metric-line"><span>Exportability</span><strong>Private key: no</strong></div><div class="button-row"><button class="button secondary small" id="download-backup">Download recovery file</button><button class="button quiet small" id="copy-agent-id">Copy ID</button></div></section>
          <section class="panel"><div class="danger-zone"><div><h3>Remove this key</h3><p>Clears the local key and activity. Restore from the recovery file later.</p></div><button class="button danger small" id="forget-wallet">Remove</button></div></section>
        </aside>
      </div>
    </div>`;
}

function overviewView() {
  // With a key present, the default page is the account dashboard.
  if (state.wallet) return walletView();
  const peers = state.room?.peers.size ?? 0;
  const activityCount = state.activity?.length ?? 0;
  const identity = state.wallet
    ? `<section class="panel"><div class="panel-head"><div><p class="mini-label">OWNER KEY</p><h2>${esc(state.wallet.name)}</h2><p class="panel-copy">This key signs the capabilities you approve. Agents keep their own identity.</p></div><span class="status-tag"><span class="state-dot"></span> READY</span></div><p class="panel-copy">Your owner key is saved in this browser.</p><code class="key-id">${esc(shortId(state.wallet.id))}</code></section>`
    : `<section class="panel"><div class="panel-head"><div><p class="mini-label">OWNER KEY · OPTIONAL</p><h2>No owner key yet</h2><p class="panel-copy">You do not need one to connect an agent. Agents create their own identity. An owner key is created inside a site request, only when a site asks you to approve its tools.</p></div><span class="status-tag pending">NOT CREATED</span></div><div class="button-row"><a class="button" href="../connect-agent/">Connect an agent →</a></div></section>`;
  return `${pageHead("OWNER CONSOLE", "Agents first. You approve when it matters.", "Watch agents connect with their own identities, and use this optional owner key only when a site asks you to approve its tools.")}
    ${identity}
    <div class="grid-main top-gap">
      <section class="panel"><p class="mini-label">CURRENT SESSION</p><h2>${state.privateMode ? "Private" : "Public collaboration"}</h2><p class="panel-copy">${state.privateMode ? "You receive room events but advertise no presence until you go public." : "Agents on this site's public space find one another through connection helpers."}</p><div class="metric-line"><span>Connection</span><strong id="connection-status">${esc(state.connectionLabel || "Not connected.")}</strong></div><div class="metric-line"><span>Connected peers</span><strong id="overview-peer-count">${peers}</strong></div><div class="metric-line"><span>Stored activity</span><strong>${activityCount}</strong></div><div class="callout top-gap">The website brings the agents together. Connection helpers only help them find each other; signed messages travel directly between wallets. No AI Auth server is involved.</div></section>
      <section class="panel"><p class="mini-label">QUICK ACTIONS</p><h2>What would you like to do?</h2><div class="overview-actions"><button class="button secondary" data-go-view="connect">Review a site request</button><button class="button secondary" data-go-view="permissions">Grant access</button><button class="button secondary" data-go-view="peer">Connect to an agent</button><button class="button quiet" data-go-view="activity">View signed activity</button></div></section>
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
    ? `<section class="panel"><div class="panel-head"><div><p class="mini-label">SIGNATURE VERIFIED</p><h2>Approval created</h2><p class="panel-copy">The wallet approved these permissions for ${esc(state.request.audience)}. The check confirmed the wallet, the site, the permissions and the lifetime you chose.</p></div><span class="status-tag"><span class="state-dot"></span> VERIFIED</span></div><div class="fingerprint">${esc(JSON.stringify(state.consent, null, 2))}</div><div class="button-row"><button class="button secondary" id="copy-consent">Copy signed approval</button><button class="button quiet" id="new-request">New request</button></div><div class="callout top-gap">This sample verifier runs in the wallet page. A real relying website must issue its own challenge and enforce its own authorization policy.</div></section>`
    : "";
  return `${pageHead("SIGN-IN WITH AGENT", "Choose what this site may ask for.", "A one-use, origin-bound request is signed by your wallet. Permission is explicit and lasts only as long as you choose.")}
    <div class="grid-main"><div class="stack"><section class="panel"><div class="panel-head"><div><h2>Permission request</h2><p class="panel-copy">Only this exact website receives the approval.</p></div><span class="status-tag pending">REVIEW REQUIRED</span></div>
      <form id="permission-form"><div class="field"><label for="request-origin">Website origin</label><input class="control" id="request-origin" type="url" required value="${esc(location.origin)}"/><small>Use an origin only: scheme, host and optional port. No paths or wildcard hosts.</small></div><p class="scope-label">REQUESTED PERMISSIONS</p><div class="scope-list">${scopes}</div>${setupFormError()}<button class="button" type="submit">Review and approve selection</button></form>
      </section>${result}</div><aside class="stack"><section class="panel"><div class="panel-head"><div><p class="mini-label">WHAT GETS SIGNED</p><h3>One site. A few actions. A short expiry.</h3></div></div><div class="metric-line"><span>Origin</span><strong>Exact match</strong></div><div class="metric-line"><span>Challenge</span><strong>One use</strong></div><div class="metric-line"><span>Lifetime</span><strong>60 seconds</strong></div><div class="metric-line"><span>Permissions</span><strong>Only selected</strong></div></section><section class="panel"><p class="panel-copy">The signature proves this wallet approved a request. It does not prove a human reviewed it unless a human actually confirms the selection.</p></section></aside></div>`;
}

function externalPermissionView() {
  const request = state.externalRequest;
  const displayOrigin = request.audience;
  if (!state.wallet) {
    return `${pageHead("SITE WALLET REQUEST", "Create your wallet to continue.", `${displayOrigin} wants to connect to your agent. Your wallet key stays in this browser.`)}
      <section class="panel"><p class="mini-label">REQUESTING SITE</p><h2>${esc(displayOrigin)}</h2><p class="panel-copy">Requested permissions: ${request.capabilities.map((capability) => esc(capabilityCopy(capability).title)).join(", ")}</p><p class="help">${INLINE_WALLET_NOTICE}</p></section>
      ${inlineCreateWalletForm({ error: state.error })}`;
  }
  if (state.externalStatus === "sent") {
    const grant = state.consent?.body?.payload;
    // The copy must name the lifetime the wallet will actually grant, which
    // can be a shorter site cap or Never rather than the 30-minute default.
    const renewalTtl = state.renewal
      ? defaultSessionTtl(sessionLimits(state.renewal))
      : null;
    const renewalPanel = state.renewal
      ? `<section class="panel" id="renewal-panel"><p class="mini-label">EXTENSION REQUESTED</p><h2>Keep ${esc(displayOrigin)} connected?</h2><p class="panel-copy">The site asks to extend your session ${esc(extensionPhrase(renewalTtl))} with the same permissions: ${esc(state.renewal.capabilities.map((capability) => capabilityCopy(capability).title).join(", "))}. Extending never adds permissions.</p><div class="button-row"><button class="button" id="approve-renewal">${esc(extendLabel(renewalTtl))}</button><button class="button quiet" id="decline-renewal">Don't allow</button></div></section>`
      : "";
    return `${pageHead("APPROVAL SENT", "Return to the requesting site.", "Your signed approval was sent to the site that opened this wallet. You can close this tab.")}
      <section class="panel"><p class="mini-label">APPROVED SITE</p><h2>${esc(displayOrigin)}</h2><p class="panel-copy">Approved permissions: ${esc((grant?.capabilities ?? []).map((capability) => capabilityCopy(capability).title).join(", "))}</p><div class="metric-line"><span>Session</span><strong id="session-countdown">${esc(sessionEndText(grant?.expiresAt))}</strong></div>${grant?.idleTimeoutMs !== undefined ? `<div class="metric-line"><span>Ends after inactivity</span><strong>${esc(durationText(grant.idleTimeoutMs))}</strong></div>` : `<p class="help">Legacy short session from a site on an older SDK; it cannot be renewed.</p>`}<div class="button-row top-gap"><button class="button quiet" id="end-session">End session</button></div></section>${renewalPanel}`;
  }
  if (state.externalStatus === "rejected") {
    return `${pageHead("REQUEST DECLINED", "The site stays disconnected.", "No identity or permission proof was shared.")}
      <section class="panel"><p class="mini-label">REQUESTING SITE</p><h2>${esc(displayOrigin)}</h2></section>`;
  }
  if (state.externalStatus === "idle") {
    return `${pageHead("SESSION ENDED", "Return to the requesting site.", "This session ended after a period without activity. Start a new connection from the site.")}
      <section class="panel"><p class="mini-label">IDLE SESSION</p><h2>${esc(displayOrigin)}</h2></section>`;
  }
  if (state.externalStatus === "ended") {
    const bySite = state.endedBySite === true;
    return `${pageHead("SESSION ENDED", "Return to the requesting site.", bySite ? "The site ended this session." : "You ended this session.")}
      <section class="panel"><p class="mini-label">${bySite ? "SITE ENDED SESSION" : "SESSION ENDED"}</p><h2>${esc(displayOrigin)}</h2></section>`;
  }
  if (state.externalStatus === "expired") {
    const ended = Boolean(state.consent);
    return `${pageHead(ended ? "SESSION EXPIRED" : "REQUEST EXPIRED", "Return to the requesting site.", ended ? "The approved session reached its expiry. Start a new connection from the site." : "This one-use request has expired. Start a new connection from the site.")}
      <section class="panel"><p class="mini-label">${ended ? "EXPIRED SESSION" : "EXPIRED REQUEST"}</p><h2>${esc(displayOrigin)}</h2></section>`;
  }
  const scopes = request.capabilities
    .map((capability) => {
      const { title, detail } = capabilityCopy(capability);
      return `<label class="checkbox-row"><input type="checkbox" name="external-capability" value="${esc(capability)}"/><span><strong>${esc(title)}</strong><small><code>${esc(capability)}</code> · ${esc(detail)}</small></span></label>`;
    })
    .join("");
  return `${pageHead("SITE REQUEST", "Review before you allow.", "Your wallet sends a public ID and only the permissions you allow. Your private key never leaves this browser.")}
    <div class="grid-main"><section class="panel"><div class="panel-head"><div><p class="mini-label">REQUESTING SITE</p><h2>${esc(displayOrigin)}</h2><p class="panel-copy">${esc(requestEndText(request.expiresAt))} It works only for this website and this one connection attempt.</p></div><span class="status-tag pending">REVIEW REQUIRED</span></div>
      <form id="external-permission-form"><p class="scope-label">REQUESTED PERMISSIONS</p><div class="scope-list">${scopes}</div>${request.version === 1 ? `<p class="help">This site uses an older version of the connection code, so this connection lasts only until ${esc(dateText(request.expiresAt))} (under two minutes). Ask the site to upgrade for longer sessions.</p>` : ""}<div class="field"${request.version === 1 ? " hidden" : ""}><label for="session-ttl">Session lasts</label><select class="control" id="session-ttl" name="session-ttl">${sessionTtlChoices(
        request,
      )
        .map(
          (ms) =>
            `<option value="${ms === null ? "never" : ms}"${ms === defaultSessionTtl(sessionLimits(request)) ? " selected" : ""}>${esc(durationText(ms))}</option>`,
        )
        .join(
          "",
        )}</select><small>${esc(sessionLimitCopy(request))}</small></div>${setupFormError()}<div class="button-row"><button class="button" type="submit">Allow selected permissions</button><button class="button quiet" type="button" id="reject-external-request">Don't allow</button></div></form>
    </section><aside class="stack"><section class="panel"><div class="panel-head"><div><p class="mini-label">YOUR KEY STAYS HERE</p><h3>Only your approval leaves this tab</h3></div></div><p class="panel-copy">The site receives your public ID and the permissions you allow. A signature proves you control this wallet; the site still enforces its own rules.</p></section></aside></div>`;
}

function walletRequired() {
  return `<section class="empty-state"><h3>No owner key in this browser</h3><p>An owner key is created when a site asks you to approve its tools. Agents create their own identity and do not need this.</p><a class="button" href="../connect-agent/">Connect an agent →</a></section>`;
}

function permissionsView() {
  if (!state.wallet)
    return `${pageHead("GRANT ACCESS", "Grant another agent limited access.", "Create a signed record that gives another agent limited access. The site decides whether to honor it.")}${walletRequired()}`;
  return `${pageHead("LIMITED ACCESS", "Grant only what the other agent needs.", "The grant names who receives it, what it covers and when it ends. Your wallet signs it, and anyone can check the signature.")}
    <div class="grid-main"><section class="panel"><div class="panel-head"><div><h2>New access grant</h2><p class="panel-copy">This wallet issues the grant. Cancelling a grant is not supported yet, so use short expiry times.</p></div><span class="status-tag pending">EXPLICIT SCOPE</span></div>
      <form id="grant-form"><div class="field"><label for="grant-recipient">Other agent's ID</label><input class="control" id="grant-recipient" required placeholder="Paste their agent ID"/></div><div class="field"><label for="grant-resource">What it can use</label><input class="control" id="grant-resource" required maxlength="512" placeholder="site:example.com/room:research"/></div><div class="field"><label for="grant-capabilities">Allowed actions</label><input class="control" id="grant-capabilities" required placeholder="messages.send, presence.read"/><small>Separate with commas. Wildcards are not allowed.</small></div><div class="field"><label for="grant-hours">Ends in hours</label><input class="control" id="grant-hours" type="number" min="1" max="720" value="24" required/></div>${setupFormError()}<button class="button" type="submit">Sign grant</button></form>
    </section><aside class="stack"><section class="panel"><div class="panel-head"><div><p class="mini-label">AUTHORITY BOUNDARY</p><h3>A signature is not site permission</h3></div></div><p class="panel-copy">The site must trust this wallet, check the recipient and limits, and honor the end time before it acts.</p></section><section id="grant-result"></section></aside></div>`;
}

function peerRows() {
  const peers = [...(state.room?.peers.values() ?? [])];
  if (!peers.length)
    return `<div class="empty-state"><h3>No other agents here yet</h3><p>Keep public presence on and connect another agent to this site's shared space. Connection helpers help agents find each other.</p></div>`;
  const now = Date.now();
  return `<div class="event-list">${peers
    .map((peer) => {
      const scopes = peerGrantedScopes(peer, state, now);
      const granted = scopes.length
        ? `Granted scopes: ${scopes.map(esc).join(", ")}`
        : "No scopes granted";
      return `<div class="peer-chip"><div><strong>${esc(peer.name)}</strong><code>${esc(peer.id)}</code><small class="help">Verified presence</small><small class="help" data-scopes="${esc(scopes.join(","))}">${granted}</small></div><button class="button quiet small" type="button" data-grant-peer="${esc(peer.id)}">Grant</button></div>`;
    })
    .join("")}</div>`;
}

// The roster must never invent scopes. A peer's granted scopes come only from
// data we can verify locally: an explicit scopes field on the presence record,
// or this wallet's signed capability grants to that exact recipient that are
// still open. Unverified, expired or elsewhere-addressed grants add nothing.
function peerGrantedScopes(peer, state = {}, now = Date.now()) {
  const inline = peer?.scopes ?? peer?.capabilities;
  if (
    Array.isArray(inline) &&
    inline.every((scope) => typeof scope === "string")
  )
    return [...new Set(inline)];
  const activity = Array.isArray(state.activity) ? state.activity : [];
  const scopes = new Set();
  for (const entry of activity) {
    if (entry?.verified !== true) continue;
    if (entry.body?.type !== "capability/grant-issued") continue;
    const payload = entry.body.payload ?? {};
    if (payload.recipient !== peer?.id || !Array.isArray(payload.capabilities))
      continue;
    if (
      payload.expiresAt !== null &&
      Number.isFinite(payload.expiresAt) &&
      payload.expiresAt <= now
    )
      continue;
    for (const scope of payload.capabilities)
      if (typeof scope === "string") scopes.add(scope);
  }
  return [...scopes];
}

// Activity entries are signed by this wallet. Re-verify them before using them
// as grant evidence in the roster, with the same rules as the history view.
async function verifiedActivity() {
  const stored = await readActivity();
  if (typeof verifyEnvelope !== "function") return stored;
  return Promise.all(
    stored.map(async (entry) => ({
      ...entry,
      verified: await verifyEnvelope(entry, {
        expectedIssuer: state.wallet?.id,
        maxAgeMs: 20 * 365 * 24 * 60 * 60 * 1000,
      }),
    })),
  );
}

function connectPeerView() {
  if (!state.wallet)
    return `${pageHead("DIRECT CONNECTION", "Connect two agents.", "Allow presence sharing to see other agents on this page. Signed messages travel over a direct connection.")}${walletRequired()}`;
  const msgs =
    state.messages
      .map(
        (message) =>
          `<div class="message-item ${message.direction === "in" ? "remote" : ""}">${esc(message.text)}<span class="message-meta">${message.direction === "in" ? `Verified ${esc(shortId(message.issuer))}` : "Signed by this wallet"} · ${esc(dateText(message.at))}</span></div>`,
      )
      .join("") ||
    `<p class="help">No signed messages yet. Connect to another agent to begin.</p>`;
  return `${pageHead("OTHER AGENTS", "Find agents on this site.", "Connection helpers help agents find each other. Once connected, signed messages travel over a direct connection.")}
    <div class="stack"><section class="panel"><div class="panel-head"><div><h2>Agent presence</h2><p class="panel-copy">Agents on this site's public space can find one another. Private mode receives room events but shows no presence.</p></div><button class="button ${state.privateMode ? "" : "secondary"} small" id="toggle-private" aria-pressed="${state.privateMode}">${state.privateMode ? "Go public" : "Go private"}</button></div><div class="metric-line"><span>Local wallet</span><strong>${esc(state.wallet.name)}</strong></div><div class="metric-line"><span>Visibility</span><strong>${state.privateMode ? "Private" : "Public site space"}</strong></div><div class="metric-line"><span>Other agents connected</span><strong>${state.room?.peers.size ?? 0}</strong></div>${peerRows()}</section>
    <div class="grid-main"><section class="panel"><div class="panel-head"><div><h2>Signed messages</h2><p class="panel-copy">Messages are accepted only after their signature and time limit check out.</p></div></div><div class="message-list" id="message-list" aria-live="polite">${msgs}</div><form id="message-form" class="split-form"><div class="field"><label for="peer-message">Message to connected agents</label><input class="control" id="peer-message" maxlength="3000" required placeholder="Write a short message" ${state.privateMode ? "disabled" : ""}/></div><button class="button" type="submit" ${state.privateMode ? "disabled" : ""}>Send signed</button></form></section>
      <section class="panel"><div class="panel-head"><div><h2>Connection details</h2><p class="panel-copy">The browser uses connection helpers to find other agents, then opens a direct connection for their messages.</p></div></div><div class="metric-line"><span>Discovery</span><strong>Connection helpers</strong></div><div class="metric-line"><span>Messages</span><strong>Direct connection</strong></div><div class="callout">No relay server is set up. Some networks block direct connections. Connection helpers can see who joins a room and when.</div></section></div></div>`;
}

function activityView() {
  if (!state.wallet)
    return `${pageHead("SIGNED ACTIVITY", "A local record of wallet actions.", "Activity entries are signed by this wallet and stay in this browser's storage.")}${walletRequired()}`;
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
  if (state.wallet && (state.view === "activity" || state.view === "peer"))
    state.activity = await verifiedActivity();
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

// Room events only need the peer panel refreshed. A plain render() rebuilds
// #view and would silently drop an in-progress message, its focus and the list
// scroll, so restore those three bits of UI state around the re-render.
async function renderPeerPreservingDraft() {
  const input = $("#peer-message");
  const draft = input?.value;
  const scroll = $("#message-list")?.scrollTop;
  const focused = document.activeElement === input;
  await render();
  const nextInput = $("#peer-message");
  if (nextInput) {
    if (draft !== undefined) nextInput.value = draft;
    if (focused) nextInput.focus();
  }
  const nextList = $("#message-list");
  if (nextList && scroll !== undefined) nextList.scrollTop = scroll;
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

// The connection label comes from the real connection state, in plain words.
function setConnectionLabel(text) {
  state.connectionLabel = text;
  const element = $("#connection-status");
  if (element) element.textContent = text;
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
    const refreshPeerView =
      type === "peer/hello" ||
      type === "peer/goodbye" ||
      type === "message/text" ||
      type === "collab/text" ||
      type === "presence/cursor";
    if (type === "message/text" || type === "collab/text") {
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
        if (
          ![
            "peer/hello",
            "peer/heartbeat",
            "peer/goodbye",
            "presence/cursor",
          ].includes(type)
        )
          state.lease?.touch();
        touchGrant();
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
    // Heartbeats were forwarded above so the site can refresh presence, but
    // they are passive: no activity entry, no re-render, just the peer count.
    if (type === "peer/heartbeat") {
      if (state.view === "overview") {
        const peerCount = $("#overview-peer-count");
        if (peerCount)
          peerCount.textContent = String(state.room?.peers.size ?? 0);
      }
      return;
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
          else if (state.view === "peer" && refreshPeerView)
            await renderPeerPreservingDraft();
        })
        .catch(() => {});
    } else if (state.view === "overview") {
      void render();
    } else if (
      state.view === "peer" &&
      (refreshPeerView || direction === "state")
    ) {
      void renderPeerPreservingDraft();
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
        grantOpen(state.consent?.body?.payload)
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
      onStatus: (status) => debug("p2p-status", status),
    });
  } else {
    state.rtc = new NostrWebRTC(state.room, {
      origin: location.origin,
      room: "default",
      onDiagnostic: (event) => debug("p2p-diagnostic", event),
      onStatus: (status) => debug("p2p-status", status),
    });
  }
  const rtc = state.rtc;
  const room = state.room;
  setConnectionLabel(connectionStatusLabel(rtc.connectionState.status));
  rtc.onConnectionState((snapshot) =>
    setConnectionLabel(connectionStatusLabel(snapshot.status)),
  );
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
    if (state.submitting) return;
    state.submitting = true;
    const submitButton = event.currentTarget.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    try {
      state.error = "";
      const data = new FormData(event.currentTarget);
      if (data.get("passphrase") !== data.get("confirmation"))
        return fail(
          new Error(
            "Recovery passphrases do not match. Enter the same passphrase in both fields.",
          ),
        );
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
    } finally {
      state.submitting = false;
      if (submitButton) submitButton.disabled = false;
    }
  });
  $("#import-wallet-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.submitting) return;
    state.submitting = true;
    const submitButton = event.currentTarget.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    try {
      state.error = "";
      const file = $("#backup-file").files?.[0];
      if (!file)
        return fail(
          new Error(
            "Choose a recovery file first, then click Unlock and restore.",
          ),
        );
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
    } finally {
      state.submitting = false;
      if (submitButton) submitButton.disabled = false;
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
    await state.rtc?.close();
    await forgetWallet();
    state.wallet = null;
    state.room = null;
    state.rtc = null;
    state.activity = [];
    render();
    toast("Wallet removed from this browser.");
  });
  $("#permission-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.error = "";
    state.consent = null;
    if (!state.wallet) return fail(new Error(WALLET_REQUIRED_MESSAGE));
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
        throw new Error(
          "Demo website challenge failed verification. Refresh the site and click Connect agent to try again.",
        );
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
          "Signed approval did not pass the demo website verifier. Click New request and try again.",
        );
      if (
        await verifyPermissionConsent(approval, request, {
          expectedOrigin: origin,
          expectedWallet: state.wallet.id,
          nonceGuard: guard,
        })
      )
        throw new Error(
          "Replay defense did not reject a duplicate approval. Reload this page and try again.",
        );
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
      if (!state.wallet) throw new Error(WALLET_REQUIRED_MESSAGE);
      if (state.externalStatus || !state.externalRequest)
        throw new Error(
          "This wallet request is no longer active. Return to the site and click Connect agent to start again.",
        );
      if (
        !state.consentCallback &&
        (!externalHost || state.externalSource !== externalHost)
      )
        throw new Error(
          "The requesting site tab is no longer available. Return to the site and click Connect agent to start again.",
        );
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
              : parseSessionTtl(
                  event.currentTarget.querySelector("#session-ttl")?.value,
                ),
        },
      );
      // Save the signed grant before the site is told, so a wallet reload can
      // confirm a resume from its durable record rather than page memory. A
      // blocked storage backend must not block connecting; without a durable
      // grant the session simply cannot be resumed later.
      try {
        await grantStore.save(consent, {
          audience: state.externalOrigin,
          room: state.externalRequest.room ?? "default",
        });
        state.grants = await grantStore.list();
      } catch {} // best-effort durability; resume stays unavailable
      const consentMessage = {
        type: "ai-auth/connect-consent",
        requestNonce: state.externalRequest.nonce,
        consent,
        // The identity id must match the signed consent issuer; the site
        // verifies it. The name is display-only peer labeling.
        wallet: { id: state.wallet.id, name: state.wallet.name },
      };
      if (externalHost && state.externalSource === externalHost)
        externalHost.postMessage(consentMessage, state.externalOrigin);
      if (state.consentCallback) {
        fetch(state.consentCallback, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(consentMessage),
        }).catch(() => {});
      }
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
          `Your approval was sent, but finding other agents failed: ${error.message} Reload the wallet to try again.`,
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
      if (!state.wallet) throw new Error(WALLET_REQUIRED_MESSAGE);
      if (!renewal || !externalSessionActive())
        throw new Error(
          "This session is no longer active. Return to the site and click Connect agent to start a new one.",
        );
      const consent = await approvePermissionRequest(
        state.wallet,
        renewal,
        renewal.capabilities,
        {
          sessionTtlMs: defaultSessionTtl(sessionLimits(renewal)),
          previousConsent: state.consent,
        },
      );
      if (!state.lease.renew(consent.body.payload))
        throw new Error(
          "This session is no longer active. Return to the site and click Connect agent to start a new one.",
        );
      // Renewal keeps the session's original identity: replace the one grant
      // keyed by the original nonce rather than storing under the renewal
      // nonce. The narrower consent then supersedes the broader one everywhere.
      const sessionId =
        state.externalRequest?.nonce ?? state.consent.body.payload.requestNonce;
      try {
        await grantStore.save(consent, {
          audience: state.externalOrigin,
          room: renewal.room ?? state.externalRequest?.room ?? "default",
          requestNonce: sessionId,
        });
      } catch {
        // Without persistence the old (broader) grant must not stay resumable.
        try {
          await grantStore.markEnded(state.externalOrigin, sessionId);
        } catch {}
      }
      // Persist (or retire) the grant before telling the site it succeeded,
      // matching the fresh-connect ordering.
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
    if (externalSessionActive())
      toast(renewalKeptText(state.consent.body.payload.expiresAt));
    render();
  });
  $("#end-session")?.addEventListener("click", async () => {
    await expireExternalSession("ended");
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
        throw new Error(
          "The signed grant failed local verification. Check the recipient and capabilities, then try again.",
        );
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
    if (state.togglingPrivate) return;
    state.togglingPrivate = true;
    const button = $("#toggle-private");
    if (button) button.disabled = true;
    try {
      state.privateMode = !state.privateMode;
      // startRoom closes the previous room (and its heartbeat) and the old rtc
      // before creating replacements. It must also run in iframe mode: leaving
      // a closed transport with no rebuild strands the approved session.
      await startRoom();
      render();
      toast(
        state.privateMode
          ? "Private mode is on. You receive room events but advertise no presence."
          : "Public site-space presence is on.",
      );
    } finally {
      state.togglingPrivate = false;
      if (button) button.disabled = false;
    }
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
      toast(`${error.message} Try again once the connection is ready.`);
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

// Ending a grant flips a durable flag on its saved record. There is no capped
// id list: IndexedDB holds one record per audience and request nonce.
async function markSessionEnded(id) {
  const audience = state.externalOrigin;
  if (typeof id !== "string" || typeof audience !== "string" || !audience)
    return;
  await grantStore.markEnded(audience, id);
}

function touchGrant() {
  const audience = state.externalOrigin;
  // The signed consent's request nonce changes on renewal; the session id in
  // state.externalRequest is the stable key the grant is stored under.
  const id =
    state.externalRequest?.nonce ?? state.consent?.body?.payload?.requestNonce;
  if (typeof audience === "string" && audience && typeof id === "string")
    void grantStore.touch(audience, id);
}

// A resume never re-grants a scope. It re-checks the stored, signed consent
// against this wallet's key and the current time, then restarts the room.
async function confirmSessionResume(event) {
  const data = event.data;
  const payload = data?.consent?.body?.payload;
  const origin = data?.audience;
  const valid =
    event.source === externalHost &&
    Boolean(state.wallet) &&
    (await canResumeStoredSession(data?.consent, {
      audience: origin,
      sessionId: data?.sessionId,
      room: data?.room,
      walletId: state.wallet?.id,
      store: grantStore,
    }));
  if (!valid) {
    externalHost?.postMessage(
      { type: "ai-auth/session-ended", reason: "revoked" },
      origin,
    );
    return;
  }
  activateResumedSession(data, payload, origin);
}

function activateResumedSession(data, payload, origin) {
  state.externalRequest = {
    audience: origin,
    room: data.room,
    capabilities: [...payload.capabilities],
    nonce: data.sessionId,
    expiresAt: payload.challengeExpiresAt,
  };
  state.consent = data.consent;
  state.lease = new SessionLease(payload);
  state.externalStatus = "sent";
  state.externalOrigin = origin;
  state.externalSource = externalHost;
  state.privateMode = false;
  state.externalRoomReady = false;
  clearTimeout(state.externalExpiryTimer);
  scheduleSessionExpiry();
  state.view = "connect";
  render();
  externalHost.postMessage(
    {
      type: "ai-auth/session-resumed",
      sessionId: data.sessionId,
      wallet: { id: state.wallet.id, name: state.wallet.name },
      consent: state.consent,
    },
    origin,
  );
  void startRoom().catch(() => {
    state.externalRoomReady = false;
  });
}

// One timer follows the earlier of grant expiry and idle deadline and
// re-checks the lease each time, so renewal and activity move it forward.
function scheduleSessionExpiry() {
  clearTimeout(state.sessionTimer);
  if (state.externalStatus !== "sent" || !state.lease) return;
  if (!state.lease.isActive()) {
    void expireExternalSession(state.lease.status());
    return;
  }
  // A Never grant has no deadline; it is re-checked when the visitor acts.
  if (state.lease.deadline === null) return;
  state.sessionTimer = setTimeout(
    scheduleSessionExpiry,
    Math.max(1, state.lease.deadline - Date.now()),
  );
}

async function expireExternalSession(reason = "expired", endedBySite = false) {
  if (state.externalStatus !== "sent") return;
  clearTimeout(state.sessionTimer);
  try {
    await markSessionEnded(
      state.externalRequest?.nonce ??
        state.consent?.body?.payload?.requestNonce,
    );
  } catch {
    // A blocked grant store must not stop the lease revocation or the notice
    // to the site. Report the failed persistence and finish ending locally.
    toast("The session ended, but its saved record could not be updated.");
  }
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
  state.externalStatus =
    reason === "idle" ? "idle" : reason === "ended" ? "ended" : "expired";
  state.endedBySite = reason === "ended" ? endedBySite : false;
  state.externalRoomReady = false;
  state.externalPendingEvents.length = 0;
  state.transfers?.close();
  state.transfers = null;
  // Capture and clear the references first so a re-entrant expiry cannot close
  // twice. room.close() awaits the signed goodbye, so it must finish before the
  // rtc connection is torn down or the goodbye has no channel to leave on.
  const room = state.room;
  const rtc = state.rtc;
  state.rtc = null;
  state.room = null;
  if (room) {
    try {
      await room.close();
    } catch {
      /* best effort disconnect notice */
    }
  }
  if (rtc) await rtc.close();
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
    const { x, y, visible = true, scroll, pageKey } = data.cursor ?? {};
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
    let page = null;
    if (pageKey !== undefined && pageKey !== null) {
      if (
        typeof pageKey !== "string" ||
        !pageKey ||
        pageKey.length > 200 ||
        /[\u0000-\u001f]/u.test(pageKey)
      )
        return;
      page = pageKey;
    }
    // Only normalized coordinates, an optional scroll fraction and the page
    // key are signed and shared. Keystrokes, form values, passwords, and hidden
    // page data are never part of this event path.
    const payload = { x, y, visible, pageKey: page, label: state.wallet.name };
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
      !TOOL_NAME_PATTERN.test(action.name) ||
      ![
        "started",
        "progress",
        "completed",
        "failed",
        "cancelled",
        "needs-human",
        "denied",
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
      const tools = filterCatalogTools(agentEvent.tools, (name) =>
        debug("wallet-skipped-tool", name),
      );
      await state.room.send("agent/action", {
        kind: "tool-catalog",
        tools,
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
      try {
        // Addressed to the requester only, so other agents in the room do not
        // spend their inbound budget on a response that is not theirs.
        await state.room.send(
          "agent/action",
          {
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
            // Forward the machine-readable reason with the human message so a
            // typed site failure (e.g. invalid input) survives the relay hop.
            ...(typeof agentEvent.code === "string" &&
            agentEvent.code.length <= 40
              ? { code: agentEvent.code }
              : {}),
            targetWallet: state.wallet.id,
            targetNonce: state.externalRequest.nonce,
            targetSession: state.room.session,
          },
          { to: agentEvent.toWallet },
        );
      } catch (error) {
        // The requester is not a verified member of this room, so there is
        // nobody to deliver the response to.
        debug("tool-response-not-delivered", error?.message ?? "");
        return;
      }
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
      await expireExternalSession(state.lease.status());
    if (
      event.data?.type === "ai-auth/transfer-request" &&
      event.source === state.externalSource &&
      event.origin === state.externalOrigin &&
      event.origin === state.externalRequest?.audience &&
      state.externalStatus === "sent" &&
      grantOpen(state.consent?.body?.payload)
    ) {
      state.lease?.touch();
      touchGrant();
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
          throw new Error(
            "Wallet peer connection is not ready. Wait for the connection, then try again.",
          );
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
            error: `${error.message || "Transfer failed"} Wait for the wallet peer connection, then try again.`,
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
      touchGrant();
      if (!state.externalRoomReady) {
        if (state.externalPendingEvents.length < 32)
          state.externalPendingEvents.push(event.data);
        return;
      }
      try {
        await handleExternalSiteEvent(event.data);
      } catch (error) {
        toast(
          `Could not sign the site event: ${error.message} Reconnect from the site and try again.`,
        );
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
    // A site that disconnects tells us to end its session. Only the opener we
    // are connected to, at the exact site origin we approved, may end it.
    if (
      event.data?.type === "ai-auth/session-ended" &&
      event.source === externalHost &&
      event.origin === state.externalOrigin &&
      event.origin === state.externalRequest?.audience
    ) {
      // The site already revoked its side of the connection. End the wallet's
      // room too so peers get a signed goodbye instead of waiting for the lease.
      await expireExternalSession("ended", true);
      return;
    }
    // Authenticate the message itself: data.audience is caller-controlled, so
    // it must agree with the real event.origin (and with the site we are bound
    // to once a session exists) before a resume is even considered.
    if (
      event.data?.type === "ai-auth/session-resume" &&
      event.source === externalHost &&
      event.origin === event.data?.audience &&
      (state.externalOrigin === "" || event.origin === state.externalOrigin)
    ) {
      await confirmSessionResume(event);
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
        "The requesting site or its permission request could not be verified. Return to the site and click Connect agent to try again.";
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
  // A directly opened wallet can carry its request and callback in the URL.
  if (
    typeof urlRequestParam !== "undefined" &&
    typeof consentCallback !== "undefined" &&
    typeof verifyPermissionRequest === "function" &&
    urlRequestParam &&
    consentCallback &&
    !state.externalRequest
  ) {
    try {
      const request = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(urlRequestParam.replace(/-/gu, "+").replace(/_/gu, "/")),
            (char) => char.charCodeAt(0),
          ),
        ),
      );
      if (
        await verifyPermissionRequest(request, {
          expectedOrigin: request.audience,
        })
      ) {
        state.externalRequest = request;
        state.externalOrigin = request.audience;
        state.externalStatus = "";
        state.externalRequestReceived = true;
        state.consentCallback = consentCallback;
        state.view = "connect";
        state.externalExpiryTimer = setTimeout(
          () => {
            if (state.externalStatus) return;
            state.externalStatus = "expired";
            render();
          },
          Math.max(0, request.expiresAt - Date.now()),
        );
      }
    } catch {
      state.error =
        "The connect request in this link is invalid. Return to the site and start a new connection.";
    }
  }
  if (state.wallet && typeof grantStore !== "undefined")
    state.grants = await grantStore.list();
  if (state.wallet && !externalConnectMode) {
    if (!state.privateMode) await startRoom();
  }
  render();
  if (externalConnectMode && externalHost) {
    // A connect-ready signal is addressed to the opener we actually belong to,
    // never to "*". Prefer the origin of an already verified connect-request;
    // otherwise use the browser-provided referrer, which is the embedding
    // page's origin and cannot be forged by page script.
    let readyOrigin = state.externalOrigin;
    if (!readyOrigin) {
      try {
        readyOrigin = new URL(document.referrer).origin;
      } catch {
        readyOrigin = "";
      }
    }
    if (readyOrigin)
      externalHost.postMessage({ type: "ai-auth/connect-ready" }, readyOrigin);
  }
} catch (error) {
  state.error = `${error.message} Reload the wallet to try again.`;
  render();
}

setInterval(() => {
  const countdown = $("#session-countdown");
  if (countdown && state.consent?.body?.payload?.expiresAt)
    countdown.textContent = sessionEndText(
      state.consent.body.payload.expiresAt,
    );
}, 1000);
