import { TOOL_ERROR_CODES } from "@enzovezzaro/ai-auth-wallet";
import { TOOL_NAME_PATTERN } from "@enzovezzaro/ai-auth-wallet/webmcp";

// Agent-local tool provider: an agent runtime publishes tools it executes
// itself, so other participants can call them with no browser present.
// The wire format is the one the site page uses (signed `agent/action` events
// with tool-catalog, tool-request and tool-response kinds). The provider
// chooses its own nonce and reads the runtime's live room session, so it needs
// no visitor, wallet popup, or site consent flow.

// One name rule for the whole chain: a name the site accepts must also be
// accepted by an agent provider.
const TOOL_NAME = TOOL_NAME_PATTERN;
const MAX_TOOLS = 32;
const MAX_INPUT_BYTES = 8_192;
const MAX_RESULT_BYTES = 8_192;
const MAX_DESCRIPTION = 240;
const MAX_SCHEMA_BYTES = 2_048;
const CONCURRENCY = 8;
const EXECUTION_TIMEOUT_MS = 15_000;
const REFRESH_MS = 45_000;
const REQUEST_MEMORY_MS = 130_000;

function bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > MAX_TOOLS)
    throw new TypeError(`provideTools needs 1 to ${MAX_TOOLS} tools`);
  const byName = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name))
      throw new TypeError("Each tool needs a valid name such as notes.search");
    if (byName.has(tool.name))
      throw new TypeError(`Duplicate tool name: ${tool.name}`);
    if (typeof tool.handler !== "function")
      throw new TypeError(`Tool ${tool.name} needs a handler function`);
    const description = tool.description ?? "";
    if (typeof description !== "string" || description.length > MAX_DESCRIPTION)
      throw new TypeError(`Tool ${tool.name} description is too long`);
    const inputSchema = tool.inputSchema ?? {};
    if (
      inputSchema === null ||
      typeof inputSchema !== "object" ||
      Array.isArray(inputSchema) ||
      bytes(inputSchema) > MAX_SCHEMA_BYTES
    )
      throw new TypeError(
        `Tool ${tool.name} input schema is invalid or too large`,
      );
    byName.set(tool.name, {
      handler: tool.handler,
      inputSchema,
      descriptor: Object.freeze({
        name: tool.name,
        description,
        inputSchema: structuredClone(inputSchema),
      }),
    });
  }
  return byName;
}

