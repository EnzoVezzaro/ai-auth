import {
  NonceGuard,
  createPermissionRequest,
  verifyPermissionConsent,
} from "./connect.js";
import { verifyEnvelope } from "./index.js";
import {
  markVerifiedPageConnection,
  revokeVerifiedPageConnection,
} from "./session.js";

const CAPABILITY_FOR_EVENT = {
  "peer/hello": "presence.read",
  "peer/heartbeat": "presence.read",
  "peer/goodbye": "presence.read",
  "presence/cursor": "presence.read",
  "message/text": "messages.send",
  "agent/action": "tools.invoke",
};
const debug = (stage, details = "") => {
  if (
    new URLSearchParams(globalThis.location?.search ?? "").get("debug") === "1"
  )
    console.info("[AI Auth debug]", stage, details);
};

function walletPageUrl(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol))
    throw new TypeError("Wallet URL must use HTTP or HTTPS");
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  ) {
    throw new TypeError(
      "Wallet pages must use HTTPS outside local development",
    );
  }
  url.searchParams.set("connect", "1");
  return url;
}

export async function connectAIAuthPopup({
  walletUrl,
  capabilities,
  room = "default",
  origin = globalThis.location?.origin,
  timeoutMs = 120_000,
  windowObject = globalThis.window,
} = {}) {
  if (!windowObject || typeof windowObject.open !== "function")
    throw new Error("AI Auth popup connections require a browser window");
  if (typeof origin !== "string")
    throw new TypeError("A site origin is required");
  const target = new URL(origin);
  if (
    target.origin !== origin ||
    !["https:", "http:"].includes(target.protocol)
  )
    throw new TypeError("Site origin must be an exact HTTP origin");
  const walletPage = walletPageUrl(walletUrl);
  const popup = windowObject.open(
    "about:blank",
    "ai-auth-wallet",
    "popup,width=440,height=720",
  );
  if (!popup) throw new Error("Allow the AI Auth wallet popup to continue");

  const request = await createPermissionRequest(origin, capabilities, { room });
  const consentGuard = new NonceGuard();
  const seen = new Map();
  const listeners = new Set();
  let consent;
  let resolveReady;
  let rejectReady;
  let timeout;
  let expiryTimer;
  let activeConnection;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const cleanup = () => {
    clearTimeout(timeout);
    clearTimeout(expiryTimer);
    windowObject.removeEventListener("message", onMessage);
  };

  const onMessage = async (event) => {
    if (event.source !== popup || event.origin !== walletPage.origin) return;
    if (consent?.body?.payload?.expiresAt <= Date.now()) {
      activeConnection?.close();
      return;
    }
    debug("wallet-message", event.data?.type);
    if (event.data?.type === "ai-auth/connect-ready") {
      popup.postMessage(
        { type: "ai-auth/connect-request", request },
        walletPage.origin,
      );
      return;
    }
    if (event.data?.type === "ai-auth/connect-rejected") {
      cleanup();
      popup.close();
      rejectReady(new Error("The wallet declined this site request"));
      return;
    }
    if (event.data?.type === "ai-auth/connect-consent" && !consent) {
      const candidate = event.data.consent;
      const expectedWallet = candidate?.body?.issuer;
      const valid = await verifyPermissionConsent(candidate, request, {
        expectedOrigin: origin,
        expectedWallet,
        nonceGuard: consentGuard,
      });
      if (!valid) {
        cleanup();
        rejectReady(new Error("The wallet consent could not be verified"));
        return;
      }
      consent = candidate;
      clearTimeout(timeout);
      timeout = undefined;
      resolveReady(createConnection());
      return;
    }
    if (event.data?.type !== "ai-auth/collaboration-event" || !consent) return;
    const envelope = event.data.envelope;
    debug("sdk-collaboration-envelope", envelope?.body?.type);
    const capability = CAPABILITY_FOR_EVENT[envelope?.body?.type];
    if (
      !capability ||
      !consent.body.payload.capabilities.includes(capability)
    ) {
      debug("sdk-rejected-capability", capability);
      return;
    }
    const payload = envelope?.body?.payload;
    if (
      payload?.origin !== origin ||
      payload?.room !== (request.room ?? "default") ||
      typeof payload.session !== "string" ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length < 20 ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt > Date.now() + 125_000
    )
      return;
    if (
      envelope.body.type === "presence/cursor" &&
      (!Number.isFinite(payload.x) ||
        !Number.isFinite(payload.y) ||
        payload.x < 0 ||
        payload.x > 1 ||
        payload.y < 0 ||
        payload.y > 1 ||
        (payload.visible !== undefined && typeof payload.visible !== "boolean"))
    )
      return;
    if (
      envelope.body.type === "message/text" &&
      (typeof payload.text !== "string" || payload.text.length > 3000)
    )
      return;
    if (
      envelope.body.type === "agent/action" &&
      (typeof payload.name !== "string" ||
        !/^[a-z][a-z0-9._-]{0,63}$/u.test(payload.name) ||
        !["started", "progress", "completed", "failed", "needs-human"].includes(
          payload.state,
        ) ||
        typeof payload.summary !== "string" ||
        payload.summary.length > 240)
    )
      return;
    const replayKey = `${envelope.body.issuer}:${payload.session}:${payload.nonce}`;
    for (const [key, expiresAt] of seen)
      if (expiresAt <= Date.now()) seen.delete(key);
    if (seen.has(replayKey) || seen.size >= 4096) return;
    if (!(await verifyEnvelope(envelope))) {
      debug("sdk-rejected-signature", envelope?.body?.type);
      return;
    }
    seen.set(replayKey, payload.expiresAt);
    debug("sdk-event-accepted", envelope.body.type);
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch {
        // An application listener cannot block other collaboration listeners.
      }
    }
  };

  function createConnection() {
    let closed = false;
    const connection = Object.freeze({
      request,
      consent,
      capabilities: Object.freeze([...consent.body.payload.capabilities]),
      onEvent(listener) {
        if (typeof listener !== "function")
          throw new TypeError("An event listener function is required");
        if (consent.body.payload.expiresAt <= Date.now()) {
          connection.close();
          return () => {};
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publishAction({ name, state, summary }) {
        if (consent.body.payload.expiresAt <= Date.now()) connection.close();
        if (closed) throw new Error("The AI Auth connection is closed");
        if (!consent.body.payload.capabilities.includes("tools.invoke"))
          throw new Error("This wallet did not approve site action sharing");
        if (
          typeof name !== "string" ||
          !/^[a-z][a-z0-9._-]{0,63}$/u.test(name) ||
          ![
            "started",
            "progress",
            "completed",
            "failed",
            "needs-human",
          ].includes(state) ||
          typeof summary !== "string" ||
          summary.length > 240
        )
          throw new TypeError(
            "Site action events need a valid name, state, and short summary",
          );
        popup.postMessage(
          { type: "ai-auth/site-action", action: { name, state, summary } },
          walletPage.origin,
        );
      },
      publishCursor({ x, y, visible = true }) {
        if (consent.body.payload.expiresAt <= Date.now()) connection.close();
        if (closed) return;
        if (!consent.body.payload.capabilities.includes("presence.read"))
          return;
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          x > 1 ||
          y < 0 ||
          y > 1
        )
          return;
        popup.postMessage(
          { type: "ai-auth/site-cursor", cursor: { x, y, visible } },
          walletPage.origin,
        );
      },
      close() {
        if (closed) return;
        closed = true;
        revokeVerifiedPageConnection(connection);
        cleanup();
        popup.close();
        listeners.clear();
      },
    });
    activeConnection = connection;
    expiryTimer = setTimeout(
      () => connection.close(),
      Math.max(0, consent.body.payload.expiresAt - Date.now()),
    );
    markVerifiedPageConnection(connection, consent);
    return connection;
  }

  windowObject.addEventListener("message", onMessage);
  timeout = setTimeout(() => {
    cleanup();
    popup.close();
    rejectReady(new Error("AI Auth wallet consent timed out"));
  }, timeoutMs);
  popup.location.href = walletPage.href;
  return ready;
}

