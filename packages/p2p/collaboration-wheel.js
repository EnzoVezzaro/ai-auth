import { createDeliveryLedger } from "./receipts.js";
import { createMediaCapture, MEDIA_LIMITS } from "./wheel-capture.js";
import {
  countSensitiveRegions,
  describeElementForShare,
} from "./wheel-redaction.js";
import {
  buildRecipients,
  explainSendBlock,
  fingerprintFromId,
  rememberPeer,
  verifyPeerKey,
} from "./wheel-recipients.js";
import { createShell, focusableIn, trapTab } from "./wheel-ui.js";

const PUBLIC_WARNING =
  "Everyone in this public room can see and save what you send.";
const TARGET_WARNING = (fp) =>
  `Addressed to ${fp} only. Other connected peers' apps are told to ignore it, but this is not encryption.`;
const TOUCH_PICKING_REASON =
  "Picking an element needs a mouse or keyboard, so it is unavailable on touch screens.";
const SWEEP_MS = 5000;

const STATE_LABEL = {
  composing: "Preparing, not sent",
  queued: "Queued",
  failed: "Failed",
  expired: "No signed receipt arrived in time",
};

/**
 * Mount a page-local collaboration control for an established AI Auth connection.
 *
 * Options (all optional): `target`, `capabilities`, `room` (a P2PRoom-like peer
 * source), `network` (an object with `connectionState` / `onConnectionState`),
 * `expiresAt` (ms). Private and sensitive elements can never be shared.
 */
export function mountCollaborationWheel(connection, options = {}) {
  const { target = globalThis.document?.body } = options;
  if (!connection || typeof connection.subscribe !== "function")
    throw new TypeError("A collaboration transfer session is required");
  if (!target?.ownerDocument)
    throw new TypeError("A target element is required");
  const wheel = new Wheel(connection, target, options);
  return () => wheel.dispose();
}

class Wheel {
  constructor(connection, target, options) {
    this.connection = connection;
    this.options = options;
    this.capabilities = options.capabilities ?? null;
    this.doc = target.ownerDocument;
    this.win = this.doc.defaultView;
    this.ui = createShell(this.doc, target);
    this.pickerInstructions = this.ui.pickerText.textContent;
    this.capture = createMediaCapture(this.win, this.doc);
    this.ledger = createDeliveryLedger();
    this.selfId = options.room?.wallet?.id;
    this.known = new Map();
    this.selection = "everyone";
    this.staged = null;
    this.selecting = false;
    this.sendingText = false;
    this.disposed = false;
    this.objectUrls = new Set();
    this.entries = new Map();
    this.inbox = Promise.resolve();
    this.restoreFocus = null;
    this.bind();
    this.refresh();
  }

  get supportsTargets() {
    return this.connection.supportsTargets === true;
  }
  get supportsReceipts() {
    return this.connection.supportsReceipts === true;
  }
  get snapshot() {
    return this.options.network?.connectionState;
  }
  get expired() {
    return (
      Number.isFinite(this.options.expiresAt) &&
      Date.now() >= this.options.expiresAt
    );
  }

  bind() {
    const { ui } = this;
    const off = [];
    this.unsubscribers = off;
    off.push(this.connection.subscribe((event) => this.onEvent(event)));
    off.push(this.ledger.subscribe((entry) => this.renderEntry(entry)));
    const network = this.options.network;
    if (typeof network?.onConnectionState === "function")
      off.push(network.onConnectionState(() => this.refresh()));
    const room = this.options.room;
    if (typeof room?.subscribe === "function")
      off.push(room.subscribe(() => void this.syncRoomPeers()));
    this.timer = setInterval(() => {
      this.ledger.sweep();
      void this.syncRoomPeers();
      this.refresh();
    }, SWEEP_MS);
    ui.toggle.addEventListener("click", () =>
      ui.panel.hidden ? this.open() : this.close(),
    );
    ui.root.addEventListener("keydown", (event) => this.onKey(event));
    ui.form.addEventListener("submit", (event) => this.onSubmit(event));
    ui.recipient.addEventListener("change", () => this.onRecipient());
    ui.action("element").addEventListener("click", () =>
      this.guarded("element", () => this.startPicking()),
    );
    ui.action("screenshot").addEventListener("click", () =>
      this.guarded("screenshot", () => this.takeScreenshot()),
    );
    ui.action("record").addEventListener("click", () =>
      this.guarded("record", () => this.toggleRecording()),
    );
    ui.action("cancel-record").addEventListener("click", () =>
      this.cancelRecording(),
    );
    ui.action("confirm").addEventListener(
      "click",
      () => void this.confirmStaged(),
    );
    ui.action("discard").addEventListener("click", () =>
      this.discardStaged("Discarded. Nothing was sent."),
    );
    ui.action("stop-picking").addEventListener("click", () =>
      this.stopPicking("Element selection cancelled."),
    );
    void this.syncRoomPeers();
  }

