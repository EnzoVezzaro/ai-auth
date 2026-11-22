// The "Connect" popup for AI Auth agent links. Pressing the site's button
// opens a dialog that first checks whether an agent this browser already
// connected is in the room. If one answers, it is connected. If not, the
// dialog shows a one-time link to give to the agent, wherever it runs.
// No wallet is opened: the agent brings its own.

const CSS = `
.ai-auth-connect{border:0;border-radius:14px;padding:0;width:min(94vw,520px);max-width:none;color:#14110f;background:#fbfaf7;box-shadow:0 20px 60px rgba(0,0,0,.25);font:15px/1.5 system-ui,sans-serif}
.ai-auth-connect::backdrop{background:rgba(20,17,15,.45)}
.ai-auth-connect__body{padding:22px 22px 18px}
.ai-auth-connect h2{margin:0 0 6px;font-size:19px}
.ai-auth-connect p{margin:0 0 12px;color:#4a443f}
.ai-auth-connect__status{font-weight:600;color:#14110f}
.ai-auth-connect__status[data-phase=connected]{color:#166534}
.ai-auth-connect__link{display:flex;gap:8px;margin:0 0 10px}
.ai-auth-connect__link input{flex:1;min-width:0;font:13px ui-monospace,monospace;padding:10px;border:1px solid #b9b2aa;border-radius:8px;background:#fff;color:#14110f}
.ai-auth-connect code{display:block;white-space:pre-wrap;word-break:break-all;font:12px/1.45 ui-monospace,monospace;background:#efebe5;border-radius:8px;padding:10px;margin:0 0 12px}
.ai-auth-connect button{min-height:44px;padding:0 16px;border-radius:999px;border:1px solid #14110f;font:600 14px system-ui,sans-serif;cursor:pointer;background:#14110f;color:#fff}
.ai-auth-connect button.secondary{background:#fff;color:#14110f}
.ai-auth-connect button:focus-visible,.ai-auth-connect input:focus-visible{outline:3px solid #2f5bd3;outline-offset:2px}
.ai-auth-connect__actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.ai-auth-connect ul{margin:0 0 12px;padding-left:18px}
@media (prefers-color-scheme: dark){.ai-auth-connect{background:#1d1a17;color:#f4f1ec}.ai-auth-connect p{color:#c8c0b6}.ai-auth-connect__status{color:#f4f1ec}.ai-auth-connect__status[data-phase=connected]{color:#4ade80}.ai-auth-connect__link input{background:#14110f;color:#f4f1ec;border-color:#5a534c}.ai-auth-connect code{background:#2a2622}.ai-auth-connect button{background:#f4f1ec;color:#14110f;border-color:#f4f1ec}.ai-auth-connect button.secondary{background:transparent;color:#f4f1ec}}
`;

const STATUS_TEXT = {
  idle: "Not connected",
  checking: "Checking for your agent…",
  "needs-link": "Waiting for your agent",
  connected: "Connected",
};

const mask = (id) =>
  typeof id === "string" && id.length > 16
    ? `${id.slice(0, 10)}…${id.slice(-4)}`
    : String(id ?? "");

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

/**
 * Wire a button to the agent connect popup.
 *
 * @param {object} options
 * @param {ReturnType<import("./agent-link-site.js").createAIAuthAgentLink>} options.controller
 * @param {HTMLElement} options.button  The site's Connect button.
 * @param {string} [options.agentCommand] Command shown under the link.
 */
export function mountAIAuthAgentConnect({
  controller,
  button,
  agentCommand = 'npx -y @enzovezzaro/ai-auth-mcp serve --connect "<link>"',
  document: doc = globalThis.document,
} = {}) {
  if (!controller || typeof controller.check !== "function")
    throw new TypeError("An AI Auth agent link controller is required");
  if (!button || typeof button.addEventListener !== "function")
    throw new TypeError("A Connect button element is required");
  if (!doc.getElementById("ai-auth-connect-style")) {
    doc.head.append(
      el(doc, "style", { id: "ai-auth-connect-style", text: CSS }),
    );
  }

  const title = el(doc, "h2", {
    id: "ai-auth-connect-title",
    text: "Connect your agent",
  });
  const status = el(doc, "p", {
    class: "ai-auth-connect__status",
    role: "status",
    "aria-live": "polite",
  });
  const help = el(doc, "p");
  const linkInput = el(doc, "input", {
    readonly: "",
    "aria-label": "Agent connect link",
  });
  const copyButton = el(doc, "button", {
    type: "button",
    class: "secondary",
    text: "Copy link",
  });
  const linkRow = el(doc, "div", { class: "ai-auth-connect__link" }, [
    linkInput,
    copyButton,
  ]);
  const command = el(doc, "code");
  const agents = el(doc, "ul");
  const closeButton = el(doc, "button", { type: "button", text: "Done" });
  const dialog = el(
    doc,
    "dialog",
    { class: "ai-auth-connect", "aria-labelledby": "ai-auth-connect-title" },
    [
      el(doc, "div", { class: "ai-auth-connect__body" }, [
        title,
        status,
        agents,
        help,
        linkRow,
        command,
        el(doc, "div", { class: "ai-auth-connect__actions" }, [closeButton]),
      ]),
    ],
  );
  doc.body.append(dialog);

  function render(view = controller.state) {
    status.dataset.phase = view.phase;
    status.textContent =
      view.phase === "connected" && view.agents.length
        ? `Connected · ${view.agents.map((a) => a.name).join(", ")}`
        : (STATUS_TEXT[view.phase] ?? view.phase);
    agents.replaceChildren(
      ...view.agents.map((agent) =>
        el(doc, "li", {
          text: `${agent.name} (${mask(agent.id)}) · ${agent.capabilities.join(", ") || "no scopes"}`,
        }),
      ),
    );
    agents.hidden = !view.agents.length;
    const showLink = view.phase === "needs-link" && view.link;
    linkRow.hidden = !showLink;
    command.hidden = !showLink;
    if (showLink) {
      linkInput.value = view.link.url;
      command.textContent = agentCommand.replace("<link>", view.link.url);
      const minutes = Math.max(
        1,
        Math.round((view.link.expiresAt - Date.now()) / 60_000),
      );
      help.textContent = `Give this link to your agent, on this computer or another one. It works once and expires in ${minutes} min. If the agent has no AI Auth identity yet, it creates one on its own machine. After that it reconnects on its own.`;
    } else if (view.phase === "checking") {
      help.textContent =
        "Looking for an agent you connected before. It answers a fresh signed challenge.";
    } else if (view.phase === "connected") {
      help.textContent =
        "Your agent proved its identity with a fresh signature. It reconnects automatically next time.";
    } else {
      help.textContent = "";
    }
    help.hidden = !help.textContent;
  }

  const stop = controller.onChange((view) => render(view));
  const onClick = async () => {
    if (!dialog.open) dialog.showModal();
    render();
    try {
      await controller.check();
    } catch (error) {
      status.textContent = `Could not start: ${error?.message ?? error}`;
    }
  };
  button.addEventListener("click", onClick);
  copyButton.addEventListener("click", async () => {
    try {
      await globalThis.navigator?.clipboard?.writeText(linkInput.value);
      copyButton.textContent = "Copied";
    } catch {
      linkInput.select();
      copyButton.textContent = "Press Ctrl/Cmd+C";
    }
    setTimeout(() => (copyButton.textContent = "Copy link"), 2_000);
  });
  closeButton.addEventListener("click", () => dialog.close());

  return Object.freeze({
    dialog,
    open: onClick,
    close() {
      stop();
      button.removeEventListener("click", onClick);
      dialog.remove();
    },
  });
}
