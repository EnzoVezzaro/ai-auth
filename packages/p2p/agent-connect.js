import {
  CONNECT_LABEL,
  DISCONNECTED_BY_USER_MESSAGE,
  EXTEND_LABEL,
  RECONNECT_LABEL,
  RELOAD_NOTICE,
  sessionEndText,
} from "./copy.js";

const DEFAULT_SDK_SOURCE = "https://esm.sh/@enzovezzaro/ai-auth-wallet";
const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9]+)*$/u;

function exactHttpOrigin(value, message) {
  if (typeof value !== "string") throw new TypeError(message);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(message);
  }
  if (
    url.origin !== value ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new TypeError(message);
  }
  return value;
}

function httpUrl(value, message, protocolMessage = message) {
  if (typeof value !== "string") throw new TypeError(message);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(message);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new TypeError(protocolMessage);
  }
  return url.href;
}

function walletHttpUrl(value) {
  return httpUrl(
    value,
    "A valid wallet URL is required",
    "Wallet URLs must use HTTPS outside local development",
  );
}

function cleanLabel(value, maxLength = 60) {
  if (typeof value !== "string") return null;
  const label = value
    .replaceAll(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, maxLength);
  return label || null;
}

/**
 * Builds the canonical, copyable connect instruction a site publishes so any
 * agent can join its shared space. The instruction contains only public data:
 * site origin, room name, wallet URL, and the requested capabilities. It never
 * includes credentials or secrets.
 */
export function createAIAuthConnectInstruction({
  siteOrigin,
  walletUrl,
  capabilities,
  room = "default",
  siteName,
  sdkSource = DEFAULT_SDK_SOURCE,
} = {}) {
  const origin = exactHttpOrigin(
    siteOrigin,
    "A site origin is required and must be an exact HTTP origin",
  );
  const wallet = walletHttpUrl(walletUrl);
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    !capabilities.every(
      (capability) =>
        typeof capability === "string" && CAPABILITY_PATTERN.test(capability),
    )
  ) {
    throw new TypeError(
      "Capabilities must be a non-empty array of capability names",
    );
  }
  if (typeof room !== "string" || !ROOM_PATTERN.test(room)) {
    throw new TypeError("Room names must be 1–100 safe characters");
  }
  if (sdkSource !== DEFAULT_SDK_SOURCE)
    httpUrl(sdkSource, "The SDK source must be a valid HTTP(S) URL");
  // Match createPermissionRequest's canonical capability normalization so
  // copyable instructions cannot advertise scopes the wallet will reject.
  const uniqueCapabilities = Object.freeze([...new Set(capabilities)].sort());
  const meta = {
    protocol: "ai-auth-wallet",
    version: 1,
    siteName: cleanLabel(siteName),
    origin,
    room,
    walletUrl: wallet,
    capabilities: uniqueCapabilities,
  };
  const lines = [
    `# ${meta.siteName ?? "Site"} — AI Auth agent connect`,
    `Origin: ${origin}`,
    `Room: ${room}`,
    `Wallet: ${wallet}`,
    `Capabilities: ${uniqueCapabilities.join(", ")}`,
    "",
    "Run this inside the agent's browser page. A user gesture opens the",
    "wallet modal; the handshake completes after the wallet owner approves",
    "the request.",
    "",
    `import { connectAIAuthModal } from ${JSON.stringify(sdkSource)};`,
    "",
    "const connection = await connectAIAuthModal({",
    `  origin: ${JSON.stringify(origin)},`,
    `  walletUrl: ${JSON.stringify(wallet)},`,
    `  capabilities: ${JSON.stringify(uniqueCapabilities)},`,
    `  room: ${JSON.stringify(room)},`,
    "});",
    "",
    "connection.onLifecycle((event) => {",
    '  // "connected" fires right after the signed wallet handshake;',
    '  // "disconnected" fires when the wallet closes the connection or it',
    "  // expires.",
    "  console.log(event.type, event.identity?.id, event.capabilities);",
    "});",
  ];
  return Object.freeze({
    ...meta,
    instruction: lines.join("\n"),
    json: JSON.stringify(meta),
  });
}

/**
 * Framework-free connection state machine for a site connect panel. It owns
 * the connect/handshake/connected/disconnected transitions and reflects the
 * signed lifecycle events of the active connection.
 */
