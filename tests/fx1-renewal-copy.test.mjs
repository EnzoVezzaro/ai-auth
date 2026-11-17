// FX1 renewal copy: the extension label and panel must state the lifetime that
// is actually granted (including Never), and a null expiry must never be
// formatted as an epoch time.
import assert from "node:assert/strict";
import test from "node:test";
import * as copy from "../packages/p2p/copy.js";
import { sessionLimits } from "../packages/p2p/connect.js";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

const ORIGIN = "https://site.example";
const ROOM = "research";
const MINUTE = 60_000;

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

test("FX1-06 renewalKeptText(null) says there is no end time, not the epoch", () => {
  const text = copy.renewalKeptText(null, "en-US");
  assert.doesNotMatch(text, /\d{1,2}:\d{2}/u, "no clock time is formatted");
  assert.match(text, /no time limit|no end|stays active/u);
});

test("FX1-06 extendLabel matches the granted lifetime", () => {
  assert.equal(copy.extendLabel(30 * MINUTE), "Extend for 30 more minutes");
  assert.equal(copy.extendLabel(15 * MINUTE), "Extend for 15 more minutes");
  assert.match(copy.extendLabel(null), /no time limit|for good/u);
});

const source = await appSource();

function renewalPanel(sessionTtlMs) {
  const renewal = {
    capabilities: ["presence.read"],
    ...(sessionTtlMs === undefined ? {} : { sessionTtlMs }),
  };
  const state = {
    wallet: { id: "agent:self", name: "My agent" },
    externalStatus: "sent",
    externalOrigin: ORIGIN,
    externalRequest: {
      audience: ORIGIN,
      room: ROOM,
      capabilities: ["presence.read"],
    },
    consent: {
      body: {
        payload: {
          capabilities: ["presence.read"],
          expiresAt: Date.now() + 30 * MINUTE,
          idleTimeoutMs: 10 * MINUTE,
        },
      },
    },
    renewal,
    error: "",
  };
  const sandbox = runFragment(
    [
      `const esc = ${esc.toString()};`,
      extractFunction(source, "pageHead"),
      extractFunction(source, "durationText"),
      extractFunction(source, "defaultSessionTtl"),
      extractFunction(source, "externalPermissionView"),
    ].join("\n"),
    {
      state,
      location: { origin: ORIGIN },
      capabilityCopy: (id) => ({ title: id }),
      inlineCreateWalletForm: () => "",
      INLINE_WALLET_NOTICE: "",
      sessionEndText: () => "Session ends later.",
      sessionLimits,
      DEFAULT_SESSION_TTL_MS: 30 * MINUTE,
      extendLabel: copy.extendLabel,
      extensionPhrase: copy.extensionPhrase,
    },
  );
  return sandbox.externalPermissionView();
}

test("FX1-06 the renewal panel states a Never grant has no time limit", () => {
  const html = renewalPanel(null);
  assert.match(html, /no time limit|for good/u, html);
  assert.doesNotMatch(html, /30 more minutes/u);
});

test("FX1-06 the renewal panel states the granted 15-minute lifetime", () => {
  const html = renewalPanel(15 * MINUTE);
  assert.match(html, /15 more minutes/u, html);
  assert.doesNotMatch(html, /30 more minutes/u);
});
