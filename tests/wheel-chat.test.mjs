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

test("the chat log keeps arrival order across incoming and outgoing messages", async () => {
  const { doc } = createStubDom();
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  let emit;
  const connection = {
    supportsTargets: true,
    subscribe(fn) {
      emit = fn;
      return () => {};
    },
    sendText: async () => {},
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
  const shadow = host.shadowRoot;
  try {
    // `whoIs` verifies an async key before rendering, so the incoming line
    // would otherwise land after a synchronously rendered outgoing line.
    emit({
      type: "text",
      text: "incoming first",
      envelope: {
        body: { type: "collab/text", issuer: "agent:peer", payload: {} },
        proof: { publicKey },
      },
    });
    shadow.querySelector("input").value = "outgoing second";
    shadow.querySelector("form").dispatch("submit");
    const text = () => shadow.querySelector(".log").textContent;
    await until(
      () =>
        text().includes("incoming first") && text().includes("outgoing second"),
    );
    const lines = [...shadow.querySelectorAll(".log .entry")].map(
      (node) => node.textContent,
    );
    assert.match(lines[0], /incoming first/u);
    assert.match(lines[1], /outgoing second/u);
  } finally {
    dispose();
  }
});

test("confirming a recording returns focus to the record button", async () => {
  const { doc, win } = createStubDom();
  win.navigator.mediaDevices = {
    getDisplayMedia: async () => ({
      getTracks: () => [{ stop() {} }],
      getVideoTracks: () => [{ addEventListener() {} }],
    }),
  };
  win.URL = {
    createObjectURL: () => "blob:recording",
    revokeObjectURL() {},
  };
  win.Blob = Blob;
  win.MediaRecorder = class {
    constructor() {
      this.state = "recording";
      this.mimeType = "video/webm";
    }
    start() {}
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
    addEventListener() {}
  };
  const connection = {
    supportsTargets: true,
    subscribe: () => () => {},
    sendText() {},
    sendElement() {},
    sendAttachment: async () => ({ body: {} }),
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
  const shadow = host.shadowRoot;
  try {
    const record = shadow.querySelector('[data-action="record"]');
    record.dispatch("click");
    await until(() => record.textContent === "Stop recording");
    record.dispatch("click");
    await until(() => !shadow.querySelector(".preview").hidden);
    shadow.querySelector('[data-action="confirm"]').dispatch("click");
    await until(() => doc.activeElement === record);
    assert.equal(
      doc.activeElement,
      record,
      "focus follows the recording just confirmed",
    );
    assert.notEqual(
      doc.activeElement,
      shadow.querySelector('[data-action="screenshot"]'),
    );
  } finally {
    dispose();
  }
});

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
