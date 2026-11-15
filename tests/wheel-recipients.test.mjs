import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { identityFor } from "../packages/p2p/index.js";
import {
  buildRecipients,
  explainSendBlock,
  fingerprintFromId,
  rememberPeer,
  verifyPeerKey,
} from "../packages/p2p/wheel-recipients.js";

globalThis.crypto ??= webcrypto;
async function keyPair() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return crypto.subtle.exportKey("jwk", keys.publicKey);
}
const snap = (status, peers = [], directPeerCount = peers.length) => ({
  status,
  peers,
  directPeerCount,
});

test("fingerprints derive from the verified key, and a mismatched id is refused", async () => {
  const key = await keyPair();
  const id = await identityFor(key);
  const verified = await verifyPeerKey(key, id);
  assert.equal(verified.walletId, id);
  assert.equal(verified.fingerprint, fingerprintFromId(id));
  assert.match(verified.fingerprint, /^[A-Za-z0-9_-]{4}-[A-Za-z0-9_-]{4}$/u);
  const other = await identityFor(await keyPair());
  assert.equal(await verifyPeerKey(key, other), null);
  assert.equal(await verifyPeerKey({ kty: "oct" }), null);
});

test("online state comes from connection state plus fresh signed presence", () => {
  const now = 100_000;
  let known = new Map();
  known = rememberPeer(
    known,
    { walletId: "agent:AAAAAAAAAAAAAAAAAAAAAA", fingerprint: "AAAA-AAAA" },
    now - 1000,
  );
  known = rememberPeer(
    known,
    { walletId: "agent:BBBBBBBBBBBBBBBBBBBBBB", fingerprint: "BBBB-BBBB" },
    now - 60_000,
  );
  const live = buildRecipients({
    known,
    snapshot: snap("direct-peer-connected", [{ peerId: "p" }]),
    selfId: "x",
    now,
  });
  assert.deepEqual(
    live.map((r) => [r.fingerprint, r.online]),
    [
      ["AAAA-AAAA", true],
      ["BBBB-BBBB", false],
    ],
  );
  const down = buildRecipients({
    known,
    snapshot: snap("waiting-for-peers"),
    selfId: "x",
    now,
  });
  assert.deepEqual(
    down.map((r) => r.online),
    [false, false],
  );
  const self = buildRecipients({
    known,
    snapshot: undefined,
    selfId: "agent:AAAAAAAAAAAAAAAAAAAAAA",
    now,
  });
  assert.equal(self.length, 1);
});

test("when connection state names wallets, only those are online", () => {
  const known = rememberPeer(
    new Map(),
    { walletId: "agent:AAAAAAAAAAAAAAAAAAAAAA", fingerprint: "AAAA-AAAA" },
    1000,
  );
  const list = buildRecipients({
    known,
    snapshot: snap("direct-peer-connected", [
      { peerId: "p", walletId: "agent:OTHEROTHEROTHEROTHER00" },
    ]),
    selfId: "x",
    now: 1000,
  });
  assert.equal(list[0].online, false);
});

test("rememberPeer is immutable and bounded", () => {
  const first = new Map();
  let next = first;
  for (let i = 0; i < 40; i++)
    next = rememberPeer(
      next,
      { walletId: `agent:${String(i).padStart(22, "0")}`, fingerprint: "x" },
      i,
    );
  assert.equal(first.size, 0);
  assert.equal(next.size, 16);
});

test("send gating explains why and never widens a targeted selection", () => {
  const online = [{ walletId: "agent:T", fingerprint: "T", online: true }];
  const offline = [{ walletId: "agent:T", fingerprint: "T", online: false }];
  const base = {
    selection: "everyone",
    recipients: online,
    snapshot: snap("direct-peer-connected", [{}]),
    supportsTargets: true,
  };
  assert.equal(explainSendBlock(base), "");
  assert.match(explainSendBlock({ ...base, expired: true }), /expired/);
  assert.match(
    explainSendBlock({
      ...base,
      recipients: [],
      snapshot: snap("waiting-for-peers"),
    }),
    /No peers/,
  );
  assert.match(
    explainSendBlock({ ...base, snapshot: snap("disconnected") }),
    /Not connected/,
  );
  assert.equal(explainSendBlock({ ...base, selection: "agent:T" }), "");
  assert.match(
    explainSendBlock({ ...base, selection: "agent:T", recipients: offline }),
    /offline/,
  );
  assert.match(
    explainSendBlock({ ...base, selection: "agent:T", supportsTargets: false }),
    /one recipient/,
  );
  assert.match(
    explainSendBlock({ ...base, selection: "agent:GONE" }),
    /offline/,
  );
});
