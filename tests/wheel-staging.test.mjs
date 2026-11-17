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

const flush = async () => {
  for (let i = 0; i < 12; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function mount() {
  const { doc, win } = createStubDom();
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
  let revoked = 0;
  win.URL = {
    createObjectURL: () => "blob:preview",
    revokeObjectURL: () => {
      revoked += 1;
    },
  };
  win.navigator.mediaDevices = {
    getDisplayMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  };
  const calls = [];
  let failFirst = true;
  const connection = {
    subscribe: () => () => {},
    sendText: async () => {},
    sendElement: async () => {},
    sendAttachment: async (...args) => {
      calls.push(args);
      if (failFirst) {
        failFirst = false;
        throw new Error("The selected recipient is offline.");
      }
    },
  };
  const dispose = mountCollaborationWheel(connection, { target: doc.body });
  const host = doc.body.children.find(
    (node) => node.dataset.aiAuthCollaborationWheel === "true",
  );
  const shadow = host.shadowRoot;
  shadow.querySelector(".toggle").dispatch("click");
  return {
    shadow,
    calls,
    revoked: () => revoked,
    dispose,
  };
}

test("a failed send keeps the staged capture so it can be retried", async () => {
  const wheel = mount();
  try {
    wheel.shadow.querySelector('[data-action="screenshot"]').dispatch("click");
    await waitFor(
      () => wheel.shadow.querySelector(".preview").hidden === false,
      "staged screenshot preview",
    );
    assert.equal(wheel.shadow.querySelector(".preview-body img")?.src, "blob:preview");

    wheel.shadow.querySelector('[data-action="confirm"]').dispatch("click");
    await flush();
    assert.match(wheel.shadow.querySelector(".status").textContent, /offline/u);
    assert.equal(
      wheel.shadow.querySelector(".preview").hidden,
      false,
      "the failed send must not discard the staged capture",
    );
    assert.ok(
      wheel.shadow.querySelector(".preview-body img"),
      "the preview still shows the staged image",
    );
    assert.equal(wheel.revoked(), 0, "the preview URL stays alive for a retry");

    wheel.shadow.querySelector('[data-action="confirm"]').dispatch("click");
    await flush();
    assert.equal(wheel.calls.length, 2, "the user can retry the same capture");
    assert.equal(wheel.shadow.querySelector(".preview").hidden, true);
    assert.equal(wheel.revoked(), 1, "the URL is released only after success");
  } finally {
    wheel.dispose();
  }
});
