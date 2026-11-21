import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
  createAIAuthAgentClient,
  parseCursorPayload,
  MAX_MESSAGE_CHARS,
  RECEIPT_TYPE,
  TOOL_ERROR_CODES,
  isAddressedTo,
} from "@enzovezzaro/ai-auth-wallet";
import { TOOL_NAME_PATTERN } from "@enzovezzaro/ai-auth-wallet/webmcp";

const MAX_EVENTS = 200;
const MAX_PAGE = 50;
const MAX_PAYLOAD_CHARS = 1_500;
const SILENT_TYPES = new Set(["peer/heartbeat"]);
const WALLET_ID = /^agent:[A-Za-z0-9_-]{20,100}$/u;
// Mirrors ROOM_PATTERN in packages/agent/runtime.js so a bad room name is
// rejected by the tool schema before a join attempt is made.
const ROOM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u;

// Code Mode per-run accounting. A single script cannot spam unbounded host
// calls, fan out more than a handful of async calls at once, or flood the log.
const CODE_CALL_CAP = 64;
const CODE_OUTSTANDING_CAP = 8;
const CODE_LOG_CAP = 50;
const CODE_LOG_CHARS = 240;
const CODE_OUTCOME_CAP = 50;
const CODE_TIMEOUT_MS = 2_000;

// Code Mode's guest bridge is built from this source *inside* the vm context.
// It runs in the guest realm, so every function, Promise, Error and JSON it
// creates is guest-owned. The host callbacks are captured only in closures the
// guest cannot inspect. Nothing crosses the boundary except JSON strings.
const CODE_FACTORY = `(function makeAiAuth(
  hostLog, hostStatus, hostListTools, hostEvents, hostSend, hostMove, hostInvoke
) {
  "use strict";
  const parse = (json) => JSON.parse(json);
  const failure = (info) => {
    const error = new Error(info && info.message ? info.message : "aiAuth call failed");
    if (info && info.code) error.code = info.code;
    return error;
  };
  // The host reports synchronously into these guest callbacks before returning.
  const syncCall = (invoke) => (...args) => {
    let value, info, done = false;
    invoke(JSON.stringify(args),
      (json) => { value = parse(json); done = true; },
      (json) => { info = parse(json); });
    if (done) return value;
    throw failure(info);
  };
  // The guest builds its own Promise; the host only hands back JSON strings.
  const asyncCall = (invoke) => async (...args) =>
    await new Promise((resolve, reject) => {
      invoke(JSON.stringify(args),
        (json) => resolve(parse(json)),
        (json) => reject(failure(parse(json))));
    });
  const log = (...parts) => {
    const text = parts.map((part) => {
      if (typeof part === "string") return part;
      try { return JSON.stringify(part ?? null); } catch { return String(part); }
    }).join(" ");
    hostLog(text);
  };
  return {
    console: { log },
    aiAuth: {
      status: syncCall(hostStatus),
      listTools: syncCall(hostListTools),
      events: syncCall(hostEvents),
      send: asyncCall(hostSend),
      move: syncCall(hostMove),
      invoke: asyncCall(hostInvoke),
    },
  };
})`;

function errorInfo(error) {
  return {
    message: String(error?.message ?? "aiAuth call failed").slice(0, 240),
    ...(error?.code ? { code: error.code } : {}),
  };
}

// Shared scratch space for the worker's synchronous host calls. JSON strings
// never contain raw NUL bytes (JSON.stringify escapes them), so NUL terminates
// a reply. The header holds [phase, sequence]; phase 2 means "reply ready".
const SHARED_HEADER_BYTES = 8;
const SHARED_BYTES = SHARED_HEADER_BYTES + 262_144;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeShared(data, text) {
  const bytes = textEncoder.encode(text);
  // Never silently truncate: a reply that cannot fit is reported to the caller
  // as an explicit error instead of becoming corrupt JSON in the guest.
  if (bytes.length >= data.length) return false;
  data.fill(0);
  data.set(bytes);
  return true;
}

