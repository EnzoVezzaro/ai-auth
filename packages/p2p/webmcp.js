import { authorizeProtected } from "./membership.js";
import {
  onVerifiedPageConnectionClose,
  readVerifiedPageConnection,
} from "./session.js";

function actionCapability(type) {
  if (type === "tools.invoke") return "tools.invoke";
  throw new TypeError("Page tools require the tools.invoke capability");
}

const MAX_REMOTE_TOOL_COUNT = 32;
const MAX_TOOL_JSON_BYTES = 8_192;
const TOOL_NAME = /^[a-z][a-z0-9._-]{0,63}$/u;
const TOOL_EVENT_KINDS = new Set([
  "tool-catalog",
  "tool-request",
  "tool-cancel",
  "tool-response",
]);

function boundedJson(value, maxBytes = MAX_TOOL_JSON_BYTES) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Tool data must be JSON serializable");
  }
  if (
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).byteLength > maxBytes
  )
    throw new RangeError("Tool data exceeds the shared-room size limit");
  return JSON.parse(serialized);
}

// A tool whose descriptor cannot be bounded is skipped, never fatal.
function safeToolDescriptor(action) {
  try {
    return toolDescriptor(action);
  } catch {
    return null;
  }
}

function toolDescriptor(action) {
  const descriptor = {
    name: action.name,
    description: action.description.trim().slice(0, 240),
    inputSchema: boundedJson(action.inputSchema, 4_096),
  };
  if (action.outputSchema)
    descriptor.outputSchema = boundedJson(action.outputSchema, 4_096);
  return descriptor;
}

function validToolRequest(payload, { walletId, requestNonce, walletSession }) {
  return (
    payload?.kind === "tool-request" &&
    payload.targetWallet === walletId &&
    payload.targetNonce === requestNonce &&
    payload.targetSession === walletSession &&
    typeof payload.requestId === "string" &&
    /^[A-Za-z0-9_-]{8,80}$/u.test(payload.requestId) &&
    typeof payload.name === "string" &&
    /^[a-z][a-z0-9._-]{0,63}$/u.test(payload.name) &&
    payload.input !== null &&
    typeof payload.input === "object" &&
    !Array.isArray(payload.input) &&
    (() => {
      try {
        boundedJson(payload.input);
        return true;
      } catch {
        return false;
      }
    })()
  );
}

function validToolCancel(payload, { walletId, requestNonce, walletSession }) {
  return (
    payload?.kind === "tool-cancel" &&
    payload.targetWallet === walletId &&
    payload.targetNonce === requestNonce &&
    payload.targetSession === walletSession &&
    typeof payload.requestId === "string" &&
    /^[A-Za-z0-9_-]{8,80}$/u.test(payload.requestId)
  );
}

function protectedGate(action, requester, policy) {
  if (!requester) return { allow: true }; // local call, not a remote peer
  if (!policy && action.protected !== true) return { allow: true };
  return authorizeProtected({
    policy,
    walletId: requester.id,
    scope: action.requiredCapability,
  });
}

function validateAction(action) {
  if (
    !action ||
    !/^[a-z][a-z0-9._-]{0,63}$/u.test(action.name ?? "") ||
    typeof action.description !== "string" ||
    !action.description.trim() ||
    typeof action.execute !== "function" ||
    !action.inputSchema ||
    action.inputSchema.type !== "object" ||
    !action.inputSchema.properties ||
    typeof action.requiredCapability !== "string"
  ) {
    throw new TypeError(
      "Page actions need a name, description, object input schema, capability, and execute function",
    );
  }
  actionCapability(action.requiredCapability);
}

