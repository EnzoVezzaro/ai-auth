import assert from "node:assert/strict";
import test from "node:test";
import {
  appSource,
  extractFunction,
  extractIfContaining,
  runFragment,
} from "./helpers/app-source.mjs";

const source = await appSource();
const ORIGIN = "https://site.example";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

function sandbox(state, extra = "") {
  return runFragment(
    [
      `const esc = ${esc.toString()};`,
      extractFunction(source, "pageHead"),
      extractFunction(source, "externalPermissionView"),
      extractFunction(source, "expireExternalSession"),
      extra,
    ].join("\n"),
    {
      state,
      externalHost: state.externalSource,
      roomGeneration: 0,
      markSessionEnded: async () => {},
      clearTimeout() {},
      render() {},
      console,
    },
  );
}

function activeState() {
  return {
    wallet: { id: "agent:self", name: "My agent" },
    externalStatus: "sent",
    externalOrigin: ORIGIN,
    externalSource: { postMessage() {} },
    externalRequest: { audience: ORIGIN },
    externalPendingEvents: [],
    consent: { body: { payload: { requestNonce: "nonce-1" } } },
    lease: { revoke() {} },
    transfers: null,
    room: null,
    rtc: null,
    renewal: null,
  };
}

test("03-06 a visitor ending a session shows an ended view, not the expiry view", async () => {
  const state = activeState();
  const run = sandbox(state);
  await run.expireExternalSession("ended");
  assert.equal(
    state.externalStatus,
    "ended",
    "ending a session is a distinct status from expiry",
  );
  const html = run.externalPermissionView();
  assert.match(html, /You ended this session\./u);
  assert.doesNotMatch(html, /SESSION EXPIRED/u);
  assert.doesNotMatch(html, /reached its expiry/u);
});

test("03-06 a site disconnect shows a site-ended view", async () => {
  const state = activeState();
  const handler = `async function handle(event) { ${extractIfContaining(
    source,
    'event.data?.type === "ai-auth/session-ended"',
  )} }`;
  const run = sandbox(state, handler);
  await run.handle({
    source: state.externalSource,
    origin: ORIGIN,
    data: { type: "ai-auth/session-ended", reason: "ended" },
  });
  assert.equal(state.externalStatus, "ended");
  const html = run.externalPermissionView();
  assert.match(html, /The site ended this session\./u);
  assert.doesNotMatch(html, /SESSION EXPIRED/u);
  assert.doesNotMatch(html, /reached its expiry/u);
});
