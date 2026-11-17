import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { createAIAuthAgentClient, identityFor } from "../packages/p2p/index.js";
import { mountAIAuthCollaboration } from "../packages/p2p/embed.js";
import { MAX_COORDINATE, OFFLINE_AFTER_MS } from "../packages/p2p/presence.js";

globalThis.crypto ??= webcrypto;

const SVG_NS = "http://www.w3.org/2000/svg";

function makeNode(tag, doc, ns) {
  const node = {
    tagName: String(tag).toUpperCase(),
    namespaceURI: ns ?? null,
    ownerDocument: doc,
    style: {},
    attrs: new Map(),
    children: [],
    parentNode: null,
    _text: "",
    _listeners: new Map(),
    get className() {
      return this.attrs.get("class") ?? "";
    },
    set className(value) {
      this.attrs.set("class", String(value));
    },
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join("");
    },
    set textContent(value) {
      this._text = String(value ?? "");
      this.children = [];
    },
    setAttribute(name, value) {
      this.attrs.set(String(name), String(value));
    },
    getAttribute(name) {
      return this.attrs.get(name) ?? null;
    },
    append(...kids) {
      for (const kid of kids) {
        kid.parentNode = this;
        this.children.push(kid);
      }
    },
    replaceChildren(...kids) {
      this.children = [];
      this.append(...kids);
    },
    remove() {
      const siblings = this.parentNode?.children;
      const index = siblings?.indexOf(this) ?? -1;
      if (index !== -1) siblings.splice(index, 1);
      this.parentNode = null;
    },
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of [...(this._listeners.get(type) ?? [])])
        fn({ type, preventDefault() {}, ...event });
    },
    attachShadow() {
      this.shadowRoot = makeNode("shadowroot", doc);
      return this.shadowRoot;
    },
  };
  return node;
}

function makeDom({ width = 1000, height = 4000, viewHeight = 800 } = {}) {
  const doc = makeNode("document", null);
  doc.createElement = (tag) => makeNode(tag, doc);
  doc.createElementNS = (ns, tag) => makeNode(tag, doc, ns);
  doc.documentElement = makeNode("html", doc);
  Object.assign(doc.documentElement, {
    scrollWidth: width,
    scrollHeight: height,
    clientWidth: width,
    clientHeight: viewHeight,
  });
  doc.body = makeNode("body", doc);
  return { doc, target: doc.body };
}

function makeConnection() {
  let listener = null;
  const published = [];
  return {
    published,
    onEvent(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    publishCursor(cursor) {
      published.push(cursor);
    },
    emit(envelope) {
      listener?.({ body: envelope });
    },
  };
}

async function makeWallet(name = "Agent") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { id: await identityFor(publicKey), name };
}

// Real agent publisher: createAIAuthAgentClient.publishCursor -> room.send.
async function agentPayload(wallet, args) {
  const sent = [];
  const room = {
    wallet,
    session: "room-session",
    peers: new Map(),
    subscribe: () => () => {},
    async send(type, payload) {
      sent.push({ type, payload });
    },
  };
  const client = createAIAuthAgentClient(room);
  try {
    client.publishCursor(args);
  } finally {
    client.close();
  }
  return {
    type: sent[0].type,
    payload: { ...sent[0].payload, session: room.session },
  };
}

const cursorNodes = (conn, dom) => {
  const host = dom.target.children.at(-1);
  const layer = host.shadowRoot.children.at(-1);
  return layer.children.filter((n) =>
    n.className.split(/\s+/u).includes("cursor"),
  );
};

const envelope = (wallet, payload) => ({
  type: "presence/cursor",
  issuer: wallet.id,
  payload,
});

const waitUntil = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("condition not reached");
};

test("an agent-published v1 cursor appears on the example site overlay", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  const agent = await makeWallet("ChatGPT agent A");
  const published = await agentPayload(agent, { x: 0.5, y: 0.5 });
  assert.equal(published.type, "presence/cursor");
  conn.emit(envelope(agent, published.payload));
  const nodes = cursorNodes(conn, dom);
  assert.equal(nodes.length, 1, "the agent's cursor is drawn");
  assert.match(nodes[0].textContent, /ChatGPT agent A/u);
});

test("a cursor from another page is not drawn, but a site-wide cursor is", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/docs",
  });
  t.after(stop);
  const other = await makeWallet("Other page");
  conn.emit(
    envelope(other, {
      type: "ai-auth-cursor",
      v: 1,
      pageKey: "/product",
      x: 100000,
      y: 100000,
      seq: 1,
      visible: true,
      session: "room-session",
    }),
  );
  assert.equal(cursorNodes(conn, dom).length, 0, "other-page cursor is hidden");

  conn.emit(
    envelope(other, {
      type: "ai-auth-cursor",
      v: 1,
      pageKey: null,
      x: 100000,
      y: 100000,
      seq: 2,
      visible: true,
      session: "room-session",
    }),
  );
  assert.equal(cursorNodes(conn, dom).length, 1, "site-wide cursor is visible");
});

