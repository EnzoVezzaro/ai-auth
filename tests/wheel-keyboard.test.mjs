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

function mount() {
  const { doc } = createStubDom();
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
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
  const shadow = host.shadowRoot;
  const panel = shadow.querySelector(".panel");
  const queryAll = panel.querySelectorAll.bind(panel);
  panel.querySelectorAll = (selector) => {
    if (selector.includes(":not([disabled])") && selector.includes(","))
      return queryAll("*").filter(
        (node) =>
          ["BUTTON", "INPUT", "SELECT", "A", "VIDEO"].includes(node.tagName) &&
          !node.attrs.has("disabled"),
      );
    return queryAll(selector);
  };
  panel.contains = (node) => panel === node || queryAll("*").includes(node);
  const keyEvent = (key) => {
    let prevented = false;
    return {
      event: {
        key,
        shiftKey: false,
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {},
      },
      wasPrevented: () => prevented,
    };
  };
  return { doc, shadow, keyEvent, dispose };
}

test("Tab can leave the panel while the element picker is active", () => {
  const { shadow, keyEvent, dispose } = mount();
  try {
    shadow.querySelector(".toggle").dispatch("click");
    shadow.querySelector('[data-action="element"]').dispatch("click");
    assert.equal(shadow.querySelector(".picker").hidden, false);
    const cancel = shadow.querySelector('[data-action="stop-picking"]');
    assert.equal(shadow.querySelector(".panel").contains(cancel), false);
    shadow.activeElement = cancel;

    const tab = keyEvent("Tab");
    shadow.querySelector(".root").dispatch("keydown", tab.event);
    assert.equal(
      tab.wasPrevented(),
      false,
      "Tab must move focus to the page so a keyboard user can pick an element",
    );
  } finally {
    dispose();
  }
});
