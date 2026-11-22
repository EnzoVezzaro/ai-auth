// Minimal site that connects agents with AI Auth connect links.
// No wallet is opened here: the agent brings its own identity.
import {
  createAIAuthAgentLink,
  mountAIAuthAgentConnect,
  mountAIAuthInPageAgent,
} from "../../packages/p2p/browser.js";

const SITE_NAME = "Agent connect example";
const room = new URLSearchParams(location.search).get("room") ?? "agent-link";
const $ = (selector) => document.querySelector(selector);
const events = [];
const mask = (id) =>
  id?.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;

function log(text) {
  events.unshift(text);
  events.length = Math.min(events.length, 20);
  $("#events").replaceChildren(
    ...events.map((line) =>
      Object.assign(document.createElement("li"), { textContent: line }),
    ),
  );
}

const link = createAIAuthAgentLink({
  siteName: SITE_NAME,
  capabilities: ["presence.read", "messages.send", "tools.invoke"],
  room,
  // The link opens this page; its secret stays in the URL fragment.
  linkBaseUrl: `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`,
});

link.onChange((view) => {
  $("#status").textContent =
    view.phase === "connected"
      ? `Connected · ${view.agents.map((a) => a.name).join(", ")}`
      : view.phase === "checking"
        ? "Checking for your agent…"
        : view.phase === "needs-link"
          ? "Waiting for your agent"
          : "Not connected";
  $("#agents").replaceChildren(
    ...view.agents.map((agent) =>
      Object.assign(document.createElement("li"), {
        textContent: `${agent.name} · ${mask(agent.id)} · ${agent.capabilities.join(", ")}`,
      }),
    ),
  );
});

mountAIAuthAgentConnect({ controller: link, button: $("#connect") });

// Site tools for connected agents. The requester id comes from the agent's
// signature, so an agent can only ever ask about itself.
await link.start();
await mountAIAuthInPageAgent({
  connection: link.toolConnection(),
  actions: [
    {
      name: "site.whoami",
      description: `Tell the calling agent which site this is and how it is connected.`,
      inputSchema: { type: "object", properties: {} },
      requiredCapability: "tools.invoke",
      readOnly: true,
      execute: async (_input, context) => {
        const agent = link.agent(context?.requester?.id);
        return {
          site: { name: SITE_NAME, origin: location.origin, room },
          connected: Boolean(agent),
          agent,
          message: agent
            ? `You are connected to ${SITE_NAME} (${location.origin}) as ${agent.name}.`
            : `You are not connected to ${SITE_NAME}.`,
        };
      },
    },
  ],
  // whoami only describes the caller to itself. A site with side effects
  // should ask its user here before running a tool.
  authorize: async (action, _input, context) => {
    const allowed =
      action.name === "site.whoami" &&
      Boolean(link.agent(context?.requester?.id));
    log(
      `${allowed ? "Answered" : "Refused"} ${action.name} for ${mask(context?.requester?.id)}`,
    );
    return allowed;
  },
});

window.__agentLinkSite = { link };