test("two identities get different colours derived from the verified issuer", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  const a = await makeWallet("A");
  const b = await makeWallet("B");
  for (const wallet of [a, b]) {
    const published = await agentPayload(wallet, { x: 0.2, y: 0.2 });
    conn.emit(envelope(wallet, published.payload));
  }
  const nodes = cursorNodes(conn, dom);
  assert.equal(nodes.length, 2);
  const fill = (node) => node.children[0].children[0].getAttribute("fill");
  assert.ok(fill(nodes[0]), "a colour is assigned");
  assert.notEqual(fill(nodes[0]), fill(nodes[1]), "different issuers differ");
});

test("a legacy normalized cursor still renders as a site-wide v1 cursor", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  const legacy = await makeWallet("Legacy");
  conn.emit(
    envelope(legacy, {
      x: 0.25,
      y: 0.5,
      visible: true,
      label: "Legacy visitor",
      session: "room-session",
    }),
  );
  const nodes = cursorNodes(conn, dom);
  assert.equal(nodes.length, 1, "legacy payload still renders");
  assert.match(nodes[0].textContent, /Legacy visitor/u);
});

test("cursors are document-anchored with the viewer's current scroll", async (t) => {
  const dom = makeDom({ width: 1000, height: 4000, viewHeight: 800 });
  const previousX = globalThis.scrollX;
  const previousY = globalThis.scrollY;
  globalThis.scrollX = 50;
  globalThis.scrollY = 1000;
  t.after(() => {
    globalThis.scrollX = previousX;
    globalThis.scrollY = previousY;
  });
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  const agent = await makeWallet("Scrolled");
  const published = await agentPayload(agent, { x: 0.25, y: 0.5 });
  conn.emit(envelope(agent, published.payload));
  const node = cursorNodes(conn, dom)[0];
  // x=250000 (25% of 1000px) minus 50px scroll; y=500000 (50% of 4000px) minus 1000px scroll.
  assert.equal(node.style.left, "200px");
  assert.equal(node.style.top, "1000px");
});

test("updates reuse the same node for a stable identity", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  const agent = await makeWallet("Moving");
  const first = await agentPayload(agent, { x: 0.1, y: 0.1 });
  conn.emit(envelope(agent, first.payload));
  const before = cursorNodes(conn, dom)[0];
  const second = await agentPayload(agent, { x: 0.8, y: 0.8 });
  conn.emit(envelope(agent, second.payload));
  const after = cursorNodes(conn, dom)[0];
  assert.equal(after, before, "the DOM node is reused, not recreated");
  assert.notEqual(after.style.left, `${100}px`);
});

test("a hidden participant fades but stays in the overlay", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  const agent = await makeWallet("Hiding");
  const shown = await agentPayload(agent, { x: 0.3, y: 0.3 });
  conn.emit(envelope(agent, shown.payload));
  const hidden = await agentPayload(agent, { x: 0.3, y: 0.3, visible: false });
  conn.emit(envelope(agent, hidden.payload));
  const node = cursorNodes(conn, dom)[0];
  assert.ok(node, "the node stays for the fade");
  assert.ok(Number(node.style.opacity) < 1, "the node is dimmed");
});

test("a pointer below the first viewport uses the document-size basis, not a clamped bottom", async (t) => {
  const dom = makeDom({ width: 1000, height: 4000, viewHeight: 800 });
  const previousX = globalThis.scrollX;
  const previousY = globalThis.scrollY;
  globalThis.scrollX = 50;
  globalThis.scrollY = 1000;
  t.after(() => {
    globalThis.scrollX = previousX;
    globalThis.scrollY = previousY;
  });
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);

  // client (500, 400) + scroll (50, 1000) = document point (550, 1400),
  // which is below the first 800 px viewport of a 4000 px document.
  dom.target.dispatch("pointermove", { clientX: 500, clientY: 400 });
  assert.equal(conn.published.length, 1);
  const sent = conn.published[0];
  assert.ok(
    sent.y > 0 && sent.y < 1,
    `document point below the first viewport must not clamp to the bottom (got ${sent.y})`,
  );
  assert.ok(Math.abs(sent.x - 0.55) < 1e-9, `x fraction was ${sent.x}`);
  assert.ok(Math.abs(sent.y - 0.35) < 1e-9, `y fraction was ${sent.y}`);

  // Round-trip: a peer rendering that same normalized cursor with the same
  // scroll must land back on the original client coordinates.
  const agent = await makeWallet("Tall page");
  conn.emit(
    envelope(agent, {
      type: "ai-auth-cursor",
      v: 1,
      pageKey: "/",
      x: Math.round(sent.x * MAX_COORDINATE),
      y: Math.round(sent.y * MAX_COORDINATE),
      seq: 1,
      visible: true,
      session: "tall-session",
    }),
  );
  const node = cursorNodes(conn, dom)[0];
  assert.equal(node.style.left, "500px");
  assert.equal(node.style.top, "400px");
});

