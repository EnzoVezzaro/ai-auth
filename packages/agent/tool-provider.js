// Agent-local tool provider: an agent runtime publishes tools it executes
// itself, so other participants can call them with no browser present.
// The wire format is the one the site page uses (signed `agent/action` events
// with tool-catalog, tool-request and tool-response kinds). The provider
// chooses its own nonce and reads the runtime's live room session, so it needs
// no visitor, wallet popup, or site consent flow.

const TOOL_NAME = /^[a-z][a-z0-9._-]{0,63}$/u;
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
      throw new TypeError(
        "Each tool needs a lowercase name such as notes.search",
      );
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
      descriptor: Object.freeze({
        name: tool.name,
        description,
        inputSchema: structuredClone(inputSchema),
      }),
    });
  }
  return byName;
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
  const walletId = room.wallet?.id;
  if (typeof walletId !== "string")
    throw new TypeError("provideTools needs a wallet");
  const nonce = randomToken(24);
  const seen = new Map();
  let running = 0;
  let closed = false;

  const catalogTools = () =>
    [...byName.values()].map((entry) => entry.descriptor);

  const publish = (list) => {
    if (closed || typeof room.session !== "string") return Promise.resolve();
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

  const respond = (requester, body) =>
    room
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

  async function execute(requester, request) {
    const entry = byName.get(request.name);
    let allowed = false;
    try {
      allowed =
        (await authorize(requester.wallet, request.name, request.input)) ===
        true;
    } catch {
      allowed = false;
    }
    if (!allowed)
      return { error: "This agent did not allow that tool for you" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
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
        return { error: "The tool result is too large" };
      return { result: value ?? null };
    } catch {
      return { error: "The tool could not complete" };
    } finally {
      clearTimeout(timer);
    }
  }

  function validRequest(payload) {
    return (
      payload?.kind === "tool-request" &&
      payload.targetWallet === walletId &&
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
    if (type === "peer/hello" && issuer !== walletId) {
      announce();
      return;
    }
    if (
      type !== "agent/action" ||
      !validRequest(payload) ||
      issuer === walletId
    )
      return;
    const now = Date.now();
    for (const [id, until] of seen) if (until <= now) seen.delete(id);
    if (seen.has(payload.requestId) || running >= CONCURRENCY) return;
    seen.set(payload.requestId, now + REQUEST_MEMORY_MS);
    running += 1;
    const requester = { wallet: issuer, session: payload.session };
    execute(requester, payload)
      .then((outcome) =>
        respond(requester, { requestId: payload.requestId, ...outcome }),
      )
      .finally(() => {
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
    // Withdraws the tools at once (an empty catalog replaces the last one);
    // the catalog would otherwise expire on its own within two minutes.
    close() {
      if (closed) return;
      closed = true;
      clearInterval(refresh);
      unsubscribe();
      publish([]);
    },
  });
}