function readShared(data) {
  const end = data.indexOf(0);
  if (end === -1)
    return {
      ok: false,
      error: "aiAuth shared reply too large or missing terminator",
    };
  let text;
  try {
    text = textDecoder.decode(data.subarray(0, end));
  } catch {
    return { ok: false, error: "aiAuth shared reply could not be decoded" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "aiAuth shared reply contains corrupt JSON" };
  }
}

function clip(value) {
  const text = JSON.stringify(value ?? null);
  return text.length <= MAX_PAYLOAD_CHARS
    ? (value ?? null)
    : { truncated: true, preview: text.slice(0, MAX_PAYLOAD_CHARS) };
}

// `rejected` is reserved for a provider refusing the call. Cancellations and
// timeouts are transport outcomes, not denials, and must not invite a retry.
function classifyToolCallError(error) {
  const message = String(error?.message ?? "");
  // DOMException carries a numeric `code` (20 for AbortError); only our own
  // string codes are meaningful on the wire.
  const supplied =
    typeof error?.code === "string" &&
    Object.hasOwn(TOOL_ERROR_CODES, error.code)
      ? error.code
      : null;
  const code =
    supplied ??
    (error?.name === "AbortError" || /cancel/iu.test(message)
      ? TOOL_ERROR_CODES.CANCELLED
      : /tim(e)?d?\s*out|timeout/iu.test(message)
        ? TOOL_ERROR_CODES.TIMEOUT
        : TOOL_ERROR_CODES.DENIED);
  return { code, rejected: code === TOOL_ERROR_CODES.DENIED };
}

/**
 * Glue between the headless agent runtime and the MCP tools. Everything read
 * from peers is untrusted data: it is bounded, labelled, and never executed.
 */
