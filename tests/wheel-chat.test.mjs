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

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

function mount(sendText) {
  const { doc } = createStubDom();
  const connection = {
    supportsTargets: true,
    subscribe: () => () => {},
    sendText,
    sendElement() {},
    sendAttachment() {},
  };
  const dispose = mountCollaborationWheel(connection, {
    target: doc.body,
    network: {
      connectionState: {
        status: "direct-peer-connected",
        directPeerCount: 1,
        peers: [],
      },
    },
  });
  const host = doc.body.children.find(
    (node) => node.dataset.aiAuthCollaborationWheel === "true",
  );
  return { shadow: host.shadowRoot, dispose };
}

test("a double submit sends a chat message only once", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const sent = [];
  const { shadow, dispose } = mount(async (text, options) => {
    sent.push({ text, options });
    await gate;
  });
  try {
    const input = shadow.querySelector("input");
    const form = shadow.querySelector("form");
    input.value = "send once";
    form.dispatch("submit");
    form.dispatch("submit");
    assert.equal(input.value, "", "the draft is cleared synchronously");
    assert.equal(sent.length, 1, "the in-flight lock prevents a second send");
    release();
    await until(() =>
      shadow
        .querySelector(".status")
        .textContent.includes("Waiting for a signed receipt"),
    );
    assert.equal(sent.length, 1);
  } finally {
    release?.();
    dispose();
  }
});
