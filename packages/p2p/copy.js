// Plain-language copy and formatters for the wallet page and the site connect
// panel. Pure functions only: no DOM, no storage, no network. Times are shown
// in the viewer's local time, never in UTC.

export const WALLET_REQUIRED_MESSAGE =
  "Create your wallet first, then connect.";
export const CANCELLED_MESSAGE =
  "You closed the request. Click Connect agent to try again.";
export const RELOAD_NOTICE =
  "This page was reloaded, so your previous connection ended. Click Connect again to continue.";
export const RECONNECT_LABEL = "Connect again";
export const CONNECT_LABEL = "Connect agent";
export const EXTEND_MINUTES = 30;
export const EXTEND_LABEL = `Extend for ${EXTEND_MINUTES} more minutes`;
export const DISCONNECTED_BY_USER_MESSAGE = "You disconnected.";
export const NO_WALLET_NOTICE =
  "No wallet is saved in this browser yet. Create your wallet first, then connect.";
export const INLINE_WALLET_NOTICE =
  "Create a wallet here in this browser to finish connecting to this site.";
export const WALLET_SAVED_NOTICE =
  "Your wallet is still saved in this browser.";

const MINUTE_MS = 60_000;

function minutesPhrase(ms) {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return "less than a minute";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function clockTime(timestamp, locale) {
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function sessionEndText(expiresAt, now = Date.now(), locale) {
  if (expiresAt === null)
    return "No time limit. The session stays active and resumable after a refresh until you end it.";
  if (!Number.isFinite(expiresAt)) return "The session end time is not known.";
  const remaining = expiresAt - now;
  if (remaining <= 0) return "Session has ended.";
  return `Session ends at ${clockTime(expiresAt, locale)} (in ${minutesPhrase(remaining)})`;
}

export function requestEndText(expiresAt, locale) {
  return `This request expires at ${clockTime(expiresAt, locale)}.`;
}

export function renewalKeptText(expiresAt, locale) {
  return `Your session is still active until ${clockTime(expiresAt, locale)}.`;
}

export function approvalTimeoutMessage(timeoutMs) {
  return `The approval window closed after ${minutesPhrase(timeoutMs)}. Click Connect agent to try again.`;
}

const CONNECTION_LABELS = Object.freeze({
  idle: "Not connected.",
  "approval-pending": "Waiting for your approval.",
  "wallet-authorized": "Approved. Connecting…",
  connecting: "Connecting…",
  signaling: "Connecting…",
  "waiting-for-peers": "Connected. Waiting for other visitors or agents.",
  "direct-peer-connected": "Connected with a live partner.",
  reconnecting: "Connection lost. Trying to reconnect…",
  degraded: "Connection is weak. Trying to recover.",
  expired: "Session expired.",
  revoked: "The wallet ended this session.",
  disconnected: "Disconnected.",
});

export function connectionStatusLabel(status) {
  return Object.hasOwn(CONNECTION_LABELS, status)
    ? CONNECTION_LABELS[status]
    : CONNECTION_LABELS.idle;
}

const CAPABILITY_COPY = Object.freeze({
  "presence.read": {
    title: "See who else is here",
    detail: "Show where this agent's cursor is on the page.",
  },
  "messages.send": {
    title: "Send messages",
    detail: "Send messages to the other visitors and agents here.",
  },
  "content.share": {
    title: "Share selected content",
    detail: "Share only the elements, screenshots or recordings you pick.",
  },
  "tools.invoke": {
    title: "Use the page's tools (you approve each use)",
    detail: "The site still chooses and checks each tool action.",
  },
});

export function capabilityCopy(capability) {
  return Object.hasOwn(CAPABILITY_COPY, capability)
    ? CAPABILITY_COPY[capability]
    : {
        title: "Another permission",
        detail: "The site will check this permission.",
      };
}