export function createAgentBridge({
  runtime,
  maxEvents = MAX_EVENTS,
  clientFactory = (room) => createAIAuthAgentClient(room),
  providedTools = [],
}) {
  const ring = [];
  const peerPages = new Map();
  let seq = 0;
  let client = null;
  // leave() closes every provider in the runtime; the startup snapshot must
  // not keep advertising tools that are no longer published.
  let provided = [...providedTools];
  const notJoinedReason =
    "Join a room with ai_auth_join before calling this tool.";
  const notJoined = () => ({
    ok: false,
    code: TOOL_ERROR_CODES.NOT_JOINED,
    rejected: false,
    reason: notJoinedReason,
  });
  // Before join the real client constructor rejects with an internal TypeError.
  // Translate that into an actionable, machine-readable "join first" error.
  function getClient() {
    if (client) return client;
    try {
      client = clientFactory(runtime.agentRoom);
    } catch (error) {
      if (!runtime.agentRoom?.wallet?.id || !runtime.agentRoom?.session)
        throw Object.assign(new Error(notJoinedReason), {
          code: TOOL_ERROR_CODES.NOT_JOINED,
        });
      throw error;
    }
    return client;
  }
  const clientOrNull = () => {
    try {
      return getClient();
    } catch (error) {
      if (error?.code === TOOL_ERROR_CODES.NOT_JOINED) return null;
      throw error;
    }
  };

  runtime.onEvent(({ direction, envelope }) => {
    if (
      direction !== "in" ||
      !envelope?.body ||
      SILENT_TYPES.has(envelope.body.type)
    )
      return;
    seq += 1;
    const { type, issuer, payload } = envelope.body;
    // A message signed for another wallet must never appear in this agent's
    // event ring, even though the open room broadcasts it to every peer.
    if (
      (type?.startsWith("collab/") || type === "message/text") &&
      !isAddressedTo(payload, runtime.identity?.id)
    )
      return;
    if (type === "presence/cursor") {
      const parsed = parseCursorPayload(payload);
      if (parsed.ok) {
        if (parsed.cursor.pageKey === null) peerPages.delete(issuer);
        else peerPages.set(issuer, parsed.cursor.pageKey);
      }
    } else if (type === "peer/goodbye") peerPages.delete(issuer);
    const { kind, text, messageId, target } = payload ?? {};
    const receipt = type === RECEIPT_TYPE;
    ring.push({
      seq,
      type,
      from: issuer,
      at: Date.now(),
      ...(kind ? { kind } : {}),
      // Chat and receipts carry a message id so an agent can match its own
      // outgoing messages to the signed receipts that acknowledge them.
      ...(messageId ? { messageId } : {}),
      ...(target ? { target } : {}),
      ...(receipt ? { receiver: payload.receiver } : {}),
      payload:
        kind === "tool-catalog"
          ? { kind }
          : clip(text === undefined ? payload : { text }),
    });
    if (ring.length > maxEvents) ring.shift();
  });

  const catalogs = () => clientOrNull()?.catalogs ?? [];

  const api = {
    status() {
      const state = runtime.connectionState;
      return {
        identity: runtime.identity?.id ?? null,
        origin: runtime.origin,
        room: runtime.room,
        capabilities: [...runtime.capabilities],
        connection: state.status,
        // Strict liveness. MCP endpoint reachability, a saved room, a grant or
        // a discovered catalog can never make this true.
        connected: state.connected === true,
        connectionGeneration: state.generation,
        authorization: state.authorization,
        joinedRoom: state.connected ? runtime.room : null,
        directPeerCount: state.directPeerCount,
        peers: runtime.peers().map(({ id, name, stale }) => ({
          id,
          name,
          stale,
          pageKey: peerPages.get(id) ?? null,
        })),
        provides: [...provided],
        diagnostics: state.diagnostics ?? {},
        note: "Presence lasts only while this MCP process runs.",
      };
    },
    async join({ room } = {}) {
      // The human approved one room for this origin. Switching to an arbitrary
      // room of the same origin needs a new approval, not just an MCP call.
      const approved = runtime.approvedRoom;
      const requested = room ?? runtime.room ?? approved ?? "default";
      if (typeof approved === "string" && requested !== approved)
        return {
          ok: false,
          code: TOOL_ERROR_CODES.DENIED,
          reason: `Only the approved room "${approved}" can be joined.`,
        };
      const state = await runtime.join(room);
      return {
        connection: state.status,
        room: runtime.room,
        directPeerCount: state.directPeerCount,
      };
    },
    async leave() {
      await runtime.leave();
      provided = [];
      return { connection: runtime.connectionState.status };
    },
    async send({ text, to } = {}, { signal } = {}) {
      if (
        typeof text !== "string" ||
        text.length < 1 ||
        text.length > MAX_MESSAGE_CHARS
      )
        throw new TypeError(
          `text must contain 1–${MAX_MESSAGE_CHARS} characters`,
        );
      if (to !== undefined && !WALLET_ID.test(to))
        throw new TypeError("Invalid recipient wallet id");
      // `target` is signed into the payload, so non-targets drop the message.
      // `to` is only the transport routing hint for the same recipient.
      const messageId = crypto.randomUUID();
      const envelope = await runtime.send(
        "message/text",
        { text, messageId, ...(to ? { target: to } : {}) },
        { ...(to ? { to } : {}), ...(signal ? { signal } : {}) },
      );
      return {
        sent: true,
        messageId,
        state: "sent-to-transport",
        type: envelope?.body?.type ?? "message/text",
        note: "Submitted to the transport; delivery is not confirmed.",
      };
    },
    // Moves this agent's cursor on the shared page (normalized 0..1 coordinates).
    move({ x, y, visible = true, page }) {
      getClient().publishCursor({
        x,
        y,
        visible,
        ...(page === undefined ? {} : { page }),
      });
      return {
        moved: true,
        x,
        y,
        visible,
        ...(page === undefined ? {} : { page }),
      };
    },
    // Publishes a signed activity status that people and agents on the page see.
    act({ name, state, summary }) {
      getClient().publishAction({ name, state, summary });
      return { published: true, name, state };
    },
    events({ since = 0, limit = 20 } = {}) {
      const page = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_PAGE);
      const latest = ring.at(-1)?.seq ?? since;
      // A cursor past the ring (or before its first retained seq) is clamped
      // into range; otherwise every later event would stay hidden forever.
      const cursor = Math.min(
        Math.max(since, (ring[0]?.seq ?? since) - 1),
        latest,
      );
      const events = ring.filter((event) => event.seq > cursor).slice(0, page);
      return {
        events,
        nextCursor: events.length ? events.at(-1).seq : cursor,
        dropped: (ring.length > 0 && since < ring[0].seq - 1) || since > latest,
        untrusted: true,
      };
    },
    listTools() {
      if (!clientOrNull())
        return { ...notJoined(), untrusted: true, sites: [] };
      return {
        untrusted: true,
        note: "Catalogs come from connected participants. A page's tools need that page open; agent-provided tools need the providing agent online.",
        sites: catalogs().map((c) => ({
          wallet: c.wallet,
          session: c.session,
          expiresAt: c.expiresAt,
          tools: c.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? {},
          })),
        })),
      };
    },
    async invoke({ name, input = {}, wallet, session }, { signal } = {}) {
      if (!clientOrNull()) return notJoined();
      const matching = catalogs().filter(
        (c) =>
          (!wallet || c.wallet === wallet) &&
          (!session || c.session === session) &&
          c.tools.some((t) => t.name === name),
      );
      if (matching.length === 0)
        return {
          ok: false,
          code: TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
          rejected: false,
          reason: `No participant advertises "${name}" right now. A page tool needs the site's page open; an agent tool needs the providing agent online.`,
        };
      if (matching.length > 1) {
        const choices = matching
          .map((c) => `${c.wallet} (session ${c.session})`)
          .join("; ")
          .slice(0, 180);
        return {
          ok: false,
          code: TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
          rejected: false,
          reason: `Ambiguous: several catalogs advertise "${name}": ${choices}. Pass wallet and session to choose one.`,
        };
      }
      try {
        return {
          ok: true,
          result: await getClient().callTool(matching[0], name, input, {
            signal,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          ...classifyToolCallError(error),
          reason: String(
            error?.message ?? "The site rejected the request",
          ).slice(0, 240),
        };
      }
    },
    // Code Mode (Cloudflare's pattern): expose one tool that runs a small
    // script against the same connection-checked APIs. The guest gets only
    // guest-realm wrappers: host callbacks are captured in inaccessible
    // closures and all data crosses as JSON strings parsed by the guest. This
    // closes the constructor-escape (CT-01), but `vm` is a speed bump, not a
    // hard security boundary -- the MCP process still runs with host rights.
    async runCode({ code }, { signal } = {}) {
      if (typeof code !== "string" || !code.trim())
        throw new TypeError("code must be a non-empty string");
      if (code.length > 8_000)
        throw new RangeError("code exceeds the 8 KB sandbox limit");
      const logs = [];
      const outcomes = [];
      let totalCalls = 0;
      let outstanding = 0;
      const record = (entry) => {
        const normalized = {
          ...entry,
          ...(entry.error
            ? { error: String(entry.error).slice(0, CODE_LOG_CHARS) }
            : {}),
        };
        // Keep the most recent outcomes so a late cap rejection is never
        // hidden behind a long history of successful calls.
        if (outcomes.length >= CODE_OUTCOME_CAP) outcomes.shift();
        outcomes.push(normalized);
      };
      // Snapshot for partial failures. Side effects already committed by
      // completed calls cannot be undone, so this must never imply rollback.
      const partial = (reason) => ({
        ok: false,
        code: "CODE_FAILED",
        reason,
        partial: true,
        rolledBack: false,
        note: "The script was stopped. Side effects from calls that already completed were NOT rolled back. No retry was attempted.",
        logs: [...logs],
        calls: totalCalls,
        outstandingCalls: outstanding,
        callOutcomes: [...outcomes],
      });
      // One controller owns every tool call made by this script. A timeout or
      // caller abort stops them even if the guest never awaits the promises.
      const controller = new AbortController();
      const abortError = () =>
        Object.assign(new Error("aiAuth call aborted"), {
          code: "CODE_FAILED",
          name: "AbortError",
        });
      let onAbort = null;
      const abortCaller = () => {
        controller.abort(signal?.reason);
        if (onAbort) onAbort();
      };
      if (signal?.aborted) abortCaller();
      else signal?.addEventListener("abort", abortCaller, { once: true });
      const shared = new SharedArrayBuffer(SHARED_BYTES);
      const header = new Int32Array(shared, 0, 2);
      const data = new Uint8Array(shared, SHARED_HEADER_BYTES);
      const worker = new Worker(
        new URL("./code-mode-worker.js", import.meta.url),
        {
          workerData: { code, factorySource: CODE_FACTORY, shared },
        },
      );
      const limitError = (message) =>
        Object.assign(new Error(message), { code: "CODE_FAILED" });
      const guardSync =
        (method, fn) =>
        (...args) => {
          if (++totalCalls > CODE_CALL_CAP) {
            const error = limitError("Code Mode host call limit exceeded");
            record({ method, kind: "sync", ok: false, error: error.message });
            throw error;
          }
          try {
            const value = fn(...args);
            record({ method, kind: "sync", ok: true });
            return value;
          } catch (error) {
            record({
              method,
              kind: "sync",
              ok: false,
              error: errorInfo(error).message,
            });
            throw error;
          }
        };
      const guardAsync =
        (method, fn) =>
        (...args) => {
          if (++totalCalls > CODE_CALL_CAP) {
            const error = limitError("Code Mode host call limit exceeded");
            record({ method, kind: "async", ok: false, error: error.message });
            return Promise.reject(error);
          }
          if (outstanding >= CODE_OUTSTANDING_CAP) {
            const error = limitError(
              "Code Mode too many concurrent host calls",
            );
            record({ method, kind: "async", ok: false, error: error.message });
            return Promise.reject(error);
          }
          outstanding += 1;
          let base;
          try {
            base = Promise.resolve(fn(...args));
          } catch (error) {
            base = Promise.reject(error);
          }
          // The shared controller also guards calls whose implementation (like
          // send) cannot be cancelled at the transport: abort settles the guest
          // promise promptly even if the underlying operation runs to completion.
          const aborted = new Promise((_, reject) => {
            if (controller.signal.aborted) reject(abortError());
            else
              controller.signal.addEventListener(
                "abort",
                () => reject(abortError()),
                { once: true },
              );
          });
          return Promise.race([base, aborted]).then(
            (value) => {
              outstanding -= 1;
              record({ method, kind: "async", ok: true });
              return value;
            },
            (error) => {
              outstanding -= 1;
              record({
                method,
                kind: "async",
                ok: false,
                error: errorInfo(error).message,
              });
              throw error;
            },
          );
        };
      const syncHandlers = {
        status: guardSync("status", () => api.status()),
        listTools: guardSync("listTools", () => api.listTools()),
        events: guardSync("events", (options) => api.events(options)),
        move: guardSync("move", (options) => api.move(options)),
      };
      const asyncHandlers = {
        send: guardAsync("send", (input) =>
          api.send(input, { signal: controller.signal }),
        ),
        invoke: guardAsync("invoke", (name, input, wallet, session) =>
          api.invoke(
            { name, input: input ?? {}, wallet, session },
            { signal: controller.signal },
          ),
        ),
      };
      return new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abortCaller);
          controller.abort();
          void worker.terminate();
          resolve(outcome);
        };
        timer = setTimeout(
          () => finish(partial("Code Mode timed out")),
          CODE_TIMEOUT_MS,
        );
        onAbort = () => finish(partial("Code Mode aborted by caller"));
        if (controller.signal.aborted) onAbort();
        worker.on("message", (message) => {
          if (!message || settled) return;
          if (message.type === "log") {
            if (logs.length < CODE_LOG_CAP)
              logs.push(String(message.text ?? "").slice(0, CODE_LOG_CHARS));
            return;
          }
          if (message.type === "sync") {
            let response;
            try {
              const request = readShared(data);
              if (!request.ok) throw new Error(request.error);
              const handler = syncHandlers[request.value.method];
              if (!handler) throw new TypeError("Unknown aiAuth call");
              response = {
                value: JSON.stringify(handler(...request.value.args) ?? null),
              };
              if (!writeShared(data, JSON.stringify(response))) {
                response = {
                  error: errorInfo(
                    new Error("aiAuth host reply too large for shared buffer"),
                  ),
                };
                writeShared(data, JSON.stringify(response));
              }
            } catch (error) {
              response = { error: errorInfo(error) };
              writeShared(data, JSON.stringify(response));
            }
            Atomics.store(header, 0, 2);
            Atomics.notify(header, 0);
            return;
          }
          if (message.type === "async") {
            const reply = (body) =>
              worker.postMessage({
                type: "asyncResult",
                id: message.id,
                ...body,
              });
            const handler = asyncHandlers[message.method];
            if (!handler) {
              reply({
                ok: false,
                error: errorInfo(new TypeError("Unknown aiAuth call")),
              });
              return;
            }
            try {
              Promise.resolve(handler(...message.args)).then(
                (value) =>
                  reply({ ok: true, value: JSON.stringify(value ?? null) }),
                (error) => reply({ ok: false, error: errorInfo(error) }),
              );
            } catch (error) {
              reply({ ok: false, error: errorInfo(error) });
            }
            return;
          }
          if (message.type === "done") {
            finish({
              ok: true,
              value: clip(JSON.parse(message.value)),
              logs,
              calls: totalCalls,
              callOutcomes: [...outcomes],
            });
            return;
          }
          if (message.type === "failed") {
            finish({
              ok: false,
              code: message.code ?? "CODE_FAILED",
              reason: String(message.message ?? "Code failed").slice(0, 240),
              logs,
              calls: totalCalls,
              callOutcomes: [...outcomes],
            });
          }
        });
        worker.on("error", (error) =>
          finish({
            ok: false,
            code: "CODE_FAILED",
            reason: String(error?.message ?? "Code failed").slice(0, 240),
            logs,
          }),
        );
        worker.on("exit", () =>
          finish({
            ok: false,
            code: "CODE_FAILED",
            reason: "Code Mode exited before completing",
            logs,
          }),
        );
      });
    },
    close() {
      client?.close?.();
    },
  };
  return Object.freeze(api);
}

