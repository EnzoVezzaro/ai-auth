import { approvePermissionRequest, createCapabilityGrant } from "./index.js";

export class AIAuthServiceError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = "AIAuthServiceError";
    this.status = status;
    this.details = details;
  }
}

const TERMINAL_PRESENCE_CLOSE_CODES = new Set([4401, 4403]);

function serviceUrl(value) {
  const url = new URL(value);
  if (url.username || url.password)
    throw new TypeError(
      "Credentials must not be embedded in the AI Auth service URL",
    );
  if (url.search || url.hash)
    throw new TypeError(
      "AI Auth service URL must not contain a query or fragment",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  ) {
    throw new TypeError("AI Auth service URL must use HTTPS or localhost HTTP");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

function presenceSocketUrl(base, tenantId, room) {
  const url = new URL(
    `v1/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(room)}/events`,
    `${base.href}/`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function forwardPresenceMessage(data, onEvent, beforeEvent) {
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    onEvent({
      type: "error",
      error: "Invalid event from AI Auth service",
    });
    return null;
  }
  beforeEvent?.(payload);
  onEvent(payload);
  return payload;
}

function createReconnectingPresenceConnection({
  session,
  url,
  onEvent,
  webSocketFactory,
  expiresAt,
  minDelayMs,
  maxDelayMs,
  maxReconnectAttempts,
}) {
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let authenticated = false;
  let closed = false;
  let expiryTimer = null;

  function emit(payload) {
    onEvent(payload);
  }

  function clearTimers() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  }

  function terminate({ code, terminal }) {
    if (closed) return;
    closed = true;
    authenticated = false;
    clearTimers();
    const activeSocket = socket;
    socket = null;
    activeSocket?.close(
      code ?? 1000,
      code === 4401 ? "session expired" : "connection ended",
    );
    emit({
      type: "connection.closed",
      ...(code === undefined ? {} : { code }),
      terminal,
    });
  }

  function openSocket() {
    if (closed) return;
    if (Date.now() >= expiresAt) {
      terminate({ code: 4401, terminal: true });
      return;
    }
    let nextSocket;
    try {
      nextSocket = webSocketFactory(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      if (closed || socket !== nextSocket) return;
      try {
        nextSocket.send(
          JSON.stringify({ type: "authenticate", token: session.token }),
        );
      } catch {
        nextSocket.close(1011, "authentication frame failed");
      }
    });
    nextSocket.addEventListener("message", (event) => {
      if (closed || socket !== nextSocket) return;
      forwardPresenceMessage(event.data, emit, (payload) => {
        if (payload?.type === "session.authenticated") {
          authenticated = true;
          reconnectAttempts = 0;
        }
      });
    });
    nextSocket.addEventListener("close", (event) => {
      if (socket === nextSocket) {
        socket = null;
        authenticated = false;
      }
      if (closed) return;
      if (TERMINAL_PRESENCE_CLOSE_CODES.has(event.code)) {
        terminate({ code: event.code, terminal: true });
        return;
      }
      scheduleReconnect(event.code);
    });
  }

  function scheduleReconnect(closeCode) {
    if (closed || reconnectTimer !== null) return;
    if (reconnectAttempts >= maxReconnectAttempts) {
      terminate({ code: closeCode, terminal: false });
      return;
    }
    const delayMs = Math.min(minDelayMs * 2 ** reconnectAttempts, maxDelayMs);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delayMs);
    emit({
      type: "connection.reconnecting",
      attempt: reconnectAttempts,
      delayMs,
      ...(closeCode === undefined ? {} : { code: closeCode }),
    });
  }

  const connection = {
    get connected() {
      return (
        Date.now() < expiresAt && authenticated && socket?.readyState === 1
      );
    },
    sendPresence(status = "online") {
      if (!connection.connected || !["online", "busy"].includes(status))
        return false;
      try {
        socket.send(JSON.stringify({ type: "presence.update", status }));
        return true;
      } catch {
        return false;
      }
    },
    sendMessage(body) {
      if (
        !connection.connected ||
        typeof body !== "string" ||
        body.length === 0 ||
        body.length > 3000
      )
        return false;
      try {
        socket.send(JSON.stringify({ type: "message.send", body }));
        return true;
      } catch {
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      authenticated = false;
      clearTimers();
      const activeSocket = socket;
      socket = null;
      activeSocket?.close(1000, "client closed connection");
    },
  };

  expiryTimer = setTimeout(
    () => {
      terminate({ code: 4401, terminal: true });
    },
    Math.max(0, expiresAt - Date.now()),
  );
  openSocket();
  return Object.freeze(connection);
}

export function createServiceClient({
  baseUrl,
  audience = globalThis.location?.origin,
  fetchImpl = globalThis.fetch,
  webSocketFactory = (url) => new WebSocket(url),
} = {}) {
  const base = serviceUrl(baseUrl);
  if (typeof audience !== "string")
    throw new TypeError("An exact application origin is required");
  let expectedAudience;
  try {
    expectedAudience = new URL(audience).origin;
  } catch {
    throw new TypeError("An exact application origin is required");
  }
  if (expectedAudience !== audience)
    throw new TypeError("Application audience must be an exact origin");
  if (typeof fetchImpl !== "function")
    throw new TypeError("A fetch implementation is required");

  async function request(path, { method = "GET", token, body } = {}) {
    const headers = new Headers();
    if (body !== undefined) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetchImpl(
      new URL(path.replace(/^\//u, ""), `${base.href}/`),
      {
        method,
        headers,
        credentials: "omit",
        cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new AIAuthServiceError(
        typeof payload.error === "string"
          ? payload.error
          : "AI Auth service request failed",
        response.status,
        payload,
      );
    }
    return payload;
  }

  return Object.freeze({
    async authenticate(wallet, capabilities, approvedCapabilities) {
      if (!Array.isArray(approvedCapabilities))
        throw new TypeError(
          "Explicit wallet-approved capabilities are required",
        );
      const { request: challenge } = await request("v1/auth/challenge", {
        method: "POST",
        body: { audience, capabilities },
      });
      const consent = await approvePermissionRequest(
        wallet,
        challenge,
        approvedCapabilities,
      );
      return request("v1/auth/session", { method: "POST", body: { consent } });
    },

    createTenant(session, name) {
      return request("v1/tenants", {
        method: "POST",
        token: session?.token,
        body: { name },
      });
    },

    async createInvitation(
      session,
      wallet,
      { tenantId, recipient, capabilities, expiresAt },
    ) {
      const grant = await createCapabilityGrant(wallet, {
        recipient,
        resource: `tenant:${tenantId}`,
        capabilities,
        expiresAt,
      });
      await request(`v1/tenants/${encodeURIComponent(tenantId)}/invitations`, {
        method: "POST",
        token: session?.token,
        body: { grant },
      });
      return grant;
    },

    joinTenant(session, tenantId, grant) {
      return request(`v1/tenants/${encodeURIComponent(tenantId)}/join`, {
        method: "POST",
        token: session?.token,
        body: { grant },
      });
    },

    listMessages(session, tenantId, room) {
      return request(
        `v1/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(room)}/messages`,
        { token: session?.token },
      );
    },

    sendMessage(session, tenantId, room, body) {
      return request(
        `v1/tenants/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(room)}/messages`,
        { method: "POST", token: session?.token, body: { body } },
      );
    },

    connectPresence(session, tenantId, room, onEvent) {
      if (typeof session?.token !== "string" || typeof onEvent !== "function")
        throw new TypeError("A session token and event handler are required");
      const socket = webSocketFactory(presenceSocketUrl(base, tenantId, room));
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({ type: "authenticate", token: session.token }),
        );
      });
      socket.addEventListener("message", (event) => {
        forwardPresenceMessage(event.data, onEvent);
      });
      return socket;
    },

    connectPresenceResilient(
      session,
      tenantId,
      room,
      onEvent,
      {
        minDelayMs = 250,
        maxDelayMs = 30_000,
        maxReconnectAttempts = Number.POSITIVE_INFINITY,
      } = {},
    ) {
      if (typeof session?.token !== "string" || !session.token)
        throw new TypeError("A session token is required");
      const expiresAt = session.session?.expiresAt;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
        throw new TypeError("An unexpired session expiry is required");
      if (typeof onEvent !== "function")
        throw new TypeError("An event handler is required");
      if (
        !Number.isFinite(minDelayMs) ||
        minDelayMs < 0 ||
        !Number.isFinite(maxDelayMs) ||
        maxDelayMs < minDelayMs ||
        !(
          maxReconnectAttempts === Number.POSITIVE_INFINITY ||
          (Number.isInteger(maxReconnectAttempts) && maxReconnectAttempts >= 0)
        )
      )
        throw new TypeError("Presence reconnect options are invalid");
      return createReconnectingPresenceConnection({
        session,
        url: presenceSocketUrl(base, tenantId, room),
        onEvent,
        webSocketFactory,
        expiresAt,
        minDelayMs,
        maxDelayMs,
        maxReconnectAttempts,
      });
    },
  });
}
