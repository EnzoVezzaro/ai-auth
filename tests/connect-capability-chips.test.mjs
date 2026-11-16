import assert from "node:assert/strict";
import test from "node:test";
import { mountAIAuthConnectPanel } from "../packages/p2p/agent-connect.js";
import { capabilityCopy } from "../packages/p2p/copy.js";
import { createStubDom } from "./dom-stub.mjs";

const CAPABILITIES = ["presence.read", "content.share", "site.custom.read"];

function findByText(nodes, text) {
  return nodes.find((node) => node.textContent === text);
}

// Mount the real panel, drive its controller to "connected" through the
// button, and read the chips back out of the closed-shadow DOM double.
async function connectedChips(capabilities) {
  const { doc } = createStubDom();
  const connection = {
    onLifecycle(listener) {
      listener({
        type: "connected",
        label: "Research agent",
        identity: { id: "agent:test1234", name: "Research agent" },
        capabilities,
        expiresAt: Date.now() + 60_000,
      });
      return () => {};
    },
    close() {},
    renew() {},
  };
  const dispose = mountAIAuthConnectPanel({
    instruction: "connect to the test room",
    target: doc.body,
    reloaded: false,
    connect: async () => connection,
  });
  try {
    const host = doc.body.children.find(
      (node) => node.dataset.aiAuthConnectPanel !== undefined,
    );
    const shadow = host.shadowRoot;
    const actions = shadow.querySelector(".actions");
    findByText(actions.children, "Connect agent").dispatch("click");
    // The click handler awaits connect() before the lifecycle event renders.
    await new Promise((resolve) => setImmediate(resolve));
    return shadow.querySelector(".chips").children;
  } finally {
    dispose();
  }
}

test("renderChips shows plain capabilityCopy titles with raw ids in the title", async () => {
  const chips = await connectedChips(CAPABILITIES);
  assert.deepEqual(
    chips.map((chip) => chip.textContent),
    CAPABILITIES.map((id) => capabilityCopy(id).title),
  );
  assert.deepEqual(
    chips.map((chip) => chip.getAttribute("title")),
    CAPABILITIES,
    "the raw capability id stays available for debugging",
  );
});
