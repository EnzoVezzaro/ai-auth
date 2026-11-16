import { z } from "zod";
import { createAIAuthAgentClient } from "@enzovezzaro/ai-auth-wallet";

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

  return Object.freeze({
    status() {
      const state = runtime.connectionState;
      return {
        identity: runtime.identity?.id ?? null,
        origin: runtime.origin,
        room: runtime.room,
        capabilities: [...runtime.capabilities],
        connection: state.status,
        directPeerCount: state.directPeerCount,
        peers: runtime
          .peers()
          .map(({ id, name, stale }) => ({ id, name, stale })),
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
        sites: catalogs().map((c) => ({
          wallet: c.wallet,
          expiresAt: c.expiresAt,
          tools: c.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? {},
          })),
        })),
      };
    },
    async invoke({ name, input = {}, wallet }) {
      const matching = catalogs().filter(
        (c) =>
          (!wallet || c.wallet === wallet) &&
          c.tools.some((t) => t.name === name),
      );
      if (matching.length === 0)
        return {
          ok: false,
          rejected: false,
          reason: `No site tool "${name}" is advertised (is the site connected and the tool approved?)`,
        };
      if (matching.length > 1)
        return {
          ok: false,
          rejected: false,
          reason: "Ambiguous: several sites advertise this tool; pass wallet",
        };
      try {
        return {
          ok: true,
          result: await getClient().callTool(matching[0], name, input),
        };
      } catch (error) {
        return {
          ok: false,
          rejected: true,
          reason: String(
            error?.message ?? "The site rejected the request",
          ).slice(0, 240),
        };
      }
    },
    close() {
      client?.close?.();
    },
  });
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
    "List WebMCP tools the connected site advertises.",
    empty,
    (b) => b.listTools(),
  ],
  [
    "ai_auth_invoke",
    "tools.invoke",
    false,
    "Call a site WebMCP tool; the site owner approves. Returns a rejection if denied.",
    {
      name: z.string().min(1).max(64),
      input: z.record(z.string(), z.unknown()).optional(),
      wallet: z.string().max(200).optional(),
    },
    (b, i) => b.invoke(i),
  ],
];

/** MCP actions, limited to the scopes the site actually requested. */
export function buildAgentActions({ getBridge, siteCapabilities }) {
  return SPECS.filter(([, capability]) =>
    siteCapabilities.includes(capability),
  ).map(
    ([name, requiredCapability, readOnly, description, inputSchema, run]) => ({
      name,
      description,
      inputSchema,
      requiredCapability,
      readOnly,
      execute: async (input) => {
        try {
          return await run(getBridge(), input);
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
