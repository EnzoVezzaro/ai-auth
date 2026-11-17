import assert from "node:assert/strict";
import test from "node:test";
import { createStubDom } from "./dom-stub.mjs";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

const source = await appSource();
const ORIGIN = "https://site.example";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("WA-03/PR-03 the private toggle closes the old room and rebuilds one in iframe mode", async () => {
  const { doc } = createStubDom();
  doc.body.innerHTML = '<button id="toggle-private">Go private</button>';
  doc.querySelector = (selector) => doc.body.querySelector(selector);
  doc.querySelectorAll = () => [];

  const rooms = [];
  const rtcs = [];
  const events = [];
  class FakeRoom {
    constructor() {
      this.peers = new Map();
      this.session = `session-${rooms.length + 1}`;
      this.heartbeatRunning = true;
      this.closed = false;
      rooms.push(this);
      events.push(`${this.session}:created`);
    }
    subscribe() {}
    async send() {}
    async close() {
      if (this.closed) {
        events.push(`${this.session}:closed-twice`);
        return;
      }
      await sleep(5);
      this.closed = true;
      this.heartbeatRunning = false;
      events.push(`${this.session}:closed`);
    }
  }
  class FakeRtc {
    constructor() {
      this.connectionState = { status: "connected" };
      this.closed = false;
      rtcs.push(this);
    }
    onConnectionState() {}
    async start() {}
    async close() {
      await sleep(5);
      this.closed = true;
    }
  }
  class FakeTransfers {
    subscribe() {}
    close() {}
  }

  const state = {
    wallet: { id: "agent:self", name: "My agent" },
    view: "peer",
    room: null,
    rtc: null,
    privateMode: false,
    externalStatus: "sent",
    externalRequest: { room: "research", nonce: "n-1", audience: ORIGIN },
    externalOrigin: ORIGIN,
    externalSource: { postMessage() {} },
    externalPendingEvents: [],
    externalRoomReady: true,
    externalRequestReceived: true,
    lease: { isActive: () => true, touch() {} },
    consent: { body: { payload: { capabilities: ["presence.read"] } } },
    transfers: null,
  };
  const sandbox = runFragment(
    [extractFunction(source, "startRoom"), extractFunction(source, "bindView")].join(
      "\n",
    ),
    {
      document: doc,
      $: (selector) => doc.querySelector(selector),
      location: { origin: "https://wallet.example" },
      roomGeneration: 0,
      state,
      P2PRoom: FakeRoom,
      NostrWebRTC: FakeRtc,
      CollaborationTransfers: FakeTransfers,
      externalConnectMode: true,
      externalHost: state.externalSource,
      externalSessionActive: () =>
        state.externalStatus === "sent" && state.lease.isActive(),
      grantOpen: () => true,
      setConnectionLabel() {},
      connectionStatusLabel: () => "Connected",
      debug() {},
      toast() {},
      readActivity: async () => [],
      render() {},
      rootViewButtons() {},
      touchGrant() {},
      handleExternalSiteEvent: async () => {},
      setTimeout,
      clearTimeout,
      Date,
    },
  );

  // Establish the approved external session's first room, then fire two rapid
  // toggles so a missing re-entry guard is visible as two rebuilds.
  await sandbox.startRoom();
  sandbox.bindView();
  const button = doc.querySelector("#toggle-private");
  const onClick = [...button._listeners.get("click")][0];
  await Promise.all([onClick({}), onClick({})]);

  const original = rooms[0];
  assert.equal(original.closed, true, "the previous room is closed, not orphaned");
  assert.equal(
    original.heartbeatRunning,
    false,
    "the previous room's heartbeat interval is stopped",
  );
  assert.equal(rooms.length, 2, "iframe mode rebuilds exactly one replacement room");
  assert.equal(
    state.room,
    rooms.at(-1),
    "the session ends up with the rebuilt room",
  );
  assert.equal(state.rtc, rtcs.at(-1), "the transport is rebuilt with the room");
  assert.equal(button.disabled, false, "the toggle is re-enabled after it settles");
  assert.equal(
    events.filter((event) => event.endsWith(":closed-twice")).length,
    0,
    "no room is closed twice",
  );
  assert.ok(
    events.indexOf("session-1:closed") < events.indexOf("session-2:created"),
    "the old room closes before its replacement is created",
  );
});