export function createAIAuthConnectController({ connect, instruction } = {}) {
  const instructionText =
    typeof instruction === "string" ? instruction : instruction?.instruction;
  if (instructionText !== undefined && typeof instructionText !== "string")
    throw new TypeError(
      "The connect instruction must be a string or an instruction object",
    );
  if (connect !== undefined && typeof connect !== "function")
    throw new TypeError("The connect option must be an async function");

  const listeners = new Set();
  let state = { status: "idle", error: null };
  let lifecycleUnsubscribe = null;
  let activeConnection = null;
  let connectingToken = 0;
  let closed = false;
  let userClosing = false;

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {}
    }
  };
  const setState = (next) => {
    state = next;
    notify();
  };

  function detachConnection() {
    if (lifecycleUnsubscribe) {
      const unsubscribe = lifecycleUnsubscribe;
      lifecycleUnsubscribe = null;
      unsubscribe();
    }
  }

  function attachConnection(connection) {
    if (
      !connection ||
      typeof connection.onLifecycle !== "function" ||
      typeof connection.close !== "function"
    ) {
      throw new TypeError("A connected AI Auth page connection is required");
    }
    if (closed) {
      try {
        connection.close();
      } catch {}
      return;
    }
    if (activeConnection && activeConnection !== connection) {
      const previous = activeConnection;
      detachConnection();
      activeConnection = null;
      try {
        previous.close();
      } catch {}
    }
    detachConnection();
    activeConnection = connection;
    lifecycleUnsubscribe = connection.onLifecycle((event) => {
      if (closed || activeConnection !== connection) return;
      if (event?.type === "connected" || event?.type === "renewed") {
        setState({
          status: "connected",
          connection,
          label: event.label ?? "Connected agent",
          identity: event.identity ?? { id: "", name: null },
          capabilities: Object.freeze([...(event.capabilities ?? [])]),
          expiresAt: event.expiresAt,
        });
        return;
      }
      if (event?.type === "disconnected") {
        detachConnection();
        activeConnection = null;
        setState({
          status: "disconnected",
          reason: userClosing
            ? "user"
            : ["expired", "idle", "revoked"].includes(event.reason)
              ? event.reason
              : "closed",
        });
      }
    });
  }

  async function start() {
    if (closed) throw new Error("The connect panel controller is closed");
    if (typeof connect !== "function")
      throw new TypeError("A connect function is required to connect");
    if (state.status === "connecting" || state.status === "connected") return;
    const token = ++connectingToken;
    detachConnection();
    setState({ status: "connecting" });
    try {
      const connection = await connect();
      if (closed || token !== connectingToken) {
        try {
          connection?.close?.();
        } catch {}
        return;
      }
      attachConnection(connection);
    } catch (error) {
      if (token !== connectingToken) return;
      const message = cleanLabel(
        error?.message ? String(error.message) : String(error),
        200,
      );
      setState({ status: "idle", error: message ?? "Connection failed" });
    }
  }

  function disconnect() {
    if (state.status !== "connected") return;
    // The lifecycle event from this close is the user's own action, so it is
    // reported as "user" rather than as a generic close.
    userClosing = true;
    try {
      state.connection.close();
    } catch {
    } finally {
      userClosing = false;
    }
    // A compliant connection emits "disconnected" on close, but fail closed
    // even if an external adapter does not emit the lifecycle event.
    if (state.status === "connected") {
      detachConnection();
      activeConnection = null;
      setState({ status: "disconnected", reason: "user" });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (typeof listener !== "function")
        throw new TypeError("A state listener function is required");
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    connect: start,
    disconnect,
    setConnection: attachConnection,
    close() {
      if (closed) return;
      closed = true;
      ++connectingToken;
      const connection = activeConnection;
      activeConnection = null;
      detachConnection();
      listeners.clear();
      state = { status: "disconnected", reason: "closed" };
      // Unmounting the panel must not leave an invisible wallet iframe,
      // signed session, or direct peer transport running.
      try {
        connection?.close();
      } catch {}
    },
  };
}

const DISCONNECT_REASON_TEXT = Object.freeze({
  expired: "Connection expired.",
  idle: "Disconnected after an idle timeout.",
  revoked: "Session ended by the wallet.",
});

/**
 * The one status sentence the connect panel shows, in plain words. `reloaded`
 * is true when this page was reloaded, which ended any earlier connection.
 */
export function connectPanelStatusText(state, { reloaded = false } = {}) {
  if (state.status === "connecting")
    return "Waiting for your approval in the wallet window.";
  if (state.status === "connected") return "Connected.";
  if (state.status === "disconnected") {
    if (state.reason === "user") return DISCONNECTED_BY_USER_MESSAGE;
    return DISCONNECT_REASON_TEXT[state.reason] ?? "Disconnected.";
  }
  return reloaded ? RELOAD_NOTICE : "Not connected.";
}