test("two live sessions of one identity keep two stable cursors", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  const agent = await makeWallet("Two tabs");
  const sessionA = "session-AAAA1111";
  const sessionB = "session-BBBB2222";
  const cursorFor = (session, x, y, seq) => ({
    type: "ai-auth-cursor",
    v: 1,
    pageKey: "/",
    x,
    y,
    seq,
    visible: true,
    label: "Two tabs",
    session,
  });
  conn.emit(envelope(agent, cursorFor(sessionA, 200_000, 200_000, 1)));
  conn.emit(envelope(agent, cursorFor(sessionB, 800_000, 800_000, 2)));
  const nodes = cursorNodes(conn, dom);
  assert.equal(nodes.length, 2, "each tab is its own participant");
  const fill = (node) => node.children[0].children[0].getAttribute("fill");
  assert.equal(fill(nodes[0]), fill(nodes[1]), "one identity keeps one colour");
  assert.match(nodes[0].textContent, /Two tabs/u);
  assert.match(nodes[1].textContent, /Two tabs/u);

  // A fresh update for session A reuses its node; neither cursor flip-flops.
  conn.emit(envelope(agent, cursorFor(sessionA, 300_000, 300_000, 3)));
  const afterUpdate = cursorNodes(conn, dom);
  assert.equal(afterUpdate.length, 2);
  assert.equal(afterUpdate[0], nodes[0], "session A keeps its own node");
  assert.equal(afterUpdate[1], nodes[1], "session B keeps its own node");

  // A goodbye for one tab removes only that tab's cursor.
  conn.emit({
    type: "peer/goodbye",
    issuer: agent.id,
    payload: { session: sessionA },
  });
  const remaining = cursorNodes(conn, dom);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0], nodes[1], "the other session's cursor survives");
});

test("peer/goodbye removes that participant's cursor at once", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  const agent = await makeWallet("Leaving");
  const shown = await agentPayload(agent, { x: 0.3, y: 0.3 });
  conn.emit(envelope(agent, shown.payload));
  assert.equal(cursorNodes(conn, dom).length, 1, "cursor is shown");
  conn.emit({
    type: "peer/goodbye",
    issuer: agent.id,
    payload: { session: "room-session" },
  });
  assert.equal(
    cursorNodes(conn, dom).length,
    0,
    "the departing peer's cursor is removed immediately",
  );
});

test("an idle cursor is dimmed and then removed, not kept forever", async (t) => {
  const agent = await makeWallet("Idle");
  const dom = makeDom();
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  const shown = await agentPayload(agent, { x: 0.3, y: 0.3 });
  conn.emit(envelope(agent, shown.payload));
  const node = cursorNodes(conn, dom)[0];
  assert.ok(node, "cursor is shown");

  t.mock.timers.tick(OFFLINE_AFTER_MS + 2_000);
  assert.ok(Number(node.style.opacity) < 1, "the idle cursor is dimmed");
  assert.equal(cursorNodes(conn, dom).length, 1, "idle is not yet goodbye");

  t.mock.timers.tick(120_000);
  assert.equal(
    cursorNodes(conn, dom).length,
    0,
    "a long-idle cursor is removed, not kept until reload",
  );
});

test("the overlay's own human cursor is published page-scoped", (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/docs",
  });
  t.after(stop);
  dom.target.dispatch("pointermove", { clientX: 100, clientY: 200 });
  assert.equal(conn.published.length, 1);
  assert.equal(
    conn.published[0].page,
    "/docs",
    "the human cursor carries the viewer's page key",
  );
});

test("a throttled final pointer position is sent as a trailing update", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  dom.target.dispatch("pointermove", { clientX: 100, clientY: 200 });
  dom.target.dispatch("pointermove", { clientX: 900, clientY: 600 });
  assert.equal(
    conn.published.length,
    1,
    "the second move falls inside the throttle window",
  );
  await waitUntil(() => conn.published.length >= 2);
  const last = conn.published.at(-1);
  assert.ok(Math.abs(last.x - 0.9) < 1e-9, `final x fraction was ${last.x}`);
  assert.ok(Math.abs(last.y - 0.15) < 1e-9, `final y fraction was ${last.y}`);
});

test("scroll updates are captured on the document, not only the target", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, {
    target: dom.target,
    pageKey: "/",
  });
  t.after(stop);
  // A scroll with no real pointer position must not publish a cursor at 0,0.
  dom.doc.dispatch("scroll");
  assert.equal(
    conn.published.length,
    0,
    "a scroll before any pointer move is ignored",
  );
  dom.target.dispatch("pointermove", { clientX: 100, clientY: 200 });
  assert.equal(conn.published.length, 1, "the pointer position is published");
  const sentAt = Date.now();
  await waitUntil(() => Date.now() - sentAt >= 460);
  dom.doc.dispatch("scroll");
  assert.equal(
    conn.published.length,
    2,
    "a later document scroll is published with the known position",
  );
  assert.equal(conn.published[1].x, conn.published[0].x);
});