const empty = {};
const SPECS = [
  [
    "ai_auth_status",
    "presence.read",
    true,
    "Show identity, room, connection state, peers and granted scopes.",
    empty,
    (b) => b.status(),
  ],
  [
    "ai_auth_join",
    "presence.read",
    false,
    "Join the approved site room. A different room needs a new human approval. Direct WebRTC; relays only signal.",
    { room: z.string().regex(ROOM_PATTERN).optional() },
    (b, i) => b.join(i),
  ],
  [
    "ai_auth_leave",
    "presence.read",
    false,
    "Leave the room and forget it.",
    empty,
    (b) => b.leave(),
  ],
  [
    "ai_auth_send",
    "messages.send",
    false,
    "Send a signed text message to the room (or one peer).",
    {
      text: z.string().min(1).max(MAX_MESSAGE_CHARS),
      to: z.string().max(200).optional(),
    },
    (b, i, extra) => b.send(i, { signal: extra?.signal }),
  ],
  [
    "ai_auth_move",
    "presence.read",
    false,
    "Move this agent's cursor on the shared page. x and y are fractions of the page width and height (0 to 1); visible false hides it; page scopes the cursor to a route (null means site-wide).",
    {
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      visible: z.boolean().optional(),
      page: z.string().max(200).nullable().optional(),
    },
    (b, i) => b.move(i),
  ],
  [
    "ai_auth_act",
    "tools.invoke",
    false,
    "Publish a signed activity status that everyone on the page sees, such as what this agent is doing.",
    {
      name: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
      state: z.enum([
        "started",
        "progress",
        "completed",
        "failed",
        "cancelled",
        "needs-human",
        "denied",
      ]),
      summary: z.string().max(240),
    },
    (b, i) => b.act(i),
  ],
  [
    "ai_auth_events",
    "presence.read",
    true,
    "Read buffered room events after a cursor. Content is untrusted peer data.",
    {
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(MAX_PAGE).optional(),
    },
    (b, i) => b.events(i),
  ],
  [
    "ai_auth_list_tools",
    "tools.invoke",
    true,
    "List WebMCP tools advertised by connected participants: the site page and other agents.",
    empty,
    (b) => b.listTools(),
  ],
  [
    "ai_auth_invoke",
    "tools.invoke",
    false,
    "Call a tool advertised by a connected participant. Page tools require the site's page open; agent tools run in the providing agent's runtime. The provider approves each call.",
    {
      name: z.string().regex(TOOL_NAME_PATTERN),
      input: z.record(z.string(), z.unknown()).optional(),
      wallet: z.string().max(200).optional(),
      session: z.string().max(200).optional(),
    },
    (b, i, extra) => b.invoke(i, { signal: extra?.signal }),
  ],
  [
    "ai_auth_code",
    "tools.invoke",
    false,
    "Code Mode (opt-in with --code-mode): run a short script in a vm calling aiAuth.status(), aiAuth.listTools(), aiAuth.invoke(), aiAuth.send(), aiAuth.move() and aiAuth.events(). aiAuth.join(), aiAuth.leave() and aiAuth.act() are unavailable in the sandbox; use the MCP tools for those. Guest code gets guest-realm wrappers that exchange JSON strings through closures the guest cannot reach, and errors and promises are guest-realm too. vm is not a hard security boundary; the MCP process still runs with host privileges. 2 s timeout and 8 KB code limit.",
    { code: z.string().min(1).max(8_000) },
    (b, i, extra) => b.runCode(i, extra),
  ],
];