/** The label of the panel's main button for the given state. */
export function connectPanelButtonLabel(state, { reloaded = false } = {}) {
  if (state.status === "connecting") return "Connecting…";
  return reloaded && state.status === "idle" ? RECONNECT_LABEL : CONNECT_LABEL;
}

function pageWasReloaded() {
  try {
    const [entry] =
      globalThis.performance?.getEntriesByType?.("navigation") ?? [];
    return entry?.type === "reload";
  } catch {
    return false;
  }
}

/**
 * Renders the site connect panel: the copyable agent connect instruction plus
 * a live status area that reflects the wallet handshake and the signed
 * connection lifecycle. The host element mirrors the state as `data-status`
 * (`idle`, `connecting`, `connected`, or `disconnected`). Returns a dismount
 * function.
 */
export function mountAIAuthConnectPanel({
  instruction,
  connect,
  target = globalThis.document?.body,
  label = "Connect your agent",
  onStateChange,
  reloaded = pageWasReloaded(),
} = {}) {
  if (!target || !target.ownerDocument)
    throw new TypeError(
      "A page element is required for the AI Auth connect panel",
    );
  if (onStateChange !== undefined && typeof onStateChange !== "function")
    throw new TypeError("The onStateChange callback must be a function");
  const document = target.ownerDocument;
  const instructionText =
    typeof instruction === "string" ? instruction : instruction?.instruction;
  if (typeof instructionText !== "string" || !instructionText.trim())
    throw new TypeError(
      "A connect instruction (string or instruction object) is required",
    );
  const controller = createAIAuthConnectController({ connect, instruction });
  const heading = cleanLabel(label, 80) ?? "Connect your agent";

  const host = document.createElement("div");
  host.setAttribute("data-ai-auth-connect-panel", "");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .panel { display:block; max-width:560px; box-sizing:border-box; border:1px solid #d8e0dc; border-radius:12px; padding:16px; font:14px/1.45 system-ui,sans-serif; color:#1c2b26; background:#fff; }
    .head { display:flex; align-items:center; gap:10px; margin:0 0 10px; }
    .head h3 { margin:0; font-size:16px; font-weight:600; }
    .status { display:flex; align-items:center; gap:8px; min-height:24px; margin:0 0 10px; }
    .dot { width:10px; height:10px; border-radius:50%; background:#9aa8a2; flex:none; }
    .dot.connecting { background:#b98a1c; }
    .dot.connected { background:#245d4e; }
    .dot.disconnected { background:#b3261e; }
    .status-text { font-weight:500; }
    .detail { margin:0 0 10px; font-size:13px; color:#4c5b55; overflow-wrap:anywhere; }
    .detail b { font-weight:600; color:#1c2b26; }
    .chips { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 10px; padding:0; list-style:none; }
    .chip { padding:2px 8px; border-radius:999px; background:#eef3f0; font:12px/1.6 system-ui,sans-serif; }
    .error { margin:0 0 10px; font-size:13px; color:#b3261e; }
    pre { margin:0 0 10px; padding:10px; border-radius:8px; background:#f4f7f5; border:1px solid #e2e9e5; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; overflow-wrap:anywhere; max-height:220px; overflow:auto; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    button { padding:8px 14px; border-radius:8px; border:1px solid #245d4e; background:#245d4e; color:#fff; font:14px/1.2 system-ui,sans-serif; cursor:pointer; }
    button[aria-disabled="true"] { opacity:0.6; cursor:default; }
    button.secondary { background:#fff; color:#245d4e; }
    .note { margin:10px 0 0; font-size:12px; color:#6b7a73; }
  `;
  const panel = document.createElement("div");
  panel.className = "panel";
  const head = document.createElement("div");
  head.className = "head";
  const headingElement = document.createElement("h3");
  headingElement.textContent = heading;
  head.append(headingElement);
  const status = document.createElement("div");
  status.className = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");
  const statusText = document.createElement("span");
  statusText.className = "status-text";
  status.append(dot, statusText);
  const detail = document.createElement("p");
  detail.className = "detail";
  const chips = document.createElement("ul");
  chips.className = "chips";
  chips.setAttribute("aria-label", "Approved capabilities");
  const errorLine = document.createElement("p");
  errorLine.className = "error";
  errorLine.setAttribute("aria-live", "polite");
  const pre = document.createElement("pre");
  pre.textContent = instructionText;
  const actions = document.createElement("div");
  actions.className = "actions";
  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Connection details are public: origin, room, and capabilities. No secrets are included.";
  panel.append(head, status, detail, chips, errorLine, pre, actions, note);
  shadow.append(style, panel);
  target.append(host);

  let countdownTimer = null;
  let copyTimer = null;

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "secondary";
  copyButton.textContent = "Copy instruction";
  copyButton.addEventListener("click", async () => {
    const copied = await copyText(instructionText);
    copyButton.textContent = copied ? "Copied" : "Copy failed";
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyButton.textContent = "Copy instruction";
    }, 2000);
  });

  // Set while a connect attempt started from this panel is open. When it
  // settles, focus goes back to the panel's button, because the wallet window
  // that had focus has closed.
  let returnFocusOnSettle = false;
  let reloadNotice = reloaded === true;
  const connectButton = document.createElement("button");
  connectButton.type = "button";
  connectButton.textContent = CONNECT_LABEL;
  connectButton.addEventListener("click", () => {
    // aria-disabled (not disabled) keeps the button focusable while connecting.
    if (connectButton.getAttribute("aria-disabled") === "true") return;
    reloadNotice = false;
    returnFocusOnSettle = true;
    controller.connect().catch(() => {});
  });
  const disconnectButton = document.createElement("button");
  disconnectButton.type = "button";
  disconnectButton.className = "secondary";
  disconnectButton.textContent = "Disconnect";
  disconnectButton.addEventListener("click", () => controller.disconnect());
  const renewButton = document.createElement("button");
  renewButton.type = "button";
  renewButton.className = "secondary";
  renewButton.textContent = EXTEND_LABEL;
  renewButton.addEventListener("click", () => {
    const connection = controller.getState().connection;
    if (!connection?.renew) return;
    if (renewButton.getAttribute("aria-disabled") === "true") return;
    renewButton.setAttribute("aria-disabled", "true");
    connection
      .renew()
      .then(() => {
        errorLine.hidden = true;
      })
      .catch((error) => {
        // A declined or timed-out renewal says the session is still active.
        errorLine.textContent = error?.message ?? "Renewal did not finish.";
        errorLine.hidden = false;
      })
      .finally(() => {
        renewButton.removeAttribute("aria-disabled");
        renewButton.focus();
      });
  });

  const stopCountdown = () => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  function renderChips(capabilities) {
    chips.replaceChildren();
    for (const capability of capabilities) {
      const chip = document.createElement("li");
      chip.className = "chip";
      chip.textContent = capability;
      chips.append(chip);
    }
    chips.hidden = capabilities.length === 0;
  }

  function render(state) {
    stopCountdown();
    // Mirror the live state onto the light-DOM host so the rest of the site can
    // reflect the connection with CSS or a selector, without reading the
    // closed shadow root.
    host.dataset.status = state.status;
    dot.className = `dot ${state.status}`;
    detail.replaceChildren();
    errorLine.textContent = state.error ?? "";
    errorLine.hidden = !state.error;
    renderChips([]);
    actions.replaceChildren(copyButton);
    statusText.textContent = connectPanelStatusText(state, {
      reloaded: reloadNotice,
    });
    detail.hidden = true;
    chips.hidden = true;
    const connecting = state.status === "connecting";
    connectButton.textContent = connectPanelButtonLabel(state, {
      reloaded: reloadNotice,
    });
    if (connecting) connectButton.setAttribute("aria-disabled", "true");
    else connectButton.removeAttribute("aria-disabled");
    if (state.status === "connected") {
      detail.hidden = false;
      const name = document.createElement("b");
      name.textContent = state.label || state.identity?.name || "Agent";
      detail.append("Connected as ", name);
      renderChips(state.capabilities);
      const expiresLabel = document.createElement("span");
      const updateCountdown = () => {
        expiresLabel.textContent = sessionEndText(state.expiresAt);
      };
      updateCountdown();
      detail.append(" · ", expiresLabel);
      countdownTimer = setInterval(updateCountdown, 1000);
      disconnectButton.textContent = "Disconnect";
      actions.append(renewButton, disconnectButton);
    } else {
      actions.append(connectButton);
    }
    if (returnFocusOnSettle && !connecting) {
      returnFocusOnSettle = false;
      (state.status === "connected" ? disconnectButton : connectButton).focus();
    }
  }

  const unsubscribe = controller.subscribe((state) => {
    render(state);
    if (onStateChange) {
      try {
        onStateChange(state);
      } catch {}
    }
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        return copied;
      } catch {
        return false;
      }
    }
  }

  return () => {
    unsubscribe();
    controller.close();
    stopCountdown();
    clearTimeout(copyTimer);
    host.remove();
  };
}