export async function registerAIAuthPageActions({
  actions = [],
  connection,
  modelContext = globalThis.document?.modelContext,
  signal,
  authorize,
  publishAction = async () => {},
  policy,
} = {}) {
  if (!Array.isArray(actions))
    throw new TypeError("Page actions must be an array");
  if (typeof authorize !== "function")
    throw new TypeError(
      "A human authorization gate (an async decision function) is required",
    );
  const verifiedConnection = readVerifiedPageConnection(connection);
  if (!verifiedConnection)
    throw new TypeError(
      "A verified, active AI Auth wallet connection is required",
    );
  const approved = new Set(verifiedConnection.capabilities);
  const explicitActions = actions.filter((action) => {
    validateAction(action);
    return approved.has(action.requiredCapability);
  });
  const explicitNames = new Set(explicitActions.map(({ name }) => name));
  let discoveredTools = [];
  if (typeof modelContext?.getTools === "function") {
    try {
      const available = await modelContext.getTools();
      if (Array.isArray(available))
        discoveredTools = available
          .filter(
            (tool) =>
              !explicitNames.has(tool?.name) &&
              typeof modelContext.executeTool === "function" &&
              typeof tool?.name === "string" &&
              TOOL_NAME.test(tool.name) &&
              typeof tool?.description === "string" &&
              tool?.inputSchema?.type === "object" &&
              tool?.inputSchema?.properties &&
              typeof tool.inputSchema.properties === "object",
          )
          .slice(0, MAX_REMOTE_TOOL_COUNT)
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            requiredCapability: "tools.invoke",
            readOnly: tool.annotations?.readOnlyHint === true,
            execute: async (input, context) => {
              const result = await modelContext.executeTool(tool, input, {
                signal: context.signal,
              });
              if (typeof result !== "string") return result;
              try {
                return JSON.parse(result);
              } catch {
                return result;
              }
            },
            discoveredWebMCP: true,
          }));
    } catch {
      discoveredTools = [];
    }
  }
  const allowedActions = [...explicitActions, ...discoveredTools]
    .filter((action) => approved.has(action.requiredCapability))
    .slice(0, MAX_REMOTE_TOOL_COUNT);
  const handlers = new Map(
    allowedActions.map((action) => [action.name, action]),
  );
  // Results created by refusal paths, so callers can tell failure from data.
  const failures = new WeakSet();
  const refuse = (error) => {
    const result = { error };
    failures.add(result);
    return result;
  };
  // The participation policy may arrive as an option or through the connection.
  const activePolicy = () =>
    policy ?? connection?.participation?.policy ?? connection?.policy;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const registrationSignal = controller.signal;
  let expiryTimer;
  // Re-read the connection record when the timer fires so a renewed session
  // keeps its tools and an expired or revoked one loses them.
  const armExpiry = () => {
    const record = readVerifiedPageConnection(connection);
    if (!record) {
      controller.abort();
      return;
    }
    expiryTimer = setTimeout(
      armExpiry,
      Math.max(1, record.expiresAt - Date.now()),
    );
    // The timer only watches for expiry; it must never keep a process alive.
    expiryTimer?.unref?.();
  };
  armExpiry();
  const removeConnectionCloseListener = onVerifiedPageConnectionClose(
    connection,
    () => controller.abort(),
  );
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiryTimer);
    signal?.removeEventListener("abort", abortFromCaller);
    removeConnectionCloseListener();
    controller.abort();
  };

  async function announce(action, state, summary) {
    try {
      await publishAction({
        name: action.name,
        capability: action.requiredCapability,
        state,
        summary,
      });
    } catch {
      // A failed announcement must not leak authorization details.
    }
  }

  async function execute(
    name,
    input,
    { signal: executionSignal, requester, requestId } = {},
  ) {
    const action = handlers.get(name);
    const activeConnection = readVerifiedPageConnection(connection);
    if (
      closed ||
      registrationSignal.aborted ||
      !action ||
      !activeConnection?.capabilities.includes(action.requiredCapability)
    )
      return refuse("This action is not approved for this page");
    // In-flight executions are tied to this controller so a page close,
    // capability expiry, or caller abort also stops the running action.
    const executionController = new AbortController();
    const abortFollowers = [];
    const follow = (source) => {
      if (!source) return;
      const abort = () => executionController.abort(source.reason);
      if (source.aborted) abort();
      else {
        source.addEventListener("abort", abort, { once: true });
        abortFollowers.push([source, abort]);
      }
    };
    follow(executionSignal);
    follow(registrationSignal);
    const executionContext = {
      signal: executionController.signal,
      requester,
      requestId,
      sharedPublicly: Boolean(requester),
    };
    // Protected gate: a remote requester must hold a live membership and
    // execution grant. Any missing policy or input denies (fail closed).
    const gate = protectedGate(action, requester, activePolicy());
    if (!gate.allow) {
      await announce(
        action,
        "needs-human",
        `Blocked ${action.name}: not authorized`,
      );
      return refuse("This requester is not authorized to run this tool");
    }
    // Actions start only after an explicit human decision. The site supplies
    // this gate; without a positive decision nothing is announced or run.
    {
      let approved = false;
      let removeAbortListener = () => {};
      try {
        const approval = Promise.resolve().then(() =>
          authorize(action, input, executionContext),
        );
        const aborted = new Promise((_, reject) => {
          const onAbort = () =>
            reject(
              new DOMException("The site action was stopped", "AbortError"),
            );
          if (executionController.signal.aborted) onAbort();
          else {
            executionController.signal.addEventListener("abort", onAbort, {
              once: true,
            });
            removeAbortListener = () =>
              executionController.signal.removeEventListener("abort", onAbort);
          }
        });
        approved = Boolean(await Promise.race([approval, aborted]));
      } catch {
        approved = false;
      } finally {
        removeAbortListener();
      }
      if (executionController.signal.aborted) {
        await announce(action, "cancelled", `Stopped ${action.name}`);
        return refuse("This action was stopped before it began");
      }
      if (!approved) {
        try {
          await publishAction({
            name: action.name,
            capability: action.requiredCapability,
            state: "needs-human",
            summary: `Human approval required for ${action.name}`,
          });
        } catch {
          // A failed announcement must not leak authorization details.
        }
        return refuse("This action needs explicit human approval");
      }
    }
    if (executionController.signal.aborted || registrationSignal.aborted)
      return refuse("This action was stopped before it began");
    const event = {
      name: action.name,
      capability: action.requiredCapability,
      state: "started",
      summary: `Started ${action.name}`,
    };
    try {
      await publishAction(event);
      const stillAuthorized = readVerifiedPageConnection(connection);
      if (
        closed ||
        registrationSignal.aborted ||
        executionController.signal.aborted ||
        !stillAuthorized?.capabilities.includes(action.requiredCapability)
      )
        return refuse("This action is not approved for this page");
      const result = await action.execute(input ?? {}, executionContext);
      if (executionController.signal.aborted) {
        await publishAction({
          ...event,
          state: "cancelled",
          summary: `Stopped ${action.name}`,
        });
        return refuse("The site action was stopped");
      }
      await publishAction({
        ...event,
        state: "completed",
        summary: `Completed ${action.name}`,
      });
      return result;
    } catch {
      try {
        await publishAction({
          ...event,
          state: executionController.signal.aborted ? "cancelled" : "failed",
          summary: executionController.signal.aborted
            ? `Stopped ${action.name}`
            : `Could not complete ${action.name}`,
        });
      } catch {
        // Page event transport errors may contain secrets; keep them out of tool results.
      }
      return refuse(
        executionController.signal.aborted
          ? "The site action was stopped"
          : "This page action failed. Check the site for details.",
      );
    } finally {
      for (const [source, abort] of abortFollowers)
        source.removeEventListener("abort", abort);
    }
  }

  const webMcpAvailable = Boolean(
    modelContext?.registerTool || discoveredTools.length,
  );
  if (modelContext?.registerTool) {
    try {
      await Promise.all(
        explicitActions.map((action) =>
          modelContext.registerTool(
            {
              name: action.name,
              description: action.description,
              inputSchema: action.inputSchema,
              annotations: {
                readOnlyHint: action.readOnly === true,
              },
              execute: (input, context = {}) =>
                execute(action.name, input, context),
            },
            { signal: registrationSignal },
          ),
        ),
      );
    } catch (error) {
      close();
      throw error;
    }
  }

  return Object.freeze({
    webMcpAvailable,
    tools: Object.freeze(allowedActions.map(({ name }) => name)),
    actionsByName: handlers,
    execute,
    isFailure: (result) =>
      result !== null && typeof result === "object" && failures.has(result),
    close,
  });
}

