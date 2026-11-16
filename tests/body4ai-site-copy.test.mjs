import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_WALLET_MESSAGE,
  approvalFailureMessage,
  capabilityLabel,
  connectionStatusLabel,
  requirePassphrase,
  requireWallet,
  sessionEndText,
} from "../examples/body4ai/site/messages.js";

const MINUTE = 60_000;
const EXPIRES_AT = Date.UTC(2026, 10, 16, 3, 4, 15, 828);

test("connect without a wallet fails with the plain message", () => {
  assert.throws(() => requireWallet(null), {
    message: "Create your wallet first, then connect.",
  });
  assert.equal(NO_WALLET_MESSAGE, "Create your wallet first, then connect.");
  assert.doesNotThrow(() => requireWallet({ id: "wallet:abc" }));
});

test("capabilities show plain words, never raw ids", () => {
  assert.equal(
    capabilityLabel("tools.invoke"),
    "Use the page's tools (you approve each use)",
  );
  assert.equal(capabilityLabel("presence.read"), "See who else is here");
  assert.equal(capabilityLabel("messages.send"), "Send messages");
  assert.equal(
    capabilityLabel("content.share"),
    "Share files and page elements",
  );
  assert.equal(capabilityLabel("made.up.scope"), "Another permission");
});

test("the status line matches the real connection state", () => {
  const connected = (transport) => ({ phase: "connected", transport });
  assert.equal(connectionStatusLabel({ phase: "connecting" }), "Connecting…");
  assert.equal(
    connectionStatusLabel(connected("approval-pending")),
    "Connecting…",
  );
  assert.equal(
    connectionStatusLabel(connected("waiting-for-peers")),
    "Connected. Waiting for other visitors or agents.",
  );
  assert.equal(
    connectionStatusLabel(connected("direct-peer-connected")),
    "Connected with a live partner.",
  );
  assert.equal(
    connectionStatusLabel(connected("degraded")),
    "Connection is weak. Trying to recover.",
  );
  assert.equal(
    connectionStatusLabel({ phase: "disconnected", reason: "disconnected" }),
    "Disconnected.",
  );
  assert.equal(
    connectionStatusLabel({ phase: "disconnected", reason: "closed" }),
    "You disconnected.",
  );
  assert.equal(
    connectionStatusLabel({ phase: "disconnected", reason: "expired" }),
    "Connection expired. Click Connect agent to connect again.",
  );
});

test("the session end time is local and counts down", () => {
  assert.equal(
    sessionEndText({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_AT - 29 * MINUTE - 5_000,
      timeZone: "UTC",
    }),
    "Session ends at 3:04 AM (in 29 minutes)",
  );
  assert.equal(
    sessionEndText({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_AT - MINUTE,
      timeZone: "UTC",
    }),
    "Session ends at 3:04 AM (in 1 minute)",
  );
  assert.equal(
    sessionEndText({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_AT - 20_000,
      timeZone: "UTC",
    }),
    "Session ends at 3:04 AM (in less than a minute)",
  );
  assert.equal(
    sessionEndText({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_AT + 1,
      timeZone: "UTC",
    }),
    "Session ended at 3:04 AM.",
  );
});

test("a timed-out or refused approval says what to do next", () => {
  assert.equal(
    approvalFailureMessage("timeout"),
    "The approval window closed after 2 minutes. Click Connect agent to try again.",
  );
  assert.equal(
    approvalFailureMessage("denied"),
    "You did not allow the connection. Click Connect agent to try again.",
  );
  assert.equal(
    approvalFailureMessage("cancelled"),
    "You did not allow the connection. Click Connect agent to try again.",
  );
});

test("a declined renewal keeps the current end time", () => {
  assert.equal(
    approvalFailureMessage("denied", {
      renewal: true,
      endsAt: EXPIRES_AT,
      timeZone: "UTC",
    }),
    "Your session is still active until 3:04 AM.",
  );
});

test("a recovery passphrase must be long enough before the wallet is made", () => {
  assert.throws(() => requirePassphrase("short"), {
    message: "Choose a recovery passphrase with at least 12 characters.",
  });
  assert.doesNotThrow(() => requirePassphrase("correct horse battery"));
});