export function mountAIAuthCollaboration(
  connection,
  { target = globalThis.document?.body } = {},
) {
  if (!connection || typeof connection.onEvent !== "function")
    throw new TypeError("A connected AI Auth page session is required");
  if (!target || !target.ownerDocument)
    throw new TypeError("A page element is required for collaboration cursors");
  const document = target.ownerDocument;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;pointer-events:none;overflow:hidden";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .cursor { position: fixed; transform: translate(-2px,-2px); color: #fff; }
    .cursor svg { display:block; filter: drop-shadow(0 1px 2px #0008); }
    .label { display:block; margin:2px 0 0 10px; padding:3px 7px; border-radius:4px; background:#245d4e; color:#fff; font:12px/1.3 system-ui,sans-serif; white-space:nowrap; }
  `;
  const layer = document.createElement("div");
  shadow.append(style, layer);
  target.append(host);
  const cursors = new Map();
  const unsubscribe = connection.onEvent((envelope) => {
    if (envelope.body.type !== "presence/cursor") return;
    const payload = envelope.body.payload;
    const key = `${envelope.body.issuer}:${payload.session}`;
    if (payload.visible === false) cursors.delete(key);
    else cursors.set(key, { x: payload.x, y: payload.y, name: payload.label });
    render();
  });

  function render() {
    layer.replaceChildren();
    for (const cursor of cursors.values()) {
      const node = document.createElement("div");
      node.className = "cursor";
      node.style.left = `${cursor.x * 100}%`;
      node.style.top = `${cursor.y * 100}%`;
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      icon.setAttribute("width", "18");
      icon.setAttribute("height", "22");
      icon.setAttribute("viewBox", "0 0 18 22");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("fill", "#245d4e");
      path.setAttribute("stroke", "white");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("d", "M1 1v17l4.5-4.5 3.3 6.1 3-1.6-3.1-6.1h6.1z");
      icon.append(path);
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = String(cursor.name ?? "Agent").slice(0, 60);
      node.append(icon, label);
      layer.append(node);
    }
  }

  let lastSentAt = 0;
  const publish = (event) => {
    const now = Date.now();
    if (now - lastSentAt < 450) return;
    lastSentAt = now;
    connection.publishCursor({
      x: Math.max(
        0,
        Math.min(
          1,
          event.clientX / Math.max(1, document.documentElement.clientWidth),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          1,
          event.clientY / Math.max(1, document.documentElement.clientHeight),
        ),
      ),
    });
  };
  const leave = () => connection.publishCursor({ x: 0, y: 0, visible: false });
  target.addEventListener("pointermove", publish, { passive: true });
  target.addEventListener("pointerleave", leave);

  return () => {
    unsubscribe();
    target.removeEventListener("pointermove", publish);
    target.removeEventListener("pointerleave", leave);
    host.remove();
  };
}
