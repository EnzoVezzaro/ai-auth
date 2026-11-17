import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  createAIAuthAgentClient,
  identityFor,
} from "../packages/p2p/index.js";
import { mountAIAuthCollaboration } from "../packages/p2p/embed.js";

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
  return { type: sent[0].type, payload: { ...sent[0].payload, session: room.session } };
}

const cursorNodes = (conn, dom) => {
  const host = dom.target.children.at(-1);
  const layer = host.shadowRoot.children.at(-1);
  return layer.children.filter((n) => n.className.split(/\s+/u).includes("cursor"));
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
  const stop = mountAIAuthCollaboration(conn, { target: dom.target, pageKey: "/" });
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
  const stop = mountAIAuthCollaboration(conn, { target: dom.target, pageKey: "/docs" });
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
  const stop = mountAIAuthCollaboration(conn, { target: dom.target, pageKey: "/" });
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
  const stop = mountAIAuthCollaboration(conn, { target: dom.target, pageKey: "/" });
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
  const stop = mountAIAuthCollaboration(conn, { target: dom.target, pageKey: "/" });
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
  const stop = mountAIAuthCollaboration(conn, { target: dom.target, pageKey: "/" });
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
  const stop = mountAIAuthCollaboration(conn, { target: dom.target, pageKey: "/" });
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

test("scroll updates are captured on the document, not only the target", async (t) => {
  const dom = makeDom();
  const conn = makeConnection();
  const stop = mountAIAuthCollaboration(conn, { target: dom.target, pageKey: "/" });
  t.after(stop);
  dom.doc.dispatch("scroll");
  await waitUntil(() => conn.published.length >= 1);
  assert.equal(conn.published.length, 1, "the scroll fraction is published");
});
