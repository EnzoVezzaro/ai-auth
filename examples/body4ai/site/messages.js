// Plain-language copy and small pure checks for the BODY4AI demo site. Kept
// free of DOM and SDK imports so the copy can be tested in Node.

export const NO_WALLET_MESSAGE = "Create your wallet first, then connect.";
export const EXTEND_LABEL = "Extend for 30 more minutes";
export const INTRO_TEXT =
  "BODY4AI asks to connect to your agent. Untick anything you don't want to allow. The connection lasts 30 minutes.";
export const APPROVE_LABEL = "Allow selected permissions";
export const ALLOW_LABEL = "Allow";
export const DENY_LABEL = "Don't allow";

const CAPABILITY_LABELS = Object.freeze({
  "tools.invoke": "Use the page's tools (you approve each use)",
  "presence.read": "See who else is here",
  "messages.send": "Send messages",
  "content.share": "Share files and page elements",
});

const TRANSPORT_LABELS = Object.freeze({
  "waiting-for-peers": "Connected. Waiting for other visitors or agents.",
  "direct-peer-connected": "Connected with a live partner.",
  degraded: "Connection is weak. Trying to recover.",
  disconnected: "Disconnected.",
  expired: "Connection expired. Click Connect agent to connect again.",
});

const CLOSED_LABELS = Object.freeze({
  closed: "You disconnected.",
  expired: "Connection expired. Click Connect agent to connect again.",
  idle: "Disconnected after a long pause. Click Connect agent to connect again.",
  revoked:
    "The wallet ended the session. Click Connect agent to connect again.",
});

// An error whose message was written for visitors. Anything else is logged
// and shown as a generic line, never as a raw error text.
export class PlainError extends Error {}

export function requireWallet(wallet) {
  if (!wallet) throw new PlainError(NO_WALLET_MESSAGE);
  return wallet;
}

export const PASSPHRASE_MIN_LENGTH = 12;

export function requirePassphrase(passphrase) {
  if (
    typeof passphrase !== "string" ||
    passphrase.length < PASSPHRASE_MIN_LENGTH
  )
    throw new PlainError(
      `Choose a recovery passphrase with at least ${PASSPHRASE_MIN_LENGTH} characters.`,
    );
  return passphrase;
}

export function capabilityLabel(capability) {
  return CAPABILITY_LABELS[capability] ?? "Another permission";
}

// `view` is { phase, transport, reason }: phase is idle | connecting |
// connected | disconnected; transport is the live transport status.
export function connectionStatusLabel({ phase, transport, reason } = {}) {
  if (phase === "connecting") return "Connecting…";
  if (phase === "connected")
    return TRANSPORT_LABELS[transport] ?? "Connecting…";
  if (phase === "disconnected") return CLOSED_LABELS[reason] ?? "Disconnected.";
  return "Not connected yet. Click Connect agent to start.";
}

function localTime(timestamp, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  })
    .format(new Date(timestamp))
    .replaceAll(/\s+/gu, " ");
}

function remainingText(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "in less than a minute";
  return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
}

export function sessionEndText({ expiresAt, now = Date.now(), timeZone }) {
  const time = localTime(expiresAt, timeZone);
  if (now >= expiresAt) return `Session ended at ${time}.`;
  return `Session ends at ${time} (${remainingText(expiresAt - now)})`;
}

// Message for an approval that did not complete. When `renewal` is true the
// current session is still running, so the message says when it ends.
export function approvalFailureMessage(
  reason,
  { renewal = false, endsAt, timeZone } = {},
) {
  if (renewal)
    return `Your session is still active until ${localTime(endsAt, timeZone)}.`;
  if (reason === "timeout")
    return "The approval window closed after 2 minutes. Click Connect agent to try again.";
  return "You did not allow the connection. Click Connect agent to try again.";
}
