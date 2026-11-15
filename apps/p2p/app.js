import {
  appendActivity,
  approvePermissionRequest,
  createCapabilityGrant,
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
  ManualWebRTC,
} from "/packages/p2p/index.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  wallet: null,
  view: "wallet",
  room: null,
  rtc: null,
  request: null,
  consent: null,
  messages: [],
  privateMode: false,
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
    "Allow message exchange in the approved workspace.",
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

function connectView() {
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
    return `<div class="empty-state"><h3>No other agents here yet</h3><p>Open another wallet tab on this same site or exchange a manual WebRTC offer and answer with another device.</p></div>`;
  return `<div class="event-list">${peers.map((peer) => `<div class="peer-chip"><div><strong>${esc(peer.name)}</strong><code>${esc(peer.id)}</code><small class="help">Session ${esc(peer.session.slice(0, 8))} · verified signed presence</small></div><button class="button quiet small" type="button" data-grant-peer="${esc(peer.id)}">Grant</button></div>`).join("")}</div>`;
}

function connectPeerView() {
  if (!state.wallet)
    return `${pageHead("DIRECT CONNECTION", "Connect two agent wallets.", "Presence stays on this origin. For another device, exchange one-time WebRTC setup text directly.")}${walletRequired()}`;
  const msgs =
    state.messages
      .map(
        (message) =>
          `<div class="message-item ${message.direction === "in" ? "remote" : ""}">${esc(message.text)}<span class="message-meta">${message.direction === "in" ? `Verified ${esc(shortId(message.issuer))}` : "Signed by this wallet"} · ${esc(dateText(message.at))}</span></div>`,
      )
      .join("") ||
    `<p class="help">No signed messages yet. Connect a peer to begin.</p>`;
  return `${pageHead("PEER CONNECTION", "Connect directly. No signaling service.", "Exchange offer and answer text out of band. Signed presence works between same-origin browser tabs; WebRTC data travels directly between peers when the network allows it.")}
    <div class="stack"><section class="panel"><div class="panel-head"><div><h2>Agent presence</h2><p class="panel-copy">The public workspace is visible to tabs on this origin. Private mode stops presence and message sharing.</p></div><button class="button ${state.privateMode ? "" : "secondary"} small" id="toggle-private" aria-pressed="${state.privateMode}">${state.privateMode ? "Go public" : "Go private"}</button></div><div class="metric-line"><span>Local wallet</span><strong>${esc(state.wallet.name)}</strong></div><div class="metric-line"><span>Visibility</span><strong>${state.privateMode ? "Private" : "Public workspace"}</strong></div><div class="metric-line"><span>Peer sessions</span><strong>${state.room?.peers.size ?? 0}</strong></div>${peerRows()}</section>
    <div class="grid-main"><section class="panel"><div class="panel-head"><div><h2>Signed messages</h2><p class="panel-copy">Received messages are accepted only after their signature, expiry, origin and replay nonce pass verification.</p></div></div><div class="message-list" id="message-list" aria-live="polite">${msgs}</div><form id="message-form" class="split-form"><div class="field"><label for="peer-message">Message to connected peers</label><input class="control" id="peer-message" maxlength="3000" required placeholder="Write a short message" ${state.privateMode ? "disabled" : ""}/></div><button class="button" type="submit" ${state.privateMode ? "disabled" : ""}>Send signed</button></form></section>
      <section class="panel"><div class="panel-head"><div><h2>Manual WebRTC pairing</h2><p class="panel-copy">Create an offer on one wallet, answer it on another, then apply the answer. Copy the SDP directly between devices.</p></div></div><div class="callout">SDP can contain local network candidates. Share it privately. This prototype configures no TURN relay; restrictive networks may not connect.</div>
        <div class="button-row"><button class="button small" id="create-offer" ${state.privateMode ? "disabled" : ""}>Create offer</button><button class="button secondary small" id="answer-offer" ${state.privateMode ? "disabled" : ""}>Answer pasted offer</button><button class="button quiet small" id="apply-answer" ${state.privateMode ? "disabled" : ""}>Apply pasted answer</button></div><div class="field"><label for="sdp-in">Remote offer or answer</label><textarea class="control" id="sdp-in" spellcheck="false" autocomplete="off" placeholder="Paste a peer's SDP here" ${state.privateMode ? "disabled" : ""}></textarea></div><div class="field"><label for="sdp-out">Your offer or answer</label><textarea class="control" id="sdp-out" readonly spellcheck="false" placeholder="Generated setup text appears here"></textarea><div class="button-row"><button class="button quiet small" id="copy-sdp" type="button">Copy setup text</button></div></div><p class="help" id="rtc-state" aria-live="polite">${esc(state.rtc?.peer.connectionState ?? "Not connected")}</p>
      </section></div></div>`;
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
    state.view === "wallet"
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

async function startRoom() {
  await state.room?.close();
  state.room = new P2PRoom(state.wallet, "workspace", {
    privateMode: state.privateMode,
  });
  state.room.subscribe(({ direction, envelope, message }) => {
    if (direction === "error") {
      toast(message);
      return;
    }
    const type = envelope?.body?.type;
    if (type === "message/text") {
      state.messages.push({
        direction,
        text: String(envelope.body.payload.text ?? ""),
        issuer: envelope.body.issuer,
        at: envelope.body.createdAt,
      });
      if (state.messages.length > 100) state.messages.shift();
    }
    if (direction === "in" && type)
      void appendActivity(
        state.wallet,
        `peer/received-${type.split("/").at(-1)}`,
        { issuer: envelope.body.issuer, payload: envelope.body.payload },
      ).catch(() => {});
    if (state.view === "peer") void render();
  });
  await state.room.start();
}

function bindView() {
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
      await startRoom();
      state.view = "wallet";
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
      await startRoom();
      state.view = "wallet";
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
    await startRoom();
    render();
    toast(
      state.privateMode
        ? "Private mode is on. Shared presence and messages are paused."
        : "Public workspace presence is on.",
    );
  });
  $("#message-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#peer-message").value.trim();
    if (!text) return;
    try {
      const envelope = await state.room.send("message/text", { text });
      state.messages.push({
        direction: "out",
        text,
        issuer: state.wallet.id,
        at: envelope.body.createdAt,
      });
      await appendActivity(state.wallet, "peer/message-sent", {
        text,
        room: "workspace",
      });
      render();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#create-offer")?.addEventListener("click", async () => {
    try {
      state.rtc?.close();
      state.rtc = new ManualWebRTC(state.room, { iceServers: [] });
      $("#sdp-out").value = await state.rtc.offer();
      $("#rtc-state").textContent =
        `Offer ready · ${state.rtc.peer.connectionState}`;
    } catch (error) {
      toast(error.message);
    }
  });
  $("#answer-offer")?.addEventListener("click", async () => {
    try {
      state.rtc?.close();
      state.rtc = new ManualWebRTC(state.room, { iceServers: [] });
      $("#sdp-out").value = await state.rtc.answer($("#sdp-in").value);
      $("#rtc-state").textContent =
        `Answer ready · ${state.rtc.peer.connectionState}`;
    } catch (error) {
      toast(error.message);
    }
  });
  $("#apply-answer")?.addEventListener("click", async () => {
    try {
      if (!state.rtc)
        throw new Error("Create an offer before applying an answer");
      await state.rtc.finish($("#sdp-in").value);
      $("#rtc-state").textContent = "Answer applied · waiting for direct peer";
    } catch (error) {
      toast(error.message);
    }
  });
  $("#copy-sdp")?.addEventListener("click", async () => {
    if (!$("#sdp-out").value) return toast("Create an offer or answer first.");
    await navigator.clipboard.writeText($("#sdp-out").value);
    toast("Setup text copied. Share it privately.");
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

document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", async () => {
    state.view = button.dataset.view;
    state.error = "";
    render();
  }),
);

try {
  state.wallet = await loadWallet();
  if (state.wallet) {
    await startRoom();
  }
  render();
} catch (error) {
  state.error = error.message;
  render();
}
