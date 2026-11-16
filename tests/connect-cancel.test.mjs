import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { connectAIAuthModal } from "../packages/p2p/embed.js";
import { createAIAuthConnectController } from "../packages/p2p/agent-connect.js";
import {
  CANCELLED_MESSAGE,
  approvalTimeoutMessage,
} from "../packages/p2p/copy.js";

globalThis.crypto ??= webcrypto;

const ORIGIN = "https://site.example";
const WALLET_ORIGIN = "https://wallet.example";

// A fake browser whose nodes keep their listeners and record focus moves, so
// the tests can check closing paths and focus return without a real DOM.
function fakeDom() {
  const popup = { postMessage() {} };
  const windowListeners = new Set();
  const dialogs = [];
  const document = { body: null, activeElement: null };
  const createNode = (tag) => {
    const listeners = new Map();
    const node = {
      tag,
      style: {},
      open: false,
      connected: true,
      focusCount: 0,
      setAttribute() {},
      append() {},
      remove() {
        this.connected = false;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      dispatch(type, event = {}) {
        for (const fn of [...(listeners.get(type) ?? [])])
          fn({ preventDefault() {}, ...event });
      },
      showModal() {
        this.open = true;
      },
      close() {
        if (!this.open) return;
        this.open = false;
        this.dispatch("close");
      },
      focus() {
        this.focusCount += 1;
        document.activeElement = this;
      },
      ...(tag === "iframe" ? { contentWindow: popup } : {}),
    };
    if (tag === "dialog") dialogs.push(node);
    return node;
  };
  document.body = createNode("body");
  document.createElement = createNode;
  const win = {
    document,
    addEventListener: (type, fn) =>
      type === "message" && windowListeners.add(fn),
    removeEventListener: (type, fn) => windowListeners.delete(fn),
  };
  return { win, document, dialogs };
}

// The modal is created after an async permission request is built, so wait
// for it to appear before the test interacts with it.
async function startModal(dom, timeoutMs = 120_000) {
  const pending = connectAIAuthModal({
    walletUrl: `${WALLET_ORIGIN}/`,
    capabilities: ["presence.read"],
    origin: ORIGIN,
    windowObject: dom.win,
    timeoutMs,
  });
  pending.catch(() => {});
  while (dom.dialogs.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  return { pending, dialog: dom.dialogs.at(-1) };
}

test("pressing Escape cancels the pending request at once with a plain message", async () => {
  const dom = fakeDom();
  const { pending, dialog } = await startModal(dom);
  assert.equal(dialog.open, true, "the wallet window opens as a modal");
  dialog.dispatch("cancel");
  await assert.rejects(pending, (error) => error.message === CANCELLED_MESSAGE);
});

test("closing the wallet window by any other route also cancels the request", async () => {
  const dom = fakeDom();
  const { pending, dialog } = await startModal(dom);
  dialog.close();
  await assert.rejects(pending, (error) => error.message === CANCELLED_MESSAGE);
});

test("the approval timeout says the window closed, not that the wallet declined", async (t) => {
  const dom = fakeDom();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pending } = await startModal(dom, 120_000);
  t.mock.timers.tick(120_000);
  await assert.rejects(
    pending,
    (error) => error.message === approvalTimeoutMessage(120_000),
  );
  assert.equal(
    approvalTimeoutMessage(120_000),
    "The approval window closed after 2 minutes. Click Connect agent to try again.",
  );
});

test("closing the wallet window returns focus to the element that opened it", async () => {
  const dom = fakeDom();
  const trigger = dom.document.createElement("button");
  dom.document.activeElement = trigger;
  const { pending, dialog } = await startModal(dom);
  dialog.dispatch("cancel");
  await assert.rejects(pending);
  assert.equal(trigger.focusCount > 0, true);
  assert.equal(dom.document.activeElement, trigger);
});

test("the connect panel shows the cancelled message and returns to idle", async () => {
  let rejectConnect;
  const controller = createAIAuthConnectController({
    connect: () =>
      new Promise((_resolve, reject) => {
        rejectConnect = reject;
      }),
  });
  const started = controller.connect();
  assert.equal(controller.getState().status, "connecting");
  rejectConnect(new Error(CANCELLED_MESSAGE));
  await started;
  assert.deepEqual(controller.getState(), {
    status: "idle",
    error: CANCELLED_MESSAGE,
  });
});
