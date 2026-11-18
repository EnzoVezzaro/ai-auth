// AC3 scoped roster. The wallet app and the demo site both run with browser
// top-level side effects, so this test extracts the real render/snapshot source
// and runs it in a VM with controlled state. It proves that the scopes shown
// are exactly the locally verified grant subset and that a peer without a
// verified grant shows none.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  appSource,
  extractFunction,
  runFragment,
} from "./helpers/app-source.mjs";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/gu,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Small local extractor for the demo site's top-level functions. app-source's
// helper is pinned to app.js, which we must not edit.
function extractNamed(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`site.js has no function ${name}`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
  }
  throw new Error(`Unbalanced braces in ${name}`);
}

const grant = (
  recipient,
  capabilities,
  { verified = true, expiresAt } = {},
) => ({
  verified,
  body: {
    type: "capability/grant-issued",
    payload: {
      recipient,
      capabilities,
      expiresAt: expiresAt ?? Date.now() + 60_000,
    },
  },
});

async function walletRoster(state) {
  const source = await appSource();
  // peerRows .. connectPeerView holds peerRows, peerGrantedScopes and
  // verifiedActivity, so the extracted code is self-contained in the sandbox.
  const start = source.indexOf("function peerRows()");
  const end = source.indexOf("function connectPeerView()");
  assert.ok(start > -1 && end > start, "the roster functions are present");
  const sandbox = runFragment(source.slice(start, end), {
    state,
    esc,
    Date,
  });
  return sandbox.peerRows();
}

test("wallet roster shows exactly the verified scopes granted to each peer", async () => {
  const now = Date.now();
  const html = await walletRoster({
    room: {
      peers: new Map([
        ["p1", { id: "agent:peer-1", name: "Peer One", session: "s1" }],
        ["p2", { id: "agent:peer-2", name: "Peer Two", session: "s2" }],
      ]),
    },
    activity: [
      grant("agent:peer-1", ["presence.read", "messages.send"], {
        expiresAt: now + 1000,
      }),
      grant("agent:peer-1", ["content.share"], { expiresAt: now + 1000 }),
      // Requested but not granted: the entry is unverified and must not show.
      grant("agent:peer-1", ["admin.write"], { verified: false }),
      // Another peer's grant and an expired grant must not leak into peer two.
      grant("agent:peer-3", ["tools.invoke"], { expiresAt: now + 1000 }),
      grant("agent:peer-2", ["messages.send"], { expiresAt: 1 }),
    ],
  });

  const chips = html.split('<div class="peer-chip">').slice(1);
  const one = chips.find((chip) => chip.includes("agent:peer-1"));
  const two = chips.find((chip) => chip.includes("agent:peer-2"));
  assert.ok(one && two, "both verified peers are rendered");

  assert.match(
    one,
    /Granted scopes: presence\.read, messages\.send, content\.share/u,
  );
  assert.match(
    one,
    /data-scopes="presence\.read,messages\.send,content\.share"/u,
  );
  assert.doesNotMatch(one, /admin\.write|tools\.invoke/u);
  assert.match(two, /No scopes granted/u);
  assert.match(two, /data-scopes=""/u);
  assert.doesNotMatch(two, /messages\.send|tools\.invoke|admin\.write/u);
});

test("scopes already on the presence record win over derived grant data", async () => {
  const html = await walletRoster({
    room: {
      peers: new Map([
        [
          "p1",
          {
            id: "agent:peer-1",
            name: "Peer One",
            session: "s1",
            scopes: ["messages.send"],
          },
        ],
      ]),
    },
    activity: [grant("agent:peer-1", ["tools.invoke"])],
  });
  assert.match(html, /Granted scopes: messages\.send/u);
  assert.match(html, /data-scopes="messages\.send"/u);
  assert.doesNotMatch(html, /tools\.invoke/u);
});

test("demo site roster exposes the same verified scopes per peer", async () => {
  const source = await readFile(
    new URL("../examples/body4ai/site/site.js", import.meta.url),
    "utf8",
  );
  const code = [
    extractNamed(source, "grantedScopesFor"),
    extractNamed(source, "snapshot"),
    "({ grantedScopesFor, snapshot });",
  ].join("\n");
  const state = {
    wallet: { id: "site:wallet" },
    room: {
      session: "room-session",
      peers: new Map([
        ["p1", { id: "agent:peer-1", session: "s1", name: "Peer One" }],
        ["p2", { id: "agent:peer-2", session: "s2", name: "Peer Two" }],
      ]),
    },
    transport: {
      connectionState: { status: "direct-peer-connected", directPeerCount: 2 },
    },
    session: {
      consent: { body: { payload: { capabilities: ["presence.read"] } } },
      lease: { status: () => "active", expiresAt: 123, isActive: () => true },
      request: {},
    },
    policy: {
      inspect: (id) => ({
        mode: "restricted",
        member: {
          scopes:
            id === "agent:peer-1" ? ["presence.read", "messages.send"] : [],
        },
        walletRevoked: id === "agent:peer-2",
        membershipRevoked: false,
      }),
    },
    catalogs: [],
    closeReason: "",
    membership: null,
  };
  const sandbox = vm.runInNewContext(code, {
    state,
    document: { querySelectorAll: () => [] },
  });
  const snap = sandbox.snapshot();
  const one = snap.peerList.find((p) => p.id === "agent:peer-1");
  const two = snap.peerList.find((p) => p.id === "agent:peer-2");
  // The arrays come from a VM context, so spread them into this realm first.
  assert.deepEqual([...one.scopes], ["presence.read", "messages.send"]);
  assert.deepEqual([...two.scopes], []);
  assert.ok(!one.scopes.includes("tools.invoke"), "only the granted subset");
  assert.equal(sandbox.grantedScopesFor("agent:peer-2").length, 0);
});