/**
 * Mounts the AI Auth in-page agent bridge for a connected website tab. The
 * agent stays alive inside the page, discovers the page's WebMCP tool surface
 * (with the plain JavaScript execution fallback when WebMCP is unsupported),
 * and can only run actions that carry both a wallet-granted capability and an
 * explicit human authorization decision. Every run is announced to the shared
 * session and can be stopped through the returned stop()/close() or an abort
 * signal.
 */
export async function mountAIAuthInPageAgent({
  actions,
  connection,
  modelContext = globalThis.document?.modelContext,
  signal,
  authorize,
  publishAction,
  policy,
} = {}) {
  if (typeof authorize !== "function")
    throw new TypeError(
      "An in-page agent needs an explicit human authorization gate",
    );
  const api = await registerAIAuthPageActions({
    actions,
    connection,
    modelContext,
    signal,
    authorize,
    policy,
    publishAction:
      publishAction ??
      (async (event) => {
        // Default announcements travel the signed path: the wallet signs the
        // action event and shares it with every peer in the room.
        connection.publishAction({
          name: event.name,
          state: event.state,
          summary: event.summary,
        });
      }),
  });
  try {
    return wireAgentBridge(api, connection);
  } catch (error) {
    // Never leak the registration (and its expiry timer) when wiring fails.
    api.close();
    throw error;
  }
}

