import assert from "node:assert/strict";
import test from "node:test";
import {
  CANCELLED_MESSAGE,
  EXTEND_LABEL,
  RELOAD_NOTICE,
  WALLET_REQUIRED_MESSAGE,
  approvalTimeoutMessage,
  capabilityCopy,
  clockTime,
  connectionStatusLabel,
  renewalKeptText,
  requestEndText,
  sessionEndText,
} from "../packages/p2p/copy.js";

// Local-time instants keep these assertions independent of the test machine's
// time zone.
const at = (hour, minute) => new Date(2026, 10, 16, hour, minute).getTime();

test("clock times are local and read like a person would say them", () => {
  assert.match(clockTime(at(3, 4), "en-US"), /^3:04\s?AM$/u);
  assert.match(clockTime(at(15, 30), "en-US"), /^3:30\s?PM$/u);
  assert.doesNotMatch(clockTime(at(3, 4)), /T|Z$/u);
});

test("session end says the local time and a countdown", () => {
  const now = at(2, 35);
  assert.equal(
    sessionEndText(at(3, 4) + 15_000, now, "en-US").replace(/\s/gu, " "),
    "Session ends at 3:04 AM (in 29 minutes)",
  );
});

test("a session with under a minute left says so, and an ended one says it has ended", () => {
  const expiresAt = at(3, 4);
  assert.match(
    sessionEndText(expiresAt, expiresAt - 30_000, "en-US"),
    /\(in less than a minute\)$/u,
  );
  assert.equal(sessionEndText(expiresAt, expiresAt + 1), "Session has ended.");
});

test("request and kept-session times are plain sentences", () => {
  assert.match(
    requestEndText(at(3, 4), "en-US"),
    /^This request expires at 3:04\s?AM\.$/u,
  );
  assert.match(
    renewalKeptText(at(3, 4), "en-US"),
    /^Your session is still active until 3:04\s?AM\.$/u,
  );
});

test("approval window messages name the real wait and the next step", () => {
  assert.equal(
    approvalTimeoutMessage(120_000),
    "The approval window closed after 2 minutes. Click Connect agent to try again.",
  );
  assert.equal(
    CANCELLED_MESSAGE,
    "You closed the request. Click Connect agent to try again.",
  );
});

test("each SDK connection status has one plain label", () => {
  assert.deepEqual(
    [
      "signaling",
      "waiting-for-peers",
      "direct-peer-connected",
      "degraded",
      "disconnected",
    ].map(connectionStatusLabel),
    [
      "Connecting…",
      "Connected. Waiting for other visitors or agents.",
      "Connected with a live partner.",
      "Connection is weak. Trying to recover.",
      "Disconnected.",
    ],
  );
  assert.equal(connectionStatusLabel("not-a-status"), "Not connected.");
});

test("permission copy is plain words, and unknown permissions get a safe fallback", () => {
  assert.equal(capabilityCopy("presence.read").title, "See who else is here");
  assert.equal(capabilityCopy("messages.send").title, "Send messages");
  assert.equal(
    capabilityCopy("tools.invoke").title,
    "Use the page's tools (you approve each use)",
  );
  assert.equal(capabilityCopy("made.up").title, "Another permission");
});

test("renewal and reload wording is explicit about what happens next", () => {
  assert.equal(EXTEND_LABEL, "Extend for 30 more minutes");
  assert.equal(
    RELOAD_NOTICE,
    "This page was reloaded, so your previous connection ended. Click Connect again to continue.",
  );
  assert.equal(
    WALLET_REQUIRED_MESSAGE,
    "Create your wallet first, then connect.",
  );
});
