import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { identityFor, P2PRoom } from "../packages/p2p/index.js";
import { createPresenceTracker } from "../packages/p2p/presence.js";
import {
  appSource,
  extractFunction,
  extractIfContaining,
} from "./helpers/app-source.mjs";

globalThis.crypto ??= webcrypto;

async function makeWallet(name) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    id: await identityFor(publicKey),
    name,
    publicKey,
    privateKey: keys.privateKey,
  };
}

test("a site disconnect sends peer/goodbye and removes the peer at once", async () => {
  const source = await appSource();
  const branch = extractIfContaining(
    source,
    'event.data?.type === "ai-auth/session-ended"',
  );
  const expire = extractFunction(source, "expireExternalSession");

  const wallet = await makeWallet("visitor wallet");
  const origin = "https://site.example";
  const room = new P2PRoom(wallet, "default", { origin });
  // The other side tracks this wallet's room session. A goodbye must remove it
  // now, not after the 24 s heartbeat lease expires.
  const presence = createPresenceTracker();
  assert.equal(
    presence.heartbeat({
      walletId: wallet.id,
      session: room.session,
      label: "Visitor",
    }),
    true,
  );
  assert.equal(presence.list().length, 1);

  const envelopes = [];
  const unsubscribe = room.subscribe(({ envelope }) => {
    if (!envelope) return;
    envelopes.push(envelope);
    if (envelope.body.type === "peer/goodbye")
      presence.goodbye({
        walletId: envelope.body.issuer,
        session: envelope.body.payload.session,
      });
  });

  const externalHost = { postMessage() {} };
  const state = {
    externalStatus: "sent",
    externalSource: externalHost,
    externalOrigin: origin,
    externalRequest: { audience: origin },
    externalPendingEvents: [],
    consent: { body: { payload: { requestNonce: "site-session-nonce" } } },
    lease: { revoke() {} },
    transfers: { close() {} },
    rtc: { close() {} },
    room,
    view: "connect",
  };
  const context = vm.createContext({
    console,
    state,
    externalHost,
    roomGeneration: 0,
    event: {
      data: { type: "ai-auth/session-ended", reason: "ended" },
      source: externalHost,
      origin,
    },
    markSessionEnded() {},
    render() {},
    setTimeout,
    clearTimeout,
    Date,
  });
  vm.runInContext(expire, context);
  try {
    await vm.runInContext(`(async () => { ${branch} })()`, context);
    // expireExternalSession closes the room fire-and-forget; let the signed
    // goodbye finish signing and reach the stub transport.
    for (let i = 0; i < 20; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
    const goodbye = envelopes.find(
      (envelope) => envelope.body.type === "peer/goodbye",
    );
    assert.ok(goodbye, "a site-side disconnect must send peer/goodbye");
    assert.equal(goodbye.body.issuer, wallet.id);
    assert.equal(
      presence.list().length,
      0,
      "the peer is removed without waiting for the lease",
    );
  } finally {
    unsubscribe();
    await room.close({ goodbye: false });
  }
});