function wireAgentBridge(api, connection) {
  // Only tools with a bounded descriptor are advertised or callable by peers.
  const advertised = new Map();
  for (const name of api.tools) {
    const descriptor = safeToolDescriptor(allowedActionByName(api, name));
    if (descriptor) advertised.set(name, descriptor);
  }
  const processedRequestIds = new Map();
  const runningRequests = new Map();
  const stopEvents = connection.onEvent((envelope) => {
    const payload = envelope?.body?.payload;
    if (
      envelope?.body?.type === "agent/action" &&
      validToolCancel(payload, {
        walletId: connection.identity.id,
        requestNonce: connection.request.nonce,
        walletSession: connection.walletSession,
      })
    ) {
      const running = runningRequests.get(payload.requestId);
      if (
        running?.issuer === envelope.body.issuer &&
        running.session === payload.session
      )
        running.controller.abort();
      return;
    }
    if (
      envelope?.body?.type !== "agent/action" ||
      !validToolRequest(payload, {
        walletId: connection.identity.id,
        requestNonce: connection.request.nonce,
        walletSession: connection.walletSession,
      })
    )
      return;
    if (!advertised.has(payload.name)) return;
    for (const [requestId, expiresAt] of processedRequestIds)
      if (expiresAt <= Date.now()) processedRequestIds.delete(requestId);
    if (processedRequestIds.has(payload.requestId)) return;
    if (processedRequestIds.size >= 256) return;
    processedRequestIds.set(payload.requestId, payload.expiresAt);
    const controller = new AbortController();
    runningRequests.set(payload.requestId, {
      controller,
      issuer: envelope.body.issuer,
      session: payload.session,
    });
    void api
      .execute(payload.name, payload.input, {
        signal: controller.signal,
        requester: Object.freeze({ id: envelope.body.issuer }),
        requestId: payload.requestId,
      })
      .then((result) =>
        connection.publishAgentEvent({
          kind: "tool-response",
          requestId: payload.requestId,
          toWallet: envelope.body.issuer,
          toSession: envelope.body.payload.session,
          // Denials and failures are errors, never successful results.
          ...(api.isFailure(result)
            ? { error: String(result.error).slice(0, 240) }
            : { result: boundedJson(result) }),
        }),
      )
      .catch(() =>
        connection.publishAgentEvent({
          kind: "tool-response",
          requestId: payload.requestId,
          toWallet: envelope.body.issuer,
          toSession: envelope.body.payload.session,
          error: "The site tool could not complete",
        }),
      )
      .finally(() => runningRequests.delete(payload.requestId));
  });
  const publishCatalog = () => {
    if (
      !connection.walletSession ||
      !connection.capabilities.includes("tools.invoke")
    )
      return;
    connection.publishAgentEvent({
      kind: "tool-catalog",
      tools: [...advertised.values()],
    });
  };
  const stopRoomReady = connection.onRoomReady(publishCatalog);
  const stopPeerDiscovery = connection.onEvent((envelope) => {
    if (envelope?.body?.type === "peer/hello") publishCatalog();
  });
  return Object.freeze({
    webMcpAvailable: api.webMcpAvailable,
    tools: api.tools,
    execute: api.execute,
    stop: () => {
      stopEvents();
      stopRoomReady();
      stopPeerDiscovery();
      api.close();
    },
    close: () => {
      stopEvents();
      stopRoomReady();
      stopPeerDiscovery();
      api.close();
    },
  });
}

