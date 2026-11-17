import assert from "node:assert/strict";
import test from "node:test";
import {
  createMediaCapture,
  MEDIA_LIMITS,
} from "../packages/p2p/wheel-capture.js";
import { createStubDom } from "./dom-stub.mjs";

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

class FakeBlob {
  constructor(chunks, options = {}) {
    this.size = chunks.reduce((total, chunk) => total + chunk.size, 0);
    this.type = options.type;
  }
}

class FakeRecorder {
  static last;
  constructor(stream) {
    this.stream = stream;
    this.state = "inactive";
    this.mimeType = "video/webm";
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: { size: 0 } });
    this.onstop?.();
  }
}

function harness() {
  const { doc, win } = createStubDom();
  const track = { addEventListener() {} };
  const stream = {
    getTracks: () => [{ stop() {} }],
    getVideoTracks: () => [track],
  };
  win.navigator.mediaDevices = { getDisplayMedia: async () => stream };
  win.MediaRecorder = FakeRecorder;
  win.Blob = FakeBlob;
  FakeRecorder.last = undefined;
  return { capture: createMediaCapture(win, doc) };
}

test("auto-stop at the size cap yields a usable recording under the limit", async () => {
  const { capture } = harness();
  const done = capture.record();
  await waitFor(
    () => FakeRecorder.last?.state === "recording",
    "recording to start",
  );
  const recorder = FakeRecorder.last;
  const chunk = Math.ceil(MEDIA_LIMITS.recordingBytes * 0.6);
  recorder.ondataavailable({ data: { size: chunk } });
  recorder.ondataavailable({ data: { size: chunk } });
  assert.equal(recorder.state, "inactive", "the over-limit chunk stops capture");
  const blob = await done;
  assert.ok(blob, "auto-stop still produces a blob");
  assert.equal(
    blob.size,
    chunk,
    "the over-limit chunk is not appended to the recording",
  );
  assert.ok(blob.size <= MEDIA_LIMITS.recordingBytes);
});
