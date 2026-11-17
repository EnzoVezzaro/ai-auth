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

const TOUCH_REASON =
  "Picking an element needs a mouse or keyboard, so it is unavailable on touch screens.";
const MOUSE_INSTRUCTIONS =
  "Click an element, or Tab to one and press Enter. Escape cancels.";

function mount(coarsePointer) {
  const { doc } = createStubDom({ coarsePointer });
  const connection = {
    subscribe: () => () => {},
    sendText() {},
    sendElement() {},
    sendAttachment() {},
  };
  const dispose = mountCollaborationWheel(connection, { target: doc.body });
  const host = doc.body.children.find(
    (node) => node.dataset.aiAuthCollaborationWheel === "true",
  );
  return { shadow: host.shadowRoot, dispose };
}

test("a coarse pointer explains element sharing is unavailable and disables the action", () => {
  const { shadow, dispose } = mount(true);
  try {
    const action = shadow.querySelector('[data-action="element"]');
    assert.equal(action.getAttribute("aria-disabled"), "true");
    assert.equal(action.title, TOUCH_REASON);
    assert.equal(shadow.querySelector(".picker p").textContent, TOUCH_REASON);
  } finally {
    dispose();
  }
});

test("a fine pointer keeps the mouse and keyboard picker behaviour", () => {
  const { shadow, dispose } = mount(false);
  try {
    const action = shadow.querySelector('[data-action="element"]');
    assert.equal(action.getAttribute("aria-disabled"), "false");
    assert.equal(
      shadow.querySelector(".picker p").textContent,
      MOUSE_INSTRUCTIONS,
    );
  } finally {
    dispose();
  }
});