  say(text) {
    this.ui.status.textContent = text;
  }

  // ---- open / close / focus ------------------------------------------------
  open() {
    this.restoreFocus = this.doc.activeElement;
    this.ui.panel.hidden = false;
    this.ui.toggle.setAttribute("aria-expanded", "true");
    this.ui.toggle.setAttribute("aria-label", "Close collaboration");
    this.refresh();
    (this.ui.input.disabled
      ? focusableIn(this.ui.panel)[0]
      : this.ui.input
    )?.focus();
  }

  close() {
    this.stopPicking();
    this.cancelRecording(true);
    this.discardStaged();
    this.capture.cancel();
    this.ui.panel.hidden = true;
    this.ui.toggle.setAttribute("aria-expanded", "false");
    this.ui.toggle.setAttribute("aria-label", "Open collaboration");
    const back = this.restoreFocus;
    this.restoreFocus = null;
    (back?.isConnected && back !== this.doc.body && back !== this.ui.host
      ? back
      : this.ui.toggle
    ).focus?.();
  }

  onKey(event) {
    if (this.ui.panel.hidden) return;
    // While picking, the panel is only visually hidden and the focused Cancel
    // button lives outside it, so the tab trap would make Tab a no-op and trap
    // keyboard users away from the page elements they are trying to pick.
    if (this.selecting) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      this.close();
      return;
    }
    trapTab(event, this.ui.panel, this.ui.shadow.activeElement);
  }

  // ---- recipients and gating ----------------------------------------------
  recipients() {
    return buildRecipients({
      known: this.known,
      snapshot: this.snapshot,
      selfId: this.selfId,
    });
  }

  blockReason() {
    return explainSendBlock({
      selection: this.selection,
      recipients: this.recipients(),
      snapshot: this.snapshot,
      expired: this.expired,
      supportsTargets: this.supportsTargets,
    });
  }

  async syncRoomPeers() {
    const peers = this.options.room?.peers;
    if (!peers) return;
    for (const peer of [...peers.values()]) {
      const verified = await verifyPeerKey(peer.publicKey, peer.id);
      if (this.disposed) return;
      if (verified)
        this.known = rememberPeer(this.known, verified, peer.seenAt);
    }
    this.refresh();
  }

  onRecipient() {
    this.selection = this.ui.recipient.value;
    this.refresh();
  }

  renderRecipients(list) {
    const { recipient, peers } = this.ui;
    const opts = [new Option("Everyone in public room", "everyone")];
    for (const peer of list)
      opts.push(
        new Option(
          `${peer.fingerprint} (${peer.online ? "online" : "offline"})`,
          peer.walletId,
        ),
      );
    if (
      this.selection !== "everyone" &&
      !list.some((p) => p.walletId === this.selection)
    )
      opts.push(
        new Option(
          `${fingerprintFromId(this.selection)} (offline)`,
          this.selection,
        ),
      );
    recipient.replaceChildren(...opts);
    recipient.value = this.selection;
    peers.replaceChildren(
      ...list.map((peer) => {
        const item = this.doc.createElement("li");
        item.textContent = `${peer.fingerprint}: ${peer.online ? "online" : "offline"} (verified key)`;
        return item;
      }),
    );
    if (!list.length) {
      const none = this.doc.createElement("li");
      none.textContent = "No verified peers yet.";
      peers.append(none);
    }
  }

  recipientLabel(entry) {
    return entry.target ? fingerprintFromId(entry.target) : "everyone";
  }

  // ---- controls ------------------------------------------------------------
  setDisabled(button, disabled, why) {
    button.setAttribute("aria-disabled", String(disabled));
    button.title = disabled ? why : "";
    return disabled ? why : "";
  }

  refresh() {
    if (this.disposed) return;
    const list = this.recipients();
    this.renderRecipients(list);
    const block = this.blockReason();
    const caps = this.capabilityReasons();
    const { ui } = this;
    const busy = this.capture.isRecording();
    const why = (own) => own || block;
    // A coarse pointer has no Tab/Enter/Escape, so the picker instructions
    // would be a dead end. Explain that up front and block the action.
    const coarsePointer = Boolean(
      this.win?.matchMedia?.("(pointer: coarse)")?.matches,
    );
    ui.pickerText.textContent = coarsePointer
      ? TOUCH_PICKING_REASON
      : this.pickerInstructions;
    ui.input.disabled = Boolean(caps.message) || Boolean(block);
    ui.send.disabled = ui.input.disabled;
    const reasons = new Set(
      [caps.message && !block ? caps.message : "", block].filter(Boolean),
    );
    this.setDisabled(
      ui.action("element"),
      Boolean(why(caps.share)) || coarsePointer,
      coarsePointer ? TOUCH_PICKING_REASON : why(caps.share),
    );
    this.setDisabled(
      ui.action("screenshot"),
      Boolean(why(caps.media)) || busy,
      busy ? "Stop the recording first." : why(caps.media),
    );
    this.setDisabled(
      ui.action("record"),
      !busy && Boolean(why(caps.record)),
      why(caps.record),
    );
    if (!block)
      for (const reason of [caps.share, caps.media].filter(Boolean))
        reasons.add(reason);
    ui.hint.textContent = [...reasons].join(" ");
    this.renderWarning();
    this.dropWorkIfUnusable(block);
  }

  capabilityReasons() {
    const c = this.capabilities;
    const conn = this.connection;
    const messaging =
      typeof conn.sendText === "function" &&
      (!c || c.includes("messages.send"));
    const share = !c || c.includes("content.share");
    const canAttach = share && typeof conn.sendAttachment === "function";
    const display =
      typeof this.win?.navigator?.mediaDevices?.getDisplayMedia === "function";
    const none = "This connection did not approve content sharing.";
    return {
      message: messaging ? "" : "Messaging is unavailable in this connection.",
      share: share && typeof conn.sendElement === "function" ? "" : none,
      media: !canAttach
        ? none
        : display
          ? ""
          : "This browser cannot capture the screen.",
      record: !canAttach
        ? none
        : !display || !this.win.MediaRecorder
          ? "This browser cannot record the screen."
          : "",
    };
  }

  renderWarning() {
    const peer =
      this.selection === "everyone" ? "" : fingerprintFromId(this.selection);
    this.ui.warn.textContent = peer ? TARGET_WARNING(peer) : PUBLIC_WARNING;
  }

  // The session ended or the recipient vanished: stop capture, drop staged work.
  dropWorkIfUnusable(block) {
    if (!block) return;
    const status = this.snapshot?.status;
    if (!this.expired && status !== "expired" && status !== "disconnected")
      return;
    if (this.capture.isRecording() || this.capture.isLive()) {
      this.capture.cancel();
      this.setRecordingUi(false);
    }
    if (this.staged) this.discardStaged(block);
  }

  guarded(name, run) {
    const button = this.ui.action(name);
    if (button.getAttribute("aria-disabled") === "true") {
      this.say(button.title || "Unavailable right now.");
      return;
    }
    run();
  }

  // ---- sending -------------------------------------------------------------
  async deliver(kind, summary, sender, messageId = crypto.randomUUID()) {
    const block = this.blockReason();
    if (block) throw new Error(block);
    const target = this.selection === "everyone" ? undefined : this.selection;
    if (!this.ledger.get(messageId))
      this.ledger.begin({ messageId, kind, target, summary });
    this.ledger.queue(messageId);
    try {
      await sender({ messageId, ...(target ? { target } : {}) });
      if (this.ledger.get(messageId)?.state === "queued")
        this.ledger.markSent(messageId);
    } catch (error) {
      this.ledger.fail(messageId, error);
      throw error;
    }
  }

  async onSubmit(event) {
    event.preventDefault();
    const text = this.ui.input.value.trim();
    if (!text || this.ui.input.disabled || this.sendingText) return;
    this.sendingText = true;
    this.ui.input.value = "";
    try {
      await this.deliver("text", text, (o) =>
        this.connection.sendText(text, o),
      );
      this.say(
        "Submitted to the peer transport. Waiting for a signed receipt.",
      );
    } catch (error) {
      if (!this.ui.input.value) this.ui.input.value = text;
      this.say(error.message || "Could not send message.");
    } finally {
      this.sendingText = false;
    }
  }

  // ---- element selection ---------------------------------------------------
  startPicking() {
    this.selecting = true;
    this.ui.root.classList.add("picking");
    this.ui.picker.hidden = false;
    this.ui.action("stop-picking").focus();
    this.pick = {
      over: (e) => this.highlight(e.target, e),
      click: (e) => this.choose(e.target, e),
      focus: (e) => this.highlight(e.target, e),
      key: (e) => this.pickKey(e),
    };
    this.doc.addEventListener("pointerover", this.pick.over, true);
    this.doc.addEventListener("click", this.pick.click, true);
    this.doc.addEventListener("focusin", this.pick.focus, true);
    this.doc.addEventListener("keydown", this.pick.key, true);
  }

  stopPicking(message) {
    if (!this.selecting) return;
    this.selecting = false;
    this.ui.outline.style.display = "none";
    this.ui.root.classList.remove("picking");
    this.ui.picker.hidden = true;
    const { over, click, focus, key } = this.pick;
    this.doc.removeEventListener("pointerover", over, true);
    this.doc.removeEventListener("click", click, true);
    this.doc.removeEventListener("focusin", focus, true);
    this.doc.removeEventListener("keydown", key, true);
    if (message) {
      this.say(message);
      this.ui.action("element").focus();
    }
  }

  inside(event) {
    return event.composedPath?.().includes(this.ui.host);
  }

  highlight(node, event) {
    if (!this.selecting || this.inside(event) || !node?.getBoundingClientRect)
      return;
    const rect = node.getBoundingClientRect();
    Object.assign(this.ui.outline.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  pickKey(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.stopPicking("Element selection cancelled.");
    } else if (event.key === "Enter" && !this.inside(event)) {
      const active = this.doc.activeElement;
      if (active && active !== this.doc.body) this.choose(active, event);
    }
  }

  choose(node, event) {
    if (!this.selecting || this.inside(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopPicking();
    const described = describeElementForShare(node, this.win.location);
    if (described.blocked) {
      this.openPanel();
      this.say(
        "That element is private or sensitive (password, credential field, editable, or marked private) and cannot be shared.",
      );
      return;
    }
    this.stageElement(described);
  }

  openPanel() {
    this.ui.panel.hidden = false;
    this.ui.toggle.setAttribute("aria-expanded", "true");
    this.ui.toggle.setAttribute("aria-label", "Close collaboration");
  }

  // ---- staging, preview, confirm ------------------------------------------
  stage(item) {
    this.discardStaged();
    this.openPanel();
    const target = this.selection === "everyone" ? undefined : this.selection;
    const messageId = crypto.randomUUID();
    this.ledger.begin({
      messageId,
      kind: item.kind,
      target,
      summary: item.summary,
    });
    this.staged = { ...item, messageId };
    const { ui } = this;
    ui.previewBody.replaceChildren(...item.nodes(this.doc));
    ui.previewWarn.textContent =
      `${item.extraWarning ?? ""} ${this.selection === "everyone" ? PUBLIC_WARNING : TARGET_WARNING(fingerprintFromId(this.selection))}`.trim();
    ui.preview.hidden = false;
    ui.previewTitle.focus();
    this.say("Review what will be sent, then choose Send or Discard.");
  }

  stageElement({ metadata, omitted }) {
    const text = metadata.text || "(no visible text)";
    const note = omitted
      ? ` ${omitted} private or form-control region(s) were left out.`
      : "";
    this.stage({
      kind: "element",
      summary: `Element <${metadata.tag}> ${metadata.text}`.slice(0, 200),
      extraWarning: `Only the fields shown are sent; input values are never included.${note}`,
      send: (o) => this.connection.sendElement(metadata, o),
      nodes: (doc) => {
        const pre = doc.createElement("pre");
        pre.textContent = `<${metadata.tag}> ${text}\n${metadata.url}`;
        return [pre];
      },
    });
  }

  stageMedia(kind, blob, name) {
    const url = this.win.URL.createObjectURL(blob);
    this.objectUrls.add(url);
    const sensitive = countSensitiveRegions(this.doc);
    const extra = `Screen capture includes everything visible in the window or screen you picked.${sensitive ? ` This page has ${sensitive} private or sensitive field(s); they may be visible.` : ""}`;
    this.stage({
      kind,
      summary: `${kind} (${Math.ceil(blob.size / 1024)} KiB)`,
      extraWarning: extra,
      url,
      send: (o) => this.connection.sendAttachment(blob, { kind, name, ...o }),
      nodes: (doc) => {
        const node = doc.createElement(kind === "screenshot" ? "img" : "video");
        node.src = url;
        if (kind === "screenshot") node.alt = "Screenshot preview";
        else Object.assign(node, { controls: true, muted: true });
        const size = doc.createElement("p");
        size.textContent = `${name}, ${Math.ceil(blob.size / 1024)} KiB`;
        return [node, size];
      },
    });
  }

  discardStaged(message) {
    const staged = this.staged;
    if (!staged) return;
    this.staged = null;
    this.ledger.discard(staged.messageId);
    this.entries.get(staged.messageId)?.remove();
    this.entries.delete(staged.messageId);
    if (staged.url) this.releaseUrl(staged.url);
    this.ui.preview.hidden = true;
    this.ui.previewBody.replaceChildren();
    if (message) this.say(message);
  }

  releaseUrl(url) {
    this.win.URL.revokeObjectURL(url);
    this.objectUrls.delete(url);
  }

  async confirmStaged() {
    const staged = this.staged;
    if (!staged) return;
    this.staged = null;
    this.ui.preview.hidden = true;
    this.ui.previewBody.replaceChildren();
    try {
      await this.deliver(
        staged.kind,
        staged.summary,
        staged.send,
        staged.messageId,
      );
      this.say(
        "Submitted to the peer transport. Waiting for a signed receipt.",
      );
    } catch (error) {
      this.say(error.message || "Could not share.");
    } finally {
      if (staged.url) this.releaseUrl(staged.url);
    }
    this.ui
      .action(staged.kind === "element" ? "element" : "screenshot")
      .focus();
  }

  // ---- screen capture ------------------------------------------------------
  async takeScreenshot() {
    this.say("Choose what to capture in your browser's picker.");
    try {
      const blob = await this.capture.screenshot();
      if (blob && !this.disposed)
        this.stageMedia("screenshot", blob, "screenshot.jpg");
    } catch (error) {
      this.say(error.message || "Screenshot cancelled.");
    }
  }

  async toggleRecording() {
    if (this.capture.isRecording()) return this.capture.stopRecording();
    this.say("Choose what to record in your browser's picker.");
    try {
      const blob = await this.capture.record(() => this.setRecordingUi(true));
      this.setRecordingUi(false);
      if (!blob || this.disposed) return;
      if (blob.size > MEDIA_LIMITS.recordingBytes)
        throw new Error(
          "Recording exceeds the 1 MiB sharing limit. Try a shorter recording.",
        );
      this.stageMedia("recording", blob, "recording.webm");
    } catch (error) {
      this.setRecordingUi(false);
      this.say(error.message || "Recording cancelled.");
    }
  }

  setRecordingUi(on) {
    this.ui.action("record").textContent = on
      ? "Stop recording"
      : "Record screen";
    this.ui.action("cancel-record").hidden = !on;
    if (on)
      this.say("Recording. Stop to review; recordings are limited to 1 MiB.");
    this.refresh();
  }

  cancelRecording(quiet) {
    this.capture.cancel();
    this.setRecordingUi(false);
    if (!quiet) this.say("Recording cancelled. Nothing was sent.");
  }

  // ---- incoming events and the message log ---------------------------------
  onEvent(event) {
    if (event.type === "receipt") {
      if (this.supportsReceipts) this.ledger.applyReceipt(event.receipt);
      return;
    }
    this.inbox = this.inbox
      .then(() => this.showIncoming(event))
      .catch(() => {});
  }

  async whoIs(event) {
    const body = event.envelope?.body;
    const key = event.envelope?.proof?.publicKey;
    const verified =
      key && body?.issuer ? await verifyPeerKey(key, body.issuer) : null;
    if (verified) this.known = rememberPeer(this.known, verified);
    return verified ? verified.fingerprint : "unverified peer";
  }

  async showIncoming(event) {
    const who = await this.whoIs(event);
    if (this.disposed) return;
    if (event.type === "text" && typeof event.text === "string")
      this.addLine(who, event.text.slice(0, 4000));
    else if (event.type === "element")
      this.addLine(
        who,
        `Shared element: ${event.metadata?.tag ?? "element"} ${event.metadata?.text ?? ""}`.slice(
          0,
          1500,
        ),
      );
    else if (event.type === "attachment" && event.blob instanceof this.win.Blob)
      this.addAttachment(who, event);
    this.refresh();
  }

  line(...children) {
    const entry = this.doc.createElement("p");
    entry.className = "entry";
    entry.append(...children);
    this.ui.log.append(entry);
    while (this.ui.log.childNodes.length > 100) this.ui.log.firstChild.remove();
    this.ui.log.scrollTop = this.ui.log.scrollHeight;
    return entry;
  }

  addLine(who, text) {
    const label = this.doc.createElement("span");
    label.className = "who";
    label.textContent = `${who}: `;
    return this.line(label, this.doc.createTextNode(text));
  }

  addAttachment(who, event) {
    const url = this.win.URL.createObjectURL(event.blob);
    this.objectUrls.add(url);
    const link = this.doc.createElement("a");
    link.href = url;
    link.download = String(event.name ?? "attachment").slice(0, 120);
    link.textContent = `${who} shared ${link.download}`;
    this.line(link);
  }

  stateText(entry) {
    if (entry.state === "sent-to-transport")
      return this.supportsReceipts
        ? "Sent to transport. Not confirmed delivered."
        : "Sent to transport. This connection cannot confirm delivery.";
    if (entry.state === "received-by-peer")
      return `Signed receipt from ${entry.receivers.map(fingerprintFromId).join(", ")}. A receipt does not mean anyone read it.`;
    if (entry.state === "failed") return `Failed: ${entry.error}`;
    return STATE_LABEL[entry.state];
  }

  renderEntry(entry) {
    if (this.disposed) return;
    let node = this.entries.get(entry.messageId);
    if (!node) {
      node = this.addLine(
        `You to ${this.recipientLabel(entry)}`,
        entry.summary,
      );
      const state = this.doc.createElement("span");
      state.className = "state";
      node.append(state);
      this.entries.set(entry.messageId, node);
    }
    node.querySelector(".state").textContent = this.stateText(entry);
  }

  // ---- teardown ------------------------------------------------------------
  dispose() {
    if (this.disposed) return;
    this.stopPicking();
    this.capture.cancel();
    this.disposed = true;
    clearInterval(this.timer);
    for (const url of [...this.objectUrls]) this.releaseUrl(url);
    for (const off of this.unsubscribers) off?.();
    this.ui.host.remove();
  }
}
