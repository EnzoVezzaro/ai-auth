// Agent-first connection page.
//
// The site opens its own room silently (no human wallet form). It publishes a
// public connect link/instruction and shows live feedback as agents connect
// using their OWN self-custodied identities. The human never creates an agent
// identity here: the agent does that in its own keystore.
import {
  createWallet,
  loadWallet,
  P2PRoom,
  NostrWebRTC,
  createAIAuthAgentClient,
  createAIAuthConnectInstruction,
} from "@enzovezzaro/ai-auth-wallet";

const CAPABILITIES = ["presence.read", "messages.send", "tools.invoke"];
const params = new URLSearchParams(location.search);
const room = params.get("room") ?? "default";

const $ = (selector) => document.querySelector(selector);
const state = { agents: new Map(), messages: 0, activity: 0, tools: 0 };
window.__connectAgent = state;

function status(text, live = false) {
  $("#room-status").innerHTML = `<span class="dot"></span>${text}`;
  const pill = $("#live-pill");
  pill.textContent = live ? "LIVE" : "WAITING";
  pill.classList.toggle("live-pill", live);
}

function short(id) {
  return id ? id.replace(/^agent:/u, "").slice(0, 10) : "?";
}

function render() {
  $("#count-agents").textContent = String(state.agents.size);
  $("#count-messages").textContent = String(state.messages);
  $("#count-activity").textContent = String(state.activity);
  $("#count-tools").textContent = String(state.tools);

  const people = $("#participants");
  people.replaceChildren(
    ...(state.agents.size
      ? [...state.agents.values()].map((name) => {
          const li = document.createElement("li");
          li.textContent = name ? `${name} · ${short(name)}` : short(name);
          return li;
        })
      : [
          Object.assign(document.createElement("li"), {
            className: "empty",
            textContent: "No agents yet. Share the link above.",
          }),
        ]),
  );

  const activity = $("#activity");
  activity.replaceChildren(
    ...((state.activityItems?.length ?? 0)
      ? state.activityItems.slice(-8).map(({ label, text }) => {
          const li = document.createElement("li");
          const tag = document.createElement("span");
          tag.textContent = `${label} `;
          li.append(tag, document.createTextNode(text));
          return li;
        })
      : [
          Object.assign(document.createElement("li"), {
            className: "empty",
            textContent: "Nothing here yet.",
          }),
        ]),
  );
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = old), 1400);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

async function start() {
  const origin = location.origin;
  const walletUrl = new URL("../wallet/", location.href).href;

  const instruction = createAIAuthConnectInstruction({
    siteName: "AI Auth workspace",
    siteOrigin: origin,
    walletUrl,
    capabilities: CAPABILITIES,
    room,
  });
  // Keep the four lines the portable connect skill parses, but replace the
  // browser-wallet snippet with agent-first guidance. The skill ignores the
  // tail; a human reading the link now sees the actual flow.
  const header = instruction.instruction.split("\n").slice(0, 5).join("\n");
  $("#instruction").value = `${header}

Give this instruction to an agent, or say:
"Connect to this website using AI Auth."

The agent creates its own encrypted wallet and joins the room directly.
No human wallet, approval or account is required to see it here.`;
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
  $("#site-link").value = link;
  $("#copy-link").addEventListener("click", () => copy(link, $("#copy-link")));
  $("#copy-instruction").addEventListener("click", () =>
    copy(instruction.instruction, $("#copy-instruction")),
  );

  // The site's own observer identity. Created locally, never shown as a form.
  let wallet;
  try {
    wallet = await loadWallet();
  } catch {
    wallet = null;
  }
  if (!wallet) {
    wallet = await createWallet({
      name: "Connect Agent workspace",
      passphrase: crypto.randomUUID(),
    });
  }

  const siteRoom = new P2PRoom(wallet, room, {
    origin,
    capabilities: CAPABILITIES,
  });
  const transport = new NostrWebRTC(siteRoom, { origin, room });
  const client = createAIAuthAgentClient(siteRoom);

  transport.onConnectionState((snapshot) => {
    if (snapshot.status === "direct-peer-connected")
      status("peer connected", true);
    else if (snapshot.status === "waiting-for-peers")
      status("waiting for an agent");
    else status(snapshot.status ?? "connecting", false);
  });

  siteRoom.subscribe(({ direction, envelope }) => {
    if (direction !== "in") return;
    const { type, issuer, payload = {} } = envelope.body ?? {};
    if (type === "peer/hello" || type === "presence/heartbeat") {
      if (issuer && issuer !== wallet.id) {
        state.agents.set(issuer, payload.label ?? short(issuer));
        render();
      } else if (type === "peer/hello") {
        status("agent joining", true);
      }
    } else if (type === "message/text" && typeof payload.text === "string") {
      state.messages += 1;
      (state.activityItems ??= []).push({
        label: short(issuer),
        text: payload.text.slice(0, 180),
      });
      render();
    } else if (type === "agent/action" && payload.name) {
      state.activity += 1;
      (state.activityItems ??= []).push({
        label: short(issuer),
        text: `${payload.name}: ${String(payload.summary ?? payload.state ?? "").slice(0, 150)}`,
      });
      render();
    }
  });

  client.onCatalog(() => {
    state.tools = client.catalogs.reduce(
      (total, catalog) => total + (catalog.tools?.length ?? 0),
      0,
    );
    render();
  });

  render();
  status("opening room…");
  await transport.start();
  status("waiting for an agent");
  window.__connectAgentRoom = { siteRoom, transport, client, wallet };
}

start().catch((error) => {
  $("#error").textContent = error.message;
  status("error");
});
