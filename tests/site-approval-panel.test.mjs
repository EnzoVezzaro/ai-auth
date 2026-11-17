import assert from "node:assert/strict";
import test from "node:test";

// Wait on a condition with a bound instead of a fixed tick count.
async function bounded(promise, description, ms = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${description}`)),
          ms,
        );
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
        removeEventListener(type, fn) {
          this.listeners[type] = (this.listeners[type] ?? []).filter(
            (listener) => listener !== fn,
          );
        },
        focus() {
          this.focused = true;
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
  const stub = stubDocument();
  globalThis.document = stub.document;
  const { askHuman, makeAuthorize } =
    await import("../examples/body4ai/site/tools.js");
  return { askHuman, makeAuthorize, ...stub };
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
    askHuman({
      target,
      action: { name: "wishlist.add" },
      signal: controller.signal,
    }),
    "approval decision after abort",
  );
  const panel = target.child;
  assert.ok(panel, "the Allow / Don't-allow panel is shown");
  assert.equal(
    created.filter((node) => node.id?.endsWith("-allow")).length,
    1,
    "the approval button has a unique id",
  );
  controller.abort();
  assert.equal(await decision, false, "abort denies the pending request");
  assert.equal(panel.removed, true, "the stale panel is removed from the page");
});

test("CT-10: approval panels are labelled, focused, uniquely id'd and Escape-dismissible", async () => {
  const { askHuman, created } = await loadSiteTools();
  const targetA = {
    append(node) {
      this.child = node;
    },
  };
  const targetB = {
    append(node) {
      this.child = node;
    },
  };
  const first = bounded(
    askHuman({
      target: targetA,
      action: { name: "wishlist.add" },
      signal: new AbortController().signal,
    }),
    "first approval",
  );
  void bounded(
    askHuman({
      target: targetB,
      action: { name: "wishlist.add" },
      signal: new AbortController().signal,
    }),
    "second approval",
  ).catch(() => {});
  const [panelA, textA, approveA, , panelB, , approveB] = created;
  assert.notEqual(
    approveA.id,
    approveB.id,
    "concurrent panels do not share ids",
  );
  assert.equal(panelA.attrs["aria-labelledby"], textA.id);
  assert.equal(approveA.focused, true, "focus moves into the dialog");
  panelA.listeners.keydown[0]({ key: "Escape" });
  assert.equal(await first, false, "Escape denies the pending request");
  assert.equal(panelA.removed, true);
  assert.notEqual(panelB.removed, true, "the other request is untouched");
});

test("CT-12: a local WebMCP call with no requester is not denied", async () => {
  const { makeAuthorize } = await loadSiteTools();
  const target = {
    append(node) {
      this.child = node;
    },
  };
  const authorize = makeAuthorize({ target, log: () => {} });
  const local = await authorize(
    { name: "catalog.search", readOnly: true },
    {},
    { signal: new AbortController().signal },
  );
  assert.equal(local, true, "read-only local tools need no remote gate");

  const target2 = {
    append(node) {
      this.child = node;
    },
  };
  const gate = makeAuthorize({ target: target2, log: () => {} });
  const decision = bounded(
    gate(
      { name: "wishlist.add" },
      {},
      { signal: new AbortController().signal },
    ),
    "local approval",
  );
  assert.ok(
    target2.child,
    "a local side-effecting tool shows an on-page prompt",
  );
  assert.match(target2.child.children[0].textContent, /on this page/iu);
  target2.child.children[1].listeners.click[0]();
  assert.equal(await decision, true);
});

test("CT-05: a timed-out human gate removes the panel through its signal", async () => {
  const { makeAuthorize } = await loadSiteTools();
  const logs = [];
  const target = {
    append(node) {
      this.child = node;
    },
  };
  const authorize = makeAuthorize({
    target,
    log: (...args) => logs.push(args),
  });
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
