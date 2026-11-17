// Cursor wire-format consistency across the published docs, the SDK and the
// bundled Body4AI example site. The example's adapter and presence renderer are
// extracted from their real source and run against the real payload builder.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  buildCursorPayload,
  MAX_COORDINATE,
} from "../packages/p2p/presence.js";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

function closingBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("Unbalanced braces in extracted declaration");
}

function extract(source, needle) {
  const at = source.indexOf(needle);
  if (at === -1) throw new Error(`no declaration matching ${needle}`);
  const open = needle.endsWith("{")
    ? at + needle.length - 1
    : source.indexOf("{", at);
  return source.slice(at, closingBrace(source, open) + 1);
}

function fakeDocument() {
  const node = () => ({
    dataset: {},
    style: {},
    children: [],
    textContent: "",
    append(...kids) {
      this.children.push(...kids);
    },
  });
  return {
    createElement: node,
    documentElement: { scrollWidth: 1000, scrollHeight: 2000 },
  };
}

async function publishFromExampleSite(x, y) {
  const source = await read("examples/body4ai/site/site.js");
  const declaration = extract(source, "publishCursor({ x, y }) {");
  const sent = [];
  const state = {
    room: {
      send: async (type, payload) => {
        sent.push({ type, payload });
      },
    },
    wallet: { name: "Human" },
  };
  const sandbox = vm.createContext({
    state,
    buildCursorPayload,
    MAX_COORDINATE,
    document: fakeDocument(),
    location: { pathname: "/demo" },
  });
  vm.runInContext(
    `let cursorSeq = 0; globalThis.adapter = { ${declaration} };`,
    sandbox,
  );
  await sandbox.adapter.publishCursor({ x, y });
  return sent[0];
}

async function examplePresenceItem(cursor) {
  const source = await read("examples/body4ai/site/cursors.js");
  const declaration = extract(source, "function presenceItem(");
  const helpers = source.slice(
    source.indexOf("const SWEEP_MS"),
    source.indexOf("function presenceItem("),
  );
  const sandbox = vm.createContext({
    document: fakeDocument(),
    MAX_COORDINATE,
  });
  vm.runInContext(
    `${helpers}\n${declaration}; globalThis.render = presenceItem;`,
    sandbox,
  );
  return sandbox.render({
    walletId: "agent:peer0123456789abcdef",
    session: "demo-session",
    state: "online",
    label: "Agent",
    cursor,
  });
}

test("DTC-13: PROTOCOL.md describes cursor coordinates as normalized fractions", async () => {
  const protocol = await read("docs/PROTOCOL.md");
  const row = protocol.split("\n").find((line) => line.includes("| `x`, `y`"));
  assert.ok(row, "the cursor coordinate row is missing");
  assert.match(row, /0\.\.1 fraction/u);
  assert.match(row, /MAX_COORDINATE/u);
  assert.doesNotMatch(row, /CSS pixels/u);
});

test("the example site publishes canonical MAX_COORDINATE-scaled fractions", async () => {
  const sent = await publishFromExampleSite(330, 430);
  assert.equal(sent.type, "presence/cursor");
  assert.equal(sent.payload.pageKey, "/demo");
  assert.equal(
    sent.payload.x,
    Math.round((330 / 1000) * MAX_COORDINATE),
    "raw pixel x must be normalized to the document width before scaling",
  );
  assert.equal(
    sent.payload.y,
    Math.round((430 / 2000) * MAX_COORDINATE),
    "raw pixel y must be normalized to the document height before scaling",
  );
});

test("the example presence list renders canonical cursor fractions as pixels", async () => {
  const item = await examplePresenceItem({
    x: Math.round((330 / 1000) * MAX_COORDINATE),
    y: Math.round((430 / 2000) * MAX_COORDINATE),
    pageKey: "/demo",
  });
  assert.equal(item.dataset.x, "330");
  assert.equal(item.dataset.y, "430");
});
