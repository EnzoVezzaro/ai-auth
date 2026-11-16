// The site's own connect panel. It is rendered in the page (not in a closed
// shadow root) so its status and buttons use the plain copy in messages.js.
// It holds no connection state of its own: site.js passes in a view and
// handles the clicks.
import { EXTEND_LABEL } from "./messages.js";

export function mountConnectPanel({ target, instruction, handlers }) {
  const root = document.createElement("div");
  root.className = "connect-panel";
  const heading = document.createElement("h2");
  heading.textContent = "Connect your agent";
  const intro = document.createElement("p");
  intro.textContent =
    "Your agent can browse this site with you. You choose what it may do, and you can disconnect at any time.";

  const status = document.createElement("p");
  status.id = "connection-status";
  status.className = "connection-status";
  status.setAttribute("role", "status");
  const detail = document.createElement("p");
  detail.className = "connection-detail";
  const error = document.createElement("p");
  error.id = "connect-error";
  error.className = "connect-error";
  error.setAttribute("role", "alert");

  const actions = document.createElement("div");
  actions.className = "connect-actions";
  const connectButton = button("before-panel", "Connect agent", () =>
    handlers.onConnect(),
  );
  const walletBox = document.createElement("div");
  walletBox.className = "wallet-box";
  const passphraseLabel = document.createElement("label");
  passphraseLabel.textContent =
    "Recovery passphrase for your new wallet (at least 12 characters)";
  const passphrase = document.createElement("input");
  passphrase.id = "wallet-passphrase";
  passphrase.type = "password";
  passphrase.autocomplete = "new-password";
  passphraseLabel.append(document.createElement("br"), passphrase);
  const walletButton = button("create-wallet", "Create my wallet", () =>
    handlers.onCreateWallet(passphrase.value),
  );
  walletButton.className = "secondary";
  walletBox.append(passphraseLabel, walletButton);
  const extendButton = button("extend-session", EXTEND_LABEL, () =>
    handlers.onExtend(),
  );
  extendButton.className = "secondary";
  const disconnectButton = button("disconnect-agent", "Disconnect", () =>
    handlers.onDisconnect(),
  );
  disconnectButton.className = "secondary";
  actions.append(connectButton, extendButton, disconnectButton);

  const details = document.createElement("details");
  details.className = "instruction";
  const summary = document.createElement("summary");
  summary.textContent = "Show the instruction for your agent";
  const pre = document.createElement("pre");
  pre.textContent = instruction;
  const copyButton = button("copy-instruction", "Copy instruction", () =>
    copy(instruction, copyButton),
  );
  copyButton.className = "secondary";
  details.append(summary, pre, copyButton);

  root.append(
    heading,
    intro,
    status,
    detail,
    error,
    walletBox,
    actions,
    details,
  );
  target.append(root);

  let copyTimer = null;
  async function copy(text, copyTarget) {
    try {
      await navigator.clipboard.writeText(text);
      copyTarget.textContent = "Copied";
    } catch {
      copyTarget.textContent = "Copy failed. Select the text instead.";
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyTarget.textContent = "Copy instruction";
    }, 2000);
  }

  return {
    render(view) {
      status.textContent = view.status;
      root.dataset.status = view.phase;
      detail.textContent = view.detail ?? "";
      detail.hidden = !view.detail;
      error.textContent = view.error ?? "";
      error.hidden = !view.error;
      connectButton.disabled = view.busy;
      connectButton.textContent = view.busy ? "Connecting…" : "Connect agent";
      connectButton.hidden = view.phase === "connected";
      walletBox.hidden = view.hasWallet || view.busy;
      extendButton.hidden = view.phase !== "connected";
      disconnectButton.hidden = view.phase !== "connected";
    },
    focusConnect() {
      if (!connectButton.hidden && !connectButton.disabled)
        connectButton.focus();
    },
  };
}

function button(id, label, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.id = id;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}
