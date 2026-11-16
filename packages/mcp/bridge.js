import vm from "node:vm";
import { z } from "zod";
import {
  createAIAuthAgentClient,
  TOOL_ERROR_CODES,
} from "@enzovezzaro/ai-auth-wallet";

const MAX_EVENTS = 200;
const MAX_PAGE = 50;
const MAX_PAYLOAD_CHARS = 1_500;
const SILENT_TYPES = new Set(["peer/heartbeat"]);

function clip(value) {
  const text = JSON.stringify(value ?? null);
  return text.length <= MAX_PAYLOAD_CHARS
    ? (value ?? null)
    : { truncated: true, preview: text.slice(0, MAX_PAYLOAD_CHARS) };
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
  let seq = 0;
  let client = null;
  const getClient = () => (client ??= clientFactory(runtime.agentRoom));

  runtime.onEvent(({ direction, envelope }) => {
    if (
      direction !== "in" ||
      !envelope?.body ||
      SILENT_TYPES.has(envelope.body.type)
    )
      return;
    seq += 1;
    const { type, issuer, payload } = envelope.body;
    const { kind, text } = payload ?? {};
    ring.push({
      seq,
      type,
      from: issuer,
      at: Date.now(),
      ...(kind ? { kind } : {}),
      payload:
        kind === "tool-catalog"
          ? { kind }
          : clip(text === undefined ? payload : { text }),
    });
    if (ring.length > maxEvents) ring.shift();
  });

  const catalogs = () => (client ?? getClient()).catalogs ?? [];

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
        peers: runtime
          .peers()
          .map(({ id, name, stale }) => ({ id, name, stale })),
        provides: [...providedTools],
        diagnostics: state.diagnostics ?? {},
        note: "Presence lasts only while this MCP process runs.",
      };
    },
    async join({ room } = {}) {
      const state = await runtime.join(room);
      return {
        connection: state.status,
        room: runtime.room,
        directPeerCount: state.directPeerCount,
      };
    },
    async leave() {
      await runtime.leave();
      return { connection: runtime.connectionState.status };
    },
    async send({ text, to }) {
      const envelope = await runtime.send(
        "message/text",
        { text },
        to ? { to } : {},
      );
      return {
        sent: true,
        type: envelope?.body?.type ?? "message/text",
        note: "Submitted to the transport; delivery is not confirmed.",
      };
    },
    // Moves this agent's cursor on the shared page (normalized 0..1 coordinates).
    move({ x, y, visible = true }) {
      getClient().publishCursor({ x, y, visible });
      return { moved: true, x, y, visible };
    },
    // Publishes a signed activity status that people and agents on the page see.
    act({ name, state, summary }) {
      getClient().publishAction({ name, state, summary });
      return { published: true, name, state };
    },
    events({ since = 0, limit = 20 } = {}) {
      const page = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_PAGE);
      const fresh = ring.filter((event) => event.seq > since);
      const events = fresh.slice(0, page);
      return {
        events,
        nextCursor: events.length ? events.at(-1).seq : since,
        dropped: ring.length > 0 && since < ring[0].seq - 1,
        untrusted: true,
      };
    },
    listTools() {
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
    async invoke({ name, input = {}, wallet }, { signal } = {}) {
      const matching = catalogs().filter(
        (c) =>
          (!wallet || c.wallet === wallet) &&
          c.tools.some((t) => t.name === name),
      );
      if (matching.length === 0)
        return {
          ok: false,
          code: TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
          rejected: false,
          reason: `No participant advertises "${name}" right now. A page tool needs the site's page open; an agent tool needs the providing agent online.`,
        };
      if (matching.length > 1)
        return {
          ok: false,
          code: TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
          rejected: false,
          reason:
            "Ambiguous: several participants advertise this tool; pass wallet",
        };
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
          code: error?.code ?? TOOL_ERROR_CODES.TOOL_UNAVAILABLE,
          rejected: true,
          reason: String(
            error?.message ?? "The site rejected the request",
          ).slice(0, 240),
        };
      }
    },
    // Code Mode (Cloudflare's pattern): expose one tool that runs a small,
    // sandboxed script which calls the same connection-checked APIs. The script
    // has no network, no filesystem, no process and no imported modules; every
    // side effect goes through `aiAuth`, which revalidates the live connection.
    async runCode({ code }, { signal } = {}) {
      if (typeof code !== "string" || !code.trim())
        throw new TypeError("code must be a non-empty string");
      if (code.length > 8_000)
        throw new RangeError("code exceeds the 8 KB sandbox limit");
      const logs = [];
      const format = (value) => {
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value ?? null);
        } catch {
          return String(value);
        }
      };
      const sandbox = Object.freeze({
        console: Object.freeze({
          log: (...parts) => {
            if (logs.length < 50) logs.push(parts.map(format).join(" "));
          },
        }),
        aiAuth: Object.freeze({
          status: () => api.status(),
          listTools: () => api.listTools(),
          events: (options) => api.events(options),
          send: (input) => api.send(input),
          move: (input) => api.move(input),
          invoke: (name, input = {}, wallet) =>
            api.invoke({ name, input, wallet }, { signal }),
        }),
      });
      const context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
      });
      const script = new vm.Script(
        `"use strict";\n(async () => {\n${code}\n})()`,
        { timeout: 2_000 },
      );
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Code Mode timed out")),
          2_000,
        );
      });
      try {
        const value = await Promise.race([
          Promise.resolve(script.runInContext(context, { timeout: 2_000 })),
          timeout,
        ]);
        return { ok: true, value: clip(value), logs };
      } catch (error) {
        return {
          ok: false,
          code: error?.code ?? "CODE_FAILED",
          reason: String(error?.message ?? "Code failed").slice(0, 240),
          logs,
        };
      } finally {
        clearTimeout(timer);
      }
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
    "Join (or switch) the site room. Direct WebRTC; relays only signal.",
    { room: z.string().max(100).optional() },
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
    { text: z.string().min(1).max(2_000), to: z.string().max(200).optional() },
    (b, i) => b.send(i),
  ],
  [
    "ai_auth_move",
    "presence.read",
    false,
    "Move this agent's cursor on the shared page. x and y are fractions of the page width and height (0 to 1); visible false hides it.",
    {
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      visible: z.boolean().optional(),
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
      name: z.string().min(1).max(64),
      input: z.record(z.string(), z.unknown()).optional(),
      wallet: z.string().max(200).optional(),
    },
    (b, i) => b.invoke(i),
  ],
  [
    "ai_auth_code",
    "tools.invoke",
    false,
    "Code Mode: run a small sandboxed script that calls aiAuth.status/listTools/invoke/send. No network, filesystem, process or imports; every call revalidates the live connection.",
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
