import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  approvePermissionRequest,
  createCapabilityGrant,
  createPermissionRequest,
  identityFor,
  NonceGuard,
  P2PRoom,
  randomNonce,
  signEnvelope,
  verifyCapabilityGrant,
  verifyPermissionConsent,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

async function testWallet(name) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  return {
    id,
    name,
    publicKey,
    privateKey: pair.privateKey,
    sign: (type, payload) =>
      signEnvelope(
        { id, publicKey, privateKey: pair.privateKey },
        type,
        payload,
      ),
  };
}

test("wallet consent, delegation, and signed peer delivery work end to end", async () => {
  const owner = await testWallet("Owner agent");
  const peer = await testWallet("Research peer");
  const origin = "https://wallet.example";
  const request = await createPermissionRequest(origin, [
    "presence.read",
    "messages.send",
  ]);
  const consent = await approvePermissionRequest(owner, request, [
    "messages.send",
  ]);
  assert.equal(
    await verifyPermissionConsent(consent, request, {
      expectedOrigin: origin,
      expectedWallet: owner.id,
      nonceGuard: new NonceGuard(),
    }),
    true,
  );

  const grant = await createCapabilityGrant(owner, {
    recipient: peer.id,
    resource: "site:wallet.example/room:research",
    capabilities: ["messages.send"],
    expiresAt: Date.now() + 10 * 60_000,
  });
  assert.equal(
    await verifyCapabilityGrant(grant, {
      expectedIssuer: owner.id,
      expectedRecipient: peer.id,
      resource: "site:wallet.example/room:research",
      requiredCapability: "messages.send",
    }),
    true,
  );

  const ownerSession = new P2PRoom(owner, "research", { origin });
  const peerSession = new P2PRoom(peer, "research", { origin });
  const signedMessage = await ownerSession.wallet.sign("message/text", {
    room: "research",
    origin,
    session: "owner-session",
    nonce: randomNonce(),
    expiresAt: Date.now() + 60_000,
    text: "Ready to research together.",
  });
  assert.equal(await peerSession.receive(signedMessage), true);
  assert.equal(peerSession.peers.size, 0);
  assert.equal(await peerSession.receive(signedMessage), false);
  await ownerSession.close();
  await peerSession.close();
});
