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

function mount({ recorder }) {
  const { doc, win } = createStubDom();
  win.navigator.mediaDevices = { getDisplayMedia() {} };
  if (recorder) win.MediaRecorder = class {};
  const connection = {
    subscribe: () => () => {},
    sendText() {},
    sendElement() {},
    sendAttachment() {},
  };
  const dispose = mountCollaborationWheel(connection, {
    target: doc.body,
    capabilities: ["messages.send", "content.share"],
  });
  const host = doc.body.children.find(
    (node) => node.dataset.aiAuthCollaborationWheel === "true",
  );
  const shadow = host.shadowRoot;
  shadow.querySelector(".toggle").dispatch("click");
  return { shadow, dispose };
}

test("a browser without MediaRecorder explains why Record screen is disabled", () => {
  const { shadow, dispose } = mount({ recorder: false });
  try {
    const button = shadow.querySelector('[data-action="record"]');
    assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.match(button.title, /cannot record the screen/u);
    assert.match(
      shadow.querySelector(".hint").textContent,
      /cannot record the screen/u,
      "the visible hint must carry the same reason as the tooltip",
    );
  } finally {
    dispose();
  }
});

test("with a recorder available no media reason is shown", () => {
  const { shadow, dispose } = mount({ recorder: true });
  try {
    assert.equal(shadow.querySelector(".hint").textContent, "");
  } finally {
    dispose();
  }
});
