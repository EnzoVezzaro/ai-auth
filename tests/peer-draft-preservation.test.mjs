import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { createStubDom } from "./dom-stub.mjs";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

globalThis.crypto ??= webcrypto;

const source = await appSource();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.ok(predicate(), "condition was not met before the deadline");
}

function viewFunctions() {
  const start = source.indexOf("function peerRows()");
  const end = source.indexOf("function activityView()");
  assert.ok(start > -1 && end > start, "the peer view functions are present");
  return source.slice(start, end);
}

// The in-place preservation helper only exists after the fix; including it
// conditionally lets the same test first fail on the old code and pass on the
// new one.
const preservation = source.includes("function renderPeerPreservingDraft(")
  ? extractFunction(source, "renderPeerPreservingDraft")
  : "";

test("WA-02 an inbound chat message keeps the draft, focus and scroll", async () => {
  const { doc } = createStubDom();
  doc.body.innerHTML =
    '<div id="view"></div><span id="view-label"></span><span id="topbar-status"></span>';
  doc.querySelector = (selector) => doc.body.querySelector(selector);
  doc.querySelectorAll = () => [];

  const subscribers = [];
  class FakeRoom {
    constructor() {
      this.peers = new Map();
      this.session = "session-1";
    }
    subscribe(fn) {
      subscribers.push(fn);
    }
    async send() {}
    async close() {}
  }
  class FakeRtc {
    constructor() {
      this.connectionState = { status: "connected" };
    }
    onConnectionState() {}
    async start() {}
    async close() {}
  }

  const state = {
    wallet: { id: "agent:self", name: "My agent" },
    view: "peer",
    room: null,
    rtc: null,
    messages: [],
    privateMode: false,
    externalStatus: "",
    externalRequest: null,
    consent: null,
    externalPendingEvents: [],
    externalRoomReady: false,
  };
  const sandbox = runFragment(
    [
      // Pure formatting helpers from app.js (arrow constants, not functions).
      `const esc = (value) => String(value ?? "").replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);`,
      `const shortId = (value) => (value ? \`\${value.slice(0, 20)}…\${value.slice(-9)}\` : "Not created");`,
      `const dateText = (value) => new Date(value).toLocaleString();`,
      extractFunction(source, "pageHead"),
      viewFunctions(),
      extractFunction(source, "render"),
      preservation,
      extractFunction(source, "startRoom"),
    ].join("\n"),
    {
      document: doc,
      $: (selector) => doc.querySelector(selector),
      location: { origin: "https://wallet.example" },
      roomGeneration: 0,
      state,
      P2PRoom: FakeRoom,
      NostrWebRTC: FakeRtc,
      externalConnectMode: false,
      externalSessionActive: () => false,
      externalHost: null,
      setConnectionLabel() {},
      connectionStatusLabel: () => "Connected",
      debug() {},
      toast() {},
      appendActivity: async () => {},
      readActivity: async () => [],
      bindView() {},
      touchGrant() {},
      handleExternalSiteEvent: async () => {},
      setTimeout,
      clearTimeout,
      Date,
    },
  );

  await sandbox.startRoom();
  await sandbox.render();

  const draft = doc.querySelector("#peer-message");
  assert.ok(draft, "the signed-message draft input is rendered");
  draft.value = "my unfinished draft";
  draft.focus();
  doc.querySelector("#message-list").scrollTop = 137;

  const onRoomEvent = subscribers.at(-1);
  assert.ok(onRoomEvent, "the real startRoom subscribed to room events");
  onRoomEvent({
    direction: "in",
    envelope: {
      body: {
        type: "message/text",
        payload: { text: "incoming hello" },
        issuer: "agent:peer",
        createdAt: Date.now(),
      },
    },
  });

  // The message arrives through appendActivity -> render asynchronously; wait
  // for the real list to show it rather than assuming a fixed number of ticks.
  await waitFor(() =>
    doc.querySelector("#message-list")?.textContent.includes("incoming hello"),
  );

  const after = doc.querySelector("#peer-message");
  assert.equal(
    after.value,
    "my unfinished draft",
    "an inbound message must not wipe the in-progress draft",
  );
  assert.equal(doc.activeElement, after, "focus stays on the draft input");
  assert.equal(
    doc.querySelector("#message-list").scrollTop,
    137,
    "the message list scroll position is preserved",
  );
  assert.ok(
    state.messages.some((message) => message.text === "incoming hello"),
    "the inbound message is still recorded in state",
  );
});
