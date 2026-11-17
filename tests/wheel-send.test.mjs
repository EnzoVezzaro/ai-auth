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
  for (let i = 0; i < 8; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

function mount(overrides = {}) {
  const { doc } = createStubDom();
  const calls = [];
  const connection = {
    subscribe: () => () => {},
    sendText() {},
    sendElement() {},
    sendAttachment() {},
    ...overrides,
    // wrap after overrides so every send is recorded
  };
  for (const name of ["sendText", "sendElement", "sendAttachment"]) {
    const original = connection[name].bind(connection);
    connection[name] = (...args) => {
      calls.push([name, ...args]);
      return original(...args);
    };
  }
  const dispose = mountCollaborationWheel(connection, { target: doc.body });
  const host = doc.body.children.find(
    (node) => node.dataset.aiAuthCollaborationWheel === "true",
  );
  const shadow = host.shadowRoot;
  shadow.querySelector(".toggle").dispatch("click");
  return { shadow, calls, dispose };
}

const submit = (shadow) => {
  shadow.querySelector("form").dispatch("submit");
};

test("a second submit while a text send is in flight sends no duplicate", async () => {
  const gates = [];
  const wheel = mount({
    sendText() {
      return new Promise((resolve) => gates.push(resolve));
    },
  });
  try {
    const input = wheel.shadow.querySelector("input");
    input.value = "one message";
    submit(wheel.shadow); // first send is now awaiting the transport
    assert.equal(input.value, "", "the staged text is cleared synchronously");
    input.value = "one message"; // a fast double-click/Enter keeps the same text
    submit(wheel.shadow);
    assert.equal(
      wheel.calls.length,
      1,
      "two submits must not queue two messages with the same text",
    );
    gates[0]();
    await flush();
    assert.equal(wheel.calls.length, 1);
  } finally {
    wheel.dispose();
  }
});

test("a later submit after the first send completes is allowed", async () => {
  const wheel = mount({
    sendText: async () => {},
  });
  try {
    const input = wheel.shadow.querySelector("input");
    input.value = "first";
    submit(wheel.shadow);
    await flush();
    input.value = "second";
    submit(wheel.shadow);
    await flush();
    assert.equal(wheel.calls.length, 2);
    assert.deepEqual(
      wheel.calls.map((call) => call[1]),
      ["first", "second"],
    );
  } finally {
    wheel.dispose();
  }
});