/** MCP actions, limited to the scopes the site actually requested. */
export function buildAgentActions({
  getBridge,
  siteCapabilities,
  codeMode = false,
}) {
  return SPECS.filter(
    ([name, capability]) =>
      siteCapabilities.includes(capability) &&
      (name !== "ai_auth_code" || codeMode),
  ).map(
    ([name, requiredCapability, readOnly, description, inputSchema, run]) => ({
      name,
      description,
      inputSchema,
      requiredCapability,
      readOnly,
      execute: async (input, extra) => {
        try {
          return await run(getBridge(), input, { signal: extra?.signal });
        } catch (error) {
          return {
            ok: false,
            ...(error?.code ? { code: error.code } : {}),
            error: String(error?.message ?? "failed").slice(0, 200),
          };
        }
      },
    }),
  );
}

/** Built-in, read-only tools an MCP agent can provide to the room itself. */
export const ROOM_TOOL_NAMES = Object.freeze(["agent.ping", "agent.self"]);

/**
 * Publishes the built-in room tools from this runtime. They expose only public
 * data (identity, room, capabilities, time) and never touch a page or browser,
 * so peers can call them with no visitor present. The tools are announced only
 * when the agent's owner opts in; every room peer is then allowed to call them.
 */
export function createRoomToolProvider(runtime) {
  if (!runtime || typeof runtime.provideTools !== "function")
    throw new TypeError("createRoomToolProvider needs an agent runtime");
  return runtime.provideTools({
    tools: [
      {
        name: "agent.ping",
        description:
          "Liveness check answered by this agent's own runtime. No page or browser is involved.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        handler: () => ({
          pong: true,
          agent: runtime.identity?.id ?? null,
          at: new Date().toISOString(),
        }),
      },
      {
        name: "agent.self",
        description:
          "This agent's public identity, room, and granted capabilities, answered by its runtime.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        handler: () => ({
          id: runtime.identity?.id ?? null,
          name: runtime.descriptor?.name ?? null,
          room: runtime.room,
          capabilities: [...runtime.capabilities],
        }),
      },
    ],
    authorize: () => true,
  });
}