function validateInput(input, schema) {
  if (!schema || schema.type !== "object" || input === undefined) return;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Tool input must be an object");
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? [])
    if (!(key in input)) throw new TypeError(`Missing required input: ${key}`);
  const isType = (value, expected) => {
    if (expected === "array") return Array.isArray(value);
    if (expected === "integer") return Number.isInteger(value);
    if (expected === "null") return value === null;
    return typeof value === expected;
  };
  for (const [key, value] of Object.entries(input)) {
    const spec = properties[key];
    if (!spec) {
      if (schema.additionalProperties === false)
        throw new TypeError(`Unexpected input: ${key}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(value))
      throw new TypeError(`Invalid value for ${key}`);
    if (spec.type && !isType(value, spec.type))
      throw new TypeError(`Invalid type for ${key}`);
  }
}

function randomToken(bytesLength = 24) {
  const buffer = new Uint8Array(bytesLength);
  crypto.getRandomValues(buffer);
  return Buffer.from(buffer).toString("base64url");
}

/**
 * Publishes `tools` from this runtime's wallet and executes calls locally.
 * `authorize(requesterId, toolName, input)` is required: a provider never runs
 * a tool for a peer its owner has not explicitly allowed.
 */
export function createToolProvider({
  room,
  tools,
  authorize,
  refreshMs = REFRESH_MS,
  timeoutMs = EXECUTION_TIMEOUT_MS,
}) {
  if (typeof authorize !== "function")
    throw new TypeError(
      "provideTools needs an authorize(requesterId, name, input) function",
    );
  if (
    !room ||
    typeof room.send !== "function" ||
    typeof room.subscribe !== "function"
  )
    throw new TypeError("provideTools needs a joined agent room");
  const byName = validateTools(tools);
  // The wallet and session exist once the runtime has joined. A provider may be
  // registered before that; it publishes as soon as the room is live.
  const ownId = () => room.wallet?.id;
  const nonce = randomToken(24);
  const seen = new Map();
  const runningRequests = new Map();
  let running = 0;
  let closed = false;

  const catalogTools = () =>
    [...byName.values()].map((entry) => entry.descriptor);

  const publish = (list) => {
    const walletId = ownId();
    if (
      closed ||
      typeof walletId !== "string" ||
      typeof room.session !== "string"
    )
      return Promise.resolve();
    return room
      .send("agent/action", {
        kind: "tool-catalog",
        targetWallet: walletId,
        targetSession: room.session,
        targetNonce: nonce,
        tools: list,
      })
      .catch(() => {});
  };
  const announce = () => publish(catalogTools());

  const respond = (requester, body) => {
    const walletId = ownId();
    if (typeof walletId !== "string" || typeof room.session !== "string")
      return Promise.resolve();
    return room
      .send(
        "agent/action",
        {
          kind: "tool-response",
          toWallet: requester.wallet,
          toSession: requester.session,
          targetWallet: walletId,
          targetSession: room.session,
          targetNonce: nonce,
          ...body,
        },
        { to: requester.wallet },
      )
      .catch(() => {});
  };

  const cancelled = () => ({
    error: "This tool call was cancelled",
    code: TOOL_ERROR_CODES.CANCELLED,
  });

  async function execute(requester, request, controller) {
    const entry = byName.get(request.name);
    // A cancel while the human decision is pending must win the race: the
    // handler may never run for a request that was already called off.
    let allowed = false;
    try {
      const decision = Promise.resolve().then(() =>
        authorize(requester.wallet, request.name, request.input),
      );
      const aborted = new Promise((resolve) => {
        if (controller.signal.aborted) resolve(false);
        else
          controller.signal.addEventListener("abort", () => resolve(false), {
            once: true,
          });
      });
      allowed = await Promise.race([
        decision.then((value) => value === true),
        aborted,
      ]);
    } catch {
      allowed = false;
    }
    if (controller.signal.aborted) return cancelled();
    if (!allowed)
      return {
        error: "This agent did not allow that tool for you",
        code: TOOL_ERROR_CODES.DENIED,
      };
    try {
      validateInput(request.input, byName.get(request.name)?.inputSchema);
    } catch (error) {
      return { error: error.message, code: TOOL_ERROR_CODES.TOOL_UNAVAILABLE };
    }
    if (controller.signal.aborted) return cancelled();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (controller.signal.aborted) return cancelled();
      const value = await Promise.race([
        Promise.resolve(
          entry.handler(request.input, {
            signal: controller.signal,
            requester: requester.wallet,
          }),
        ),
        new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("timeout")),
            { once: true },
          ),
        ),
      ]);
      if (bytes(value ?? null) > MAX_RESULT_BYTES)
        return {
          error: "The tool result is too large",
          code: TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
        };
      return { result: value ?? null };
    } catch {
      if (controller.signal.aborted) return cancelled();
      return {
        error: "The tool could not complete",
        code: TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function validCancel(payload) {
    return (
      payload?.kind === "tool-cancel" &&
      payload.targetWallet === ownId() &&
      payload.targetSession === room.session &&
      payload.targetNonce === nonce &&
      typeof payload.requestId === "string" &&
      /^[A-Za-z0-9_-]{8,80}$/u.test(payload.requestId)
    );
  }

  function validRequest(payload) {
    return (
      payload?.kind === "tool-request" &&
      payload.targetWallet === ownId() &&
      payload.targetSession === room.session &&
      payload.targetNonce === nonce &&
      typeof payload.requestId === "string" &&
      /^[A-Za-z0-9_-]{8,80}$/u.test(payload.requestId) &&
      typeof payload.name === "string" &&
      byName.has(payload.name) &&
      payload.input !== null &&
      typeof payload.input === "object" &&
      !Array.isArray(payload.input) &&
      bytes(payload.input) <= MAX_INPUT_BYTES
    );
  }

  const unsubscribe = room.subscribe(({ direction, envelope }) => {
    if (closed || direction !== "in" || !envelope?.body) return;
    const { type, issuer, payload } = envelope.body;
    if (type === "peer/hello" && issuer !== ownId()) {
      announce();
      return;
    }
    if (type === "agent/action" && validCancel(payload) && issuer !== ownId()) {
      const running = runningRequests.get(payload.requestId);
      // A signed cancel only stops the request from that same issuer; another
      // peer guessing a requestId must not be able to kill someone else's call.
      if (running?.issuer === issuer) running.controller.abort();
      return;
    }
    if (type !== "agent/action" || !validRequest(payload) || issuer === ownId())
      return;
    const now = Date.now();
    const requester = { wallet: issuer, session: payload.session };
    // requestId is chosen by the caller, so it is unique only per requester.
    const requestKey = `${issuer}:${payload.session}:${payload.requestId}`;
    for (const [id, until] of seen) if (until <= now) seen.delete(id);
    if (seen.has(requestKey)) return;
    if (running >= CONCURRENCY) {
      // A silent drop makes the caller wait for its full timeout with no hint.
      void respond(requester, {
        requestId: payload.requestId,
        error: "This provider is busy; retry shortly",
        code: TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
      });
      return;
    }
    seen.set(requestKey, now + REQUEST_MEMORY_MS);
    running += 1;
    const controller = new AbortController();
    runningRequests.set(payload.requestId, {
      controller,
      issuer: requester.wallet,
    });
    execute(requester, payload, controller)
      .then((outcome) =>
        respond(requester, { requestId: payload.requestId, ...outcome }),
      )
      .finally(() => {
        runningRequests.delete(payload.requestId);
        running -= 1;
      });
  });

  const refresh = setInterval(announce, refreshMs);
  refresh.unref?.();
  announce();

  return Object.freeze({
    get tools() {
      return catalogTools().map((tool) => tool.name);
    },
    // Publishes the catalog again now. The runtime calls this after a reconnect
    // because a catalog is bound to one live room session.
    announce: () => announce(),
    // Withdraws the tools at once (an empty catalog replaces the last one);
    // the catalog would otherwise expire on its own within two minutes.
    close() {
      if (closed) return;
      clearInterval(refresh);
      unsubscribe();
      for (const running of runningRequests.values())
        running.controller.abort();
      runningRequests.clear();
      const withdrawal = publish([]);
      closed = true;
      return withdrawal;
    },
  });
}
