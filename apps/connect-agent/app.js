// Guided agent onboarding, all from the SDK:
// 1 connect → 2 create identity + backup → 3 install into an agent instance →
// 4 agent enabled, connecting to sites through a link.
import {
  createWallet,
  loadWallet,
  bindInstance,
  createInstanceId,
  P2PRoom,
  NostrWebRTC,
  createAIAuthAgentClient,
  createAIAuthConnectInstruction,
} from "@enzovezzaro/ai-auth-wallet";

const CAPABILITIES = ["presence.read", "messages.send", "tools.invoke"];
const LABELS = {
  "presence.read": "See who else is here",
  "messages.send": "Send messages",
  "tools.invoke": "Use the page's tools (you approve each use)",
};
const labelFor = (capability) => LABELS[capability] ?? capability;
const params = new URLSearchParams(location.search);
const room = params.get("room") ?? "default";

const $ = (selector) => document.querySelector(selector);
const state = { phase: "setup", name: null, id: null, items: [] };
window.__connectAgent = state;

function setPhase(phase) {
  state.phase = phase;
  const step =
    { setup: 1, install: 3, connected: 4, disconnected: 4 }[phase] ?? 1;
  document.querySelectorAll(".stepper li").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.step) === step);
  });
  const pill = $("#status-pill");
  const live = phase === "connected";
  pill.classList.toggle("live", live);
  pill.lastChild.textContent = ` ${
    {
      setup: "AWAITING IDENTITY",
      install: "INSTALL AGENT",
      connected: "CONNECTED",
      disconnected: "DISCONNECTED",
    }[phase] ?? phase
  }`;
  $("#state-eyebrow").textContent =
    phase === "connected" ? "4 · SESSION ACTIVE" : "IDENTITY FOR AI AGENTS";
  $("#state-title").textContent =
    phase === "connected" ? "Agent connected" : "Give your agent an identity";
  $("#setup").hidden = phase !== "setup";
  $("#share-block").hidden = phase !== "install";
  $("#session").hidden = phase !== "connected";
  $("#activity").hidden = phase !== "connected";
}

function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderActivity() {
  $("#activity-list").replaceChildren(
    ...state.items.slice(-8).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
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
  const header = instruction.instruction.split("\n").slice(0, 5).join("\n");
  $("#instruction").value = `${header}

Give this to an agent, or say: "Connect to this website using AI Auth."`;
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
  $("#site-link").value = link;
  $("#mcp-command").textContent = `npx -y @enzovezzaro/ai-auth-mcp serve \\
  --http 0 \\
  --connect "${link}" \\
  --open-wallet \\
  --auto-join`;
  $("#mcp-config").textContent = JSON.stringify(
    {
      mcpServers: {
        "ai-auth": {
          type: "http",
          url: "http://127.0.0.1:PORT/mcp/SECRET",
        },
      },
    },
    null,
    2,
  );
  $("#copy-link").addEventListener("click", () => copy(link, $("#copy-link")));
  $("#copy-instruction").addEventListener("click", () =>
    copy($("#instruction").value, $("#copy-instruction")),
  );

  // The site's own room key. Kept separate from the agent identity we mint.
  let siteWallet;
  try {
    siteWallet = await loadWallet();
  } catch {
    siteWallet = null;
  }
  if (!siteWallet)
    siteWallet = await createWallet({
      name: "Connect Agent workspace",
      passphrase: crypto.randomUUID(),
    });

  const siteRoom = new P2PRoom(siteWallet, room, {
    origin,
    capabilities: CAPABILITIES,
  });
  const transport = new NostrWebRTC(siteRoom, { origin, room });
  const client = createAIAuthAgentClient(siteRoom);

  $("#setup").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("#agent-name-input").value.trim();
    const passphrase = $("#passphrase").value;
    if (passphrase.length < 12) {
      $("#error").textContent =
        "Use at least 12 characters for the recovery passphrase.";
      return;
    }
    if (passphrase !== $("#confirm").value) {
      $("#error").textContent = "The passphrases do not match.";
      return;
    }
    $("#error").textContent = "";
    const button = $("#create");
    button.disabled = true;
    button.textContent = "Creating…";
    try {
      // persist:false keeps the browser's own room key intact.
      const agentWallet = await createWallet({
        name,
        passphrase,
        persist: false,
      });
      const instanceId = createInstanceId();
      const binding = await bindInstance(agentWallet, instanceId);
      const installPackage = {
        format: "ai-auth-agent-install",
        version: 1,
        name: agentWallet.name,
        walletId: agentWallet.id,
        instanceId,
        binding,
        backup: agentWallet.backup,
        site: { origin, room, capabilities: CAPABILITIES, link },
      };
      download(
        `${name.replace(/[^a-z0-9_-]+/giu, "-")}-recovery.json`,
        agentWallet.backup,
      );
      download(
        "ai-auth-agent-install.json",
        JSON.stringify(installPackage, null, 2),
      );
      $("#new-id").textContent = `${agentWallet.id} · ${instanceId}`;
      $("#snippet").textContent =
        `import { installAgentIdentity } from "@enzovezzaro/ai-auth-agent";

const agent = await installAgentIdentity({
  dir: "./.ai-auth/agent",
  installPackage: "./ai-auth-agent-install.json",
  passphrase: process.env.AI_AUTH_PASSPHRASE,
});
// agent.id === "${agentWallet.id}"
// agent.instanceId === "${instanceId}"`;
      state.id = agentWallet.id;
      state.name = name;
      setPhase("install");
      window.__connectAgentInstall = installPackage;
    } catch (error) {
      $("#error").textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Create identity & download backup";
    }
  });

  transport.onConnectionState((snapshot) => {
    if (snapshot.status === "direct-peer-connected") setPhase("connected");
  });

  siteRoom.subscribe(({ direction, envelope }) => {
    if (direction !== "in") return;
    const { type, issuer, payload = {} } = envelope.body ?? {};
    if (
      (type === "peer/hello" || type === "presence/heartbeat") &&
      issuer !== siteWallet.id
    ) {
      state.name =
        payload.label ??
        String(issuer)
          .replace(/^agent:/u, "")
          .slice(0, 10);
      state.id = issuer;
      $("#agent-name").textContent = state.name;
      $("#agent-avatar").textContent = state.name.charAt(0).toUpperCase();
      $("#agent-id").textContent = issuer;
      $("#capabilities").replaceChildren(
        ...CAPABILITIES.map((capability) => {
          const chip = document.createElement("span");
          chip.className = "cap-chip";
          chip.textContent = labelFor(capability);
          return chip;
        }),
      );
      if (state.phase !== "connected") setPhase("connected");
    } else if (type === "message/text" && typeof payload.text === "string") {
      state.items.push(`Message: ${payload.text.slice(0, 160)}`);
      renderActivity();
    } else if (type === "agent/action" && payload.name) {
      state.items.push(
        `${payload.name}: ${String(payload.summary ?? payload.state ?? "").slice(0, 140)}`,
      );
      renderActivity();
    }
  });

  $("#disconnect").addEventListener("click", async () => {
    await transport.close();
    setPhase("disconnected");
    $("#reconnect").hidden = false;
  });
  $("#reconnect").addEventListener("click", () => location.reload());

  setPhase("setup");
  await transport.start();
  window.__connectAgentControls = { siteRoom, transport, client, siteWallet };
}

start().catch((error) => {
  $("#error").textContent = error.message;
  setPhase("disconnected");
});
