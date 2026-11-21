import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SESSION_TTL_MS,
  sessionLimits,
} from "../packages/p2p/index.js";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

const source = await appSource();
const ORIGIN = "https://site.example";
const MINUTE = 60_000;

function approvalCopy() {
  // A Never grant has no end: the approval view must not promise a short
  // lifetime. Run the real connectView against that state.
  const sandbox = runFragment(extractFunction(source, "connectView"), {
    console,
    state: {
      externalRequest: null,
      wallet: { id: "agent:test", name: "Test" },
      consent: { body: { payload: { expiresAt: null } } },
      request: { audience: "https://site.example" },
    },
    location: { origin: "https://site.example" },
    capabilityOptions: [],
    pageHead: (eyebrow, title, description) =>
      `<header>${eyebrow} ${title} ${description}</header>`,
    walletRequired: () => "",
    setupFormError: () => "",
    esc: (value) => String(value),
  });
  return sandbox.connectView();
}

test("approval copy does not claim a lifetime the grant may not have", () => {
  const html = approvalCopy();
  assert.doesNotMatch(
    html,
    /expires quickly/u,
    "a Never grant does not expire quickly",
  );
  assert.doesNotMatch(
    html,
    /the time limit and the permissions/u,
    "a Never grant has no fixed time limit to confirm",
  );
  assert.match(
    html,
    /lasts only as long as you choose/u,
    "the copy explains that the person chooses the lifetime",
  );
});

// Render the real pending-request view, including the duration <select>, with
// the real limit helpers from apps/p2p/app.js and packages/p2p/connect.js.
function requestView({ request, grants = [] } = {}) {
  const state = {
    wallet: { id: "wallet:owner", name: "Test" },
    externalOrigin: ORIGIN,
    externalRequest: request,
    externalStatus: "",
    error: "",
    grants,
  };
  const sandbox = runFragment(
    [
      extractFunction(source, "pageHead"),
      extractFunction(source, "durationText"),
      extractFunction(source, "defaultSessionTtl"),
      extractFunction(source, "hasSavedGrantForRequest"),
      extractFunction(source, "sessionLimitCopy"),
      extractFunction(source, "sessionTtlChoices"),
      extractFunction(source, "externalPermissionView"),
    ].join("\n"),
    {
      state,
      location: { origin: ORIGIN },
      esc: (value) => String(value ?? ""),
      capabilityCopy: (id) => ({ title: id, detail: id }),
      requestEndText: () => "This request expires soon.",
      dateText: (value) => String(value),
      setupFormError: () => "",
      sessionLimits,
      DEFAULT_SESSION_TTL_MS,
      console,
    },
  );
  return sandbox.externalPermissionView();
}

function siteRequest(overrides = {}) {
  return {
    audience: ORIGIN,
    room: "default",
    capabilities: ["presence.read", "messages.send"],
    nonce: "nonce-1",
    expiresAt: Date.now() + MINUTE,
    // Explicit site opt-in to unlimited duration, so Never is an option.
    sessionTtlMs: null,
    ...overrides,
  };
}

function savedGrant(overrides = {}) {
  return {
    audience: ORIGIN,
    room: "default",
    capabilities: ["presence.read", "messages.send"],
    expiresAt: null,
    ended: false,
    consent: { body: { issuer: "wallet:owner" } },
    ...overrides,
  };
}

test("P1-15 first use pre-selects 30 minutes, not an indefinite session", () => {
  const html = requestView({ request: siteRequest() });
  assert.match(
    html,
    /<option value="1800000" selected>30 minutes<\/option>/u,
    "the bounded default is the selected option",
  );
  assert.match(
    html,
    /<option value="never">Until I disconnect — no automatic expiry<\/option>/u,
    "the unlimited choice is still offered and explained",
  );
  assert.match(
    html,
    /"Until I disconnect" has no time or idle limit/u,
    "the copy says there is no automatic expiry",
  );
});

test("P1-15 a saved origin+room+scopes grant keeps its previous Never default", () => {
  const html = requestView({
    request: siteRequest(),
    grants: [savedGrant()],
  });
  assert.match(
    html,
    /<option value="never" selected>/u,
    "a returning relationship is not silently changed",
  );
  assert.doesNotMatch(html, /<option value="1800000" selected>/u);
});

test("P1-15 changed scopes, rooms, revocations and other wallets do not suppress the bounded default", () => {
  const cases = [
    ["different scopes", savedGrant({ capabilities: ["presence.read"] })],
    ["different room", savedGrant({ room: "another-room" })],
    ["revoked grant", savedGrant({ ended: true })],
    ["expired grant", savedGrant({ expiresAt: Date.now() - 1 })],
    [
      "another wallet's grant",
      savedGrant({
        consent: { body: { issuer: "wallet:someone-else" } },
      }),
    ],
  ];
  for (const [label, grant] of cases)
    assert.match(
      requestView({ request: siteRequest(), grants: [grant] }),
      /<option value="1800000" selected>/u,
      `${label} is treated as first use`,
    );
});

test("P1-15 a site cap shorter than 30 minutes is selected and Never is not offered", () => {
  const html = requestView({
    request: siteRequest({ sessionTtlMs: 5 * MINUTE }),
  });
  assert.match(html, /<option value="300000" selected>5 minutes<\/option>/u);
  assert.doesNotMatch(html, /value="never"/u);
});
