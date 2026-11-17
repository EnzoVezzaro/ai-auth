import assert from "node:assert/strict";
import test from "node:test";
import { mountCollaborationWheel } from "../packages/p2p/collaboration-wheel.js";
import { createStubDom } from "./dom-stub.mjs";

globalThis.Option ??= class {
  constructor(text, value) {
    this.textContent = text;
    this.value = value;
  }
};

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function mount(initial, { media, url } = {}) {
  const { doc, win } = createStubDom();
  const listeners = new Set();
  const network = {
    connectionState: initial,
    onConnectionState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const track = {
    addEventListener() {},
    stop() {},
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
  win.navigator.mediaDevices = { getDisplayMedia: async () => stream };
  if (media) Object.assign(win, media);
  if (url) win.URL = url;
  const originalCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const node = originalCreate(tag);
    if (tag === "video")
      Object.assign(node, {
        videoWidth: 640,
        videoHeight: 360,
        play: async () => {},
      });
    if (tag === "canvas")
      Object.assign(node, {
        getContext: () => ({ drawImage() {} }),
        toBlob: (cb) => cb({ size: 1024, type: "image/jpeg" }),
      });
    return node;
  };
  const connection = {
    subscribe: () => () => {},
    sendText: async () => {},
    sendElement: async () => {},
    sendAttachment: async () => {},
  };
  const dispose = mountCollaborationWheel(connection, {
    target: doc.body,
    network,
  });
  const host = doc.body.children.find(
    (node) => node.dataset.aiAuthCollaborationWheel === "true",
  );
  const shadow = host.shadowRoot;
  shadow.querySelector(".toggle").dispatch("click");
  return {
    shadow,
    fire(snapshot) {
      network.connectionState = snapshot;
      for (const listener of listeners) listener(snapshot);
    },
    dispose,
  };
}

const REVOKED = { status: "revoked", directPeerCount: 0, peers: [] };

test("a revoked session stops a live recording instead of leaking the screen", async () => {
  let stopped = 0;
  class Recorder {
    static last;
    constructor() {
      this.state = "inactive";
      this.mimeType = "video/webm";
      Recorder.last = this;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      if (this.state !== "recording") return;
      this.state = "inactive";
      this.ondataavailable?.({ data: { size: 0 } });
      this.onstop?.();
    }
  }
  const track = {
    addEventListener() {},
    stop() {
      stopped += 1;
    },
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
  const wheel = mount(
    {
      status: "direct-peer-connected",
      directPeerCount: 1,
      peers: [{ peerId: "p" }],
    },
    {
      media: {
        navigator: {
          mediaDevices: { getDisplayMedia: async () => stream },
        },
        MediaRecorder: Recorder,
      },
    },
  );
  try {
    wheel.shadow.querySelector('[data-action="record"]').dispatch("click");
    await waitFor(
      () => Recorder.last?.state === "recording",
      "recording to start",
    );
    wheel.fire(REVOKED);
    await waitFor(() => stopped > 0, "the screen track to stop");
    assert.equal(
      wheel.shadow.querySelector('[data-action="cancel-record"]').hidden,
      true,
      "recording UI is reset on revocation",
    );
  } finally {
    wheel.dispose();
  }
});

test("a revoked session discards staged sensitive media", async () => {
  let revoked = 0;
  const wheel = mount(
    {
      status: "direct-peer-connected",
      directPeerCount: 1,
      peers: [{ peerId: "p" }],
    },
    {
      url: {
        createObjectURL: () => "blob:preview",
        revokeObjectURL: () => {
          revoked += 1;
        },
      },
    },
  );
  try {
    wheel.shadow.querySelector('[data-action="screenshot"]').dispatch("click");
    await waitFor(
      () => wheel.shadow.querySelector(".preview").hidden === false,
      "staged screenshot",
    );
    wheel.fire(REVOKED);
    assert.equal(wheel.shadow.querySelector(".preview").hidden, true);
    assert.equal(
      revoked,
      1,
      "the staged capture and its object URL are released on revocation",
    );
  } finally {
    wheel.dispose();
  }
});