function allowedActionByName(api, name) {
  return api.actionsByName?.get(name);
}

// Keep only well-formed, bounded tools; one bad tool never drops the rest.
function boundedCatalogTools(tools) {
  const kept = [];
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || !TOOL_NAME.test(tool.name)) continue;
    try {
      kept.push(boundedJson(tool, 4_096));
    } catch {
      // Oversized or non-serializable tool: skip it.
    }
  }
  return kept;
}

/**
 * Creates the agent-side half of the signed shared-room WebMCP protocol.
 * Catalogs, requests, and results are broadcast to the public room; do not
 * send private page data through this API.
 */
export function createAIAuthAgentClient(room, { timeoutMs = 30_000 } = {}) {
  if (
    !room ||
    typeof room.send !== "function" ||
    typeof room.subscribe !== "function" ||
    typeof room.wallet?.id !== "string" ||
    typeof room.session !== "string"
  )
    throw new TypeError("An authenticated AI Auth P2P room is required");
  const catalogs = new Map();
  const pending = new Map();
  const listeners = new Set();
  let closed = false;
  const unsubscribe = room.subscribe(({ direction, envelope }) => {
    if (closed || direction !== "in" || envelope?.body?.type !== "agent/action")
      return;
    const payload = envelope.body.payload;
    if (payload?.kind === "tool-catalog") {
      if (
        payload.targetWallet !== envelope.body.issuer ||
        payload.targetSession !== payload.session ||
        typeof payload.targetNonce !== "string" ||
        payload.targetNonce.length < 20 ||
        !Number.isFinite(payload.expiresAt) ||
        payload.expiresAt <= Date.now() ||
        !Array.isArray(payload.tools) ||
        payload.tools.length > MAX_REMOTE_TOOL_COUNT
      )
        return;
      const key = [
        envelope.body.issuer,
        payload.session,
        payload.targetNonce,
      ].join(":");
      for (const [catalogKey, existing] of catalogs)
        if (existing.expiresAt <= Date.now()) catalogs.delete(catalogKey);
      if (catalogs.size >= 128 && !catalogs.has(key))
        catalogs.delete(catalogs.keys().next().value);
      const tools = boundedCatalogTools(payload.tools);
      // Every tool was invalid or oversized: there is nothing safe to keep.
      if (payload.tools.length > 0 && tools.length === 0) return;
      const catalog = Object.freeze({
        wallet: envelope.body.issuer,
        session: payload.session,
        requestNonce: payload.targetNonce,
        expiresAt: payload.expiresAt,
        tools: Object.freeze(tools),
      });
      catalogs.set(key, catalog);
      for (const listener of listeners) {
        try {
          listener(catalog);
        } catch {}
      }
      return;
    }
    if (
      payload?.kind !== "tool-response" ||
      payload.toWallet !== room.wallet.id ||
      payload.toSession !== room.session
    )
      return;
    const request = pending.get(payload.requestId);
    if (!request) return;
    if (
      envelope.body.issuer !== request.catalog.wallet ||
      payload.targetWallet !== request.catalog.wallet ||
      payload.targetSession !== request.catalog.session ||
      payload.targetNonce !== request.catalog.requestNonce
    )
      return;
    pending.delete(payload.requestId);
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.abortHandler);
    if (typeof payload.error === "string")
      request.reject(new Error(String(payload.error).slice(0, 240)));
    else {
      try {
        request.resolve(boundedJson(payload.result));
      } catch {
        request.reject(
          new Error("The site tool returned an invalid or oversized result"),
        );
      }
    }
  });

  return Object.freeze({
    get catalogs() {
      return Object.freeze([...catalogs.values()]);
    },
    onCatalog(listener) {
      if (typeof listener !== "function")
        throw new TypeError("A catalog listener is required");
      listeners.add(listener);
      for (const catalog of catalogs.values()) listener(catalog);
      return () => listeners.delete(listener);
    },
    publishCursor({ x, y, visible = true, scroll } = {}) {
      if (closed) throw new Error("The AI Auth agent client is closed");
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        x > 1 ||
        y < 0 ||
        y > 1 ||
        typeof visible !== "boolean" ||
        (scroll !== undefined &&
          (!Number.isFinite(scroll) || scroll < 0 || scroll > 1))
      )
        throw new TypeError(
          "Agent cursor coordinates must be normalized to the page",
        );
      return room.send("presence/cursor", {
        x,
        y,
        visible,
        label: "Agent " + room.wallet.id.slice(6, 26),
        ...(scroll === undefined ? {} : { scroll }),
      });
    },
    publishAction({ name, state, summary } = {}) {
      if (closed) throw new Error("The AI Auth agent client is closed");
      if (
        typeof name !== "string" ||
        !/^[a-z][a-z0-9._-]{0,63}$/u.test(name) ||
        ![
          "started",
          "progress",
          "completed",
          "failed",
          "cancelled",
          "needs-human",
        ].includes(state) ||
        typeof summary !== "string" ||
        summary.length > 240
      )
        throw new TypeError(
          "Agent activity needs a valid name, state, and short summary",
        );
      return room.send("agent/action", { name, state, summary });
    },
    async callTool(catalog, name, input = {}, { signal } = {}) {
      if (closed) throw new Error("The AI Auth agent client is closed");
      if (
        !catalogs.has(
          [catalog?.wallet, catalog?.session, catalog?.requestNonce].join(":"),
        )
      )
        throw new TypeError("The target site tool catalog is not active");
      if (!catalog.tools.some((tool) => tool.name === name))
        throw new TypeError("The tool is not advertised by this site");
      if (catalog.expiresAt <= Date.now())
        throw new TypeError("The target site tool catalog has expired");
      if (signal?.aborted)
        throw new DOMException("The tool request was cancelled", "AbortError");
      const safeInput = boundedJson(input);
      const requestId = crypto.randomUUID().replaceAll("-", "");
      const result = new Promise((resolve, reject) => {
        const request = {
          resolve,
          reject,
          catalog,
          signal,
          sent: false,
          cancelled: false,
          timer: null,
          abortHandler: null,
          cancelRemote: null,
        };
        const cleanup = () => {
          clearTimeout(request.timer);
          signal?.removeEventListener("abort", request.abortHandler);
          pending.delete(requestId);
        };
        request.cancelRemote = async () => {
          request.cancelled = true;
          if (!request.sent || request.cancelSent) return;
          request.cancelSent = true;
          try {
            await room.send(
              "agent/action",
              {
                kind: "tool-cancel",
                requestId,
                targetWallet: catalog.wallet,
                targetSession: catalog.session,
                targetNonce: catalog.requestNonce,
              },
              { to: catalog.wallet },
            );
          } catch {
            // The cancellation has already rejected the local call. If the
            // peer is unreachable, its page connection expiry still stops it.
          }
        };
        request.timer = setTimeout(() => {
          cleanup();
          void request.cancelRemote();
          reject(new Error("The site tool request timed out"));
        }, timeoutMs);
        request.abortHandler = () => {
          if (!pending.has(requestId)) return;
          request.cancelled = true;
          cleanup();
          void request.cancelRemote();
          reject(
            new DOMException("The tool request was cancelled", "AbortError"),
          );
        };
        pending.set(requestId, request);
        signal?.addEventListener("abort", request.abortHandler, { once: true });
        void room
          .send(
            "agent/action",
            {
              kind: "tool-request",
              requestId,
              name,
              input: safeInput,
              targetWallet: catalog.wallet,
              targetSession: catalog.session,
              targetNonce: catalog.requestNonce,
            },
            { to: catalog.wallet },
          )
          .then(() => {
            request.sent = true;
            if (request.cancelled) void request.cancelRemote();
          })
          .catch((error) => {
            if (pending.has(requestId)) {
              cleanup();
              reject(error);
            }
          });
      });
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      catalogs.clear();
      listeners.clear();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.signal?.removeEventListener("abort", request.abortHandler);
        void request.cancelRemote();
        request.reject(new Error("The AI Auth agent client is closed"));
      }
      pending.clear();
    },
  });
}
