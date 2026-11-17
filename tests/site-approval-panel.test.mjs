import assert from "node:assert/strict";
import test from "node:test";

// Wait on a condition with a bound instead of a fixed tick count.
async function bounded(promise, description, ms = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stubDocument() {
  const created = [];
  const document = {
    createElement(tag) {
      const node = {
        tag,
        dataset: {},
        className: "",
        id: "",
        textContent: "",
        attrs: {},
        listeners: {},
        setAttribute(name, value) {
          this.attrs[name] = value;
        },
        append(...children) {
          (this.children ??= []).push(...children);
        },
        addEventListener(type, fn) {
          (this.listeners[type] ??= []).push(fn);
        },
        remove() {
          this.removed = true;
        },
      };
      created.push(node);
      return node;
    },
  };
  return { document, created };
}

async function loadSiteTools() {
  const { document, created } = stubDocument();
  globalThis.document = document;
  const { askHuman, makeAuthorize } = await import(
    "../examples/body4ai/site/tools.js"
  );
  return { askHuman, makeAuthorize, created };
}

test("CT-05: cancelling a pending approval removes the site's panel", async () => {
  const { askHuman, created } = await loadSiteTools();
  const controller = new AbortController();
  const target = {
    append(node) {
      this.child = node;
    },
  };
  const decision = bounded(
    askHuman({ target, action: { name: "wishlist.add" }, signal: controller.signal }),
    "approval decision after abort",
  );
  const panel = target.child;
  assert.ok(panel, "the Allow / Don't-allow panel is shown");
  assert.equal(created.filter((node) => node.id === "approve-action").length, 1);
  controller.abort();
  assert.equal(await decision, false, "abort denies the pending request");
  assert.equal(panel.removed, true, "the stale panel is removed from the page");
});

test("CT-05: a timed-out human gate removes the panel through its signal", async () => {
  const { makeAuthorize } = await loadSiteTools();
  const logs = [];
  const target = {
    append(node) {
      this.child = node;
    },
  };
  const authorize = makeAuthorize({ target, log: (...args) => logs.push(args) });
  const controller = new AbortController();
  const decision = bounded(
    authorize(
      { name: "wishlist.add" },
      {},
      { signal: controller.signal, requester: { id: "agent:peer" } },
    ),
    "authorize after timeout",
  );
  const panel = target.child;
  assert.ok(panel, "the panel is shown while the human decides");
  // Model the SDK client timeout: it aborts the execution context.
  setTimeout(() => controller.abort(), 30);
  assert.equal(await decision, false, "the timed-out gate denies");
  assert.equal(panel.removed, true, "the expired panel is removed");
});
