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

function mount(expiresAt) {
  const { doc } = createStubDom();
  const listeners = new Set();
  const network = {
    onConnectionState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const connection = {
    subscribe: () => () => {},
    sendText() {},
    sendElement() {},
    sendAttachment() {},
  };
  const dispose = mountCollaborationWheel(connection, {
    target: doc.body,
    network,
    expiresAt,
  });
  const host = doc.body.children.find(
    (node) => node.dataset.aiAuthCollaborationWheel === "true",
  );
  const shadow = host.shadowRoot;
  shadow.querySelector(".toggle").dispatch("click");
  return {
    shadow,
    refresh: () => {
      for (const listener of listeners) listener(undefined);
    },
    dispose,
  };
}

test("a live expiry source follows session renewal instead of freezing at mount", () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  let expiry = now + 1000;
  const wheel = mount(() => expiry);
  try {
    assert.equal(wheel.shadow.querySelector("input").disabled, false);
    now += 2000;
    wheel.refresh();
    assert.equal(
      wheel.shadow.querySelector("input").disabled,
      true,
      "the wheel expires at the original deadline",
    );
    assert.match(wheel.shadow.querySelector(".hint").textContent, /expired/u);

    expiry = now + 100_000; // renewal moves the deadline forward
    wheel.refresh();
    assert.equal(
      wheel.shadow.querySelector("input").disabled,
      false,
      "renewal lifts the block without re-mounting the wheel",
    );
    assert.doesNotMatch(wheel.shadow.querySelector(".hint").textContent, /expired/u);
  } finally {
    wheel.dispose();
    Date.now = realNow;
  }
});

test("a numeric expiry still expires", () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const wheel = mount(now + 1000);
  try {
    now += 2000;
    wheel.refresh();
    assert.match(wheel.shadow.querySelector(".hint").textContent, /expired/u);
  } finally {
    wheel.dispose();
    Date.now = realNow;
  }
});
