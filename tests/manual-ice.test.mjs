import assert from "node:assert/strict";
import test from "node:test";
import { ManualWebRTC } from "../packages/p2p/index.js";

function fakePeer(initialState = "gathering") {
  const listeners = new Set();
  return {
    iceGatheringState: initialState,
    localDescription: { type: "offer", sdp: "v=0\r\n" },
    addEventListener(type, fn) {
      assert.equal(type, "icegatheringstatechange");
      listeners.add(fn);
    },
    removeEventListener(type, fn) {
      assert.equal(type, "icegatheringstatechange");
      listeners.delete(fn);
    },
    complete() {
      this.iceGatheringState = "complete";
      for (const fn of [...listeners]) fn();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function manualFor(peer) {
  // waitForIce only needs `peer`; bypass the constructor's RTCPeerConnection.
  const manual = Object.create(ManualWebRTC.prototype);
  manual.peer = peer;
  return manual;
}

test("waitForIce drops its icegatheringstatechange listener once ICE completes", async () => {
  const peer = fakePeer();
  const pending = manualFor(peer).waitForIce(1000);
  assert.equal(peer.listenerCount, 1, "a listener is attached while waiting");
  peer.complete();
  assert.match(await pending, /offer/u);
  assert.equal(peer.listenerCount, 0, "the listener is removed on resolve");
});

test("waitForIce drops its listener when gathering times out", async () => {
  const peer = fakePeer();
  await assert.rejects(manualFor(peer).waitForIce(25), /timed out/u);
  assert.equal(peer.listenerCount, 0, "the listener is removed on timeout");
});
