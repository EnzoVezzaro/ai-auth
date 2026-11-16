// Steps 12-20: tab close, late joiner, restart, revocation, unlink,
// disconnect, cross-origin, private presence and the headless agent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assert,
  CAPS,
  config,
  cursorsOf,
  expectEventually,
  networkAware,
} from "./world.mjs";
import { Participant, newContext } from "./participants.mjs";
import { Pending } from "./report.mjs";
import { approveNext, discover } from "./steps-tools.mjs";

const peerIds = async (p) => (await p.snapshot()).peers;
const gotText = (p, from, text) =>
  p.get(
    "b4a.state.events.some((e) => e.type === 'message/text' && e.issuer === arg)",
    from,
  );

export async function step12(w, evidence) {
  const { ha, hb, a1, a2 } = w.p;
  await ha.context.close();
  await hb.page.close();
  await expectEventually(
    async () => !(await peerIds(a1)).includes(ha.walletId),
    "Human A to leave Agent 1's peer list",
    45_000,
  );
  for (const p of [a1, a2]) {
    const s = await p.snapshot();
    assert.equal(s.status, "direct-peer-connected");
    assert.ok(s.peers.includes(a1 === p ? a2.walletId : a1.walletId));
  }
  const nodeSeen = (await w.headless.state()).peers;
  assert.ok(
    nodeSeen.includes(a1.walletId),
    "headless agent still sees Agent 1",
  );
  const marker = `after human A left ${Date.now()}`;
  await a1.call("sendSigned", "message/text", { text: marker });
  await expectEventually(
    () => gotText(a2, a1.walletId, marker),
    "Agent 2 hears Agent 1 after Human A left",
  );
  await a2.call("sendSigned", "message/text", { text: marker + " reply" });
  await expectEventually(
    () => gotText(a1, a2.walletId, marker),
    "Agent 1 hears Agent 2",
  );
  evidence.agentPeerCounts = {
    a1: (await a1.snapshot()).directPeerCount,
    a2: (await a2.snapshot()).directPeerCount,
  };
}

export async function step13(w, evidence) {
  const { hb, a1, a2 } = w.p;
  const second = new Participant(
    "Human B (new tab)",
    hb.context,
    hb.siteUrl,
    "human",
  );
  w.p.hb2 = second;
  await second.open("index.html", config(w, { label: "Human B", host: true }));
  const id = await second.identity("Human B");
  assert.equal(
    id.walletId,
    hb.walletId,
    "same Human B identity on the new tab",
  );
  assert.equal(id.created, false);
  await second.connect();
  await networkAware([second], () => second.call("join"));
  await second.waitForPeers(2, { timeout: 120_000 });
  const stream = async () => {
    await a1.call("moveCursor", 0.31, 0.41);
    await a2.call("moveCursor", 0.52, 0.62);
    await w.headless.cmd("send", {
      type: "presence/cursor",
      payload: { x: 0.7, y: 0.2, visible: true, label: "headless agent" },
    });
  };
  await expectEventually(async () => {
    await stream();
    const ids = (await cursorsOf(second)).map((c) => c.issuer);
    return [a1.walletId, a2.walletId].every((x) => ids.includes(x));
  }, "Human B to see both agents' cursors");
  const sent = await second.call("sendText", {
    text: "hi from Human B",
    target: a1.walletId,
  });
  assert.equal(sent.ok, true, sent.error);
  await expectEventually(
    () =>
      a1.get(
        "b4a.state.transferLog.some((e) => e.type === 'text' && e.text === 'hi from Human B')",
      ),
    "Agent 1 receives Human B's message",
  );
  await expectEventually(
    () =>
      second.get(
        "b4a.state.transferLog.some((e) => e.type === 'receipt' && e.receiptMessageId === arg)",
        sent.messageId,
      ),
    "a signed receipt back to Human B",
  );
  await Promise.all([discover(a1, second), discover(a2, second)]);
  evidence.cursorsSeen = (await cursorsOf(second)).map((c) =>
    c.issuer.slice(0, 18),
  );
}

export async function step14(w, evidence) {
  const { a1, hb2 } = w.p;
  const before = await a1.snapshot();
  const oldSession = before.session;
  await a1.page.reload();
  await a1.page.waitForFunction(() => Boolean(window.__b4a));
  await a1.call("init", config(w, { label: "Agent 1" }));
  const id = await a1.identity("Agent 1");
  assert.equal(id.walletId, a1.walletId, "same identity after restart");
  assert.equal(id.created, false);
  assert.equal(
    (await a1.snapshot()).hasMembership,
    true,
    "membership recovered",
  );
  await a1.connect();
  await networkAware([a1], () => a1.call("join"));
  await a1.waitForPeers(2, { timeout: 120_000 });
  await a1.call("moveCursor", 0.34, 0.44);
  const fresh = (await a1.snapshot()).session;
  assert.notEqual(fresh, oldSession);
  await expectEventually(
    async () => {
      const entries = (await cursorsOf(hb2)).filter(
        (c) => c.issuer === a1.walletId,
      );
      return entries.length === 1 && entries[0].session === fresh;
    },
    "exactly one cursor for Agent 1 on the new session",
    45_000,
  );
  await expectEventually(
    async () => {
      const list = (await hb2.snapshot()).peerList.filter(
        (p) => p.id === a1.walletId,
      );
      return list.every((p) => p.session === fresh);
    },
    "the old session to leave Human B's peer list (lease)",
    60_000,
  );
  // Headless agent: same keystore, new process, same identity.
  const nodeId = w.headless.id;
  assert.equal(
    await w.headless.restart(),
    nodeId,
    "headless identity survives restart",
  );
  await w.headless.cmd("join", {
    membership: w.authority.memberships.get(nodeId),
  });
  await expectEventually(
    async () => (await hb2.snapshot()).peers.includes(nodeId),
    "restarted headless agent to rejoin",
    90_000,
  );
  evidence.oldSession = oldSession.slice(0, 8);
  evidence.newSession = fresh.slice(0, 8);
  evidence.headlessId = nodeId;
}

export async function step15(w, evidence) {
  const { a1, a2, hb2 } = w.p;
  const call = (p, giveUpMs) =>
    p.call("callTool", {
      host: hb2.walletId,
      name: "wishlist.add",
      input: { productId: "b4a-001" },
      giveUpMs,
    });
  assert.equal(
    (
      await hb2.call(
        "admitGrant",
        a2.walletId,
        await w.authority.executionGrant(a2.walletId),
      )
    ).ok,
    true,
  );
  const before = call(a2);
  await approveNext(hb2);
  assert.equal(
    (await before).ok,
    true,
    "Agent 2 protected call works before revocation",
  );
  const record = await w.authority.revokeWallet(a2.walletId);
  const published = await hb2.call("publishRevocation", record);
  assert.equal(published.ok, true);
  assert.equal(await hb2.call("isRevoked", "wallet", a2.walletId), true);
  await expectEventually(
    () => a1.call("isRevoked", "wallet", a2.walletId),
    "revocation to reach Agent 1",
  );
  const runs = await hb2.get(
    "b4a.state.executions.filter((e) => e.requester === arg).length",
    a2.walletId,
  );
  const after = await call(a2, 6_000);
  assert.ok(after.error, "revoked wallet gets no success");
  assert.equal(
    await hb2.get(
      "b4a.state.executions.filter((e) => e.requester === arg).length",
      a2.walletId,
    ),
    runs,
  );
  assert.equal(
    (await hb2.call("authorize", a2.walletId, "tools.invoke")).isMember,
    false,
  );
  evidence.revocation = record.id;
  evidence.afterRevocation = after.error;
}

export async function step16(w, evidence) {
  const { a1 } = w.p;
  const { linkId, proof, resource, requested } = w.link;
  const event = await a1.call("unlinkSite", linkId);
  assert.ok(
    !(await a1.call("links")).some((l) => l.linkId === linkId),
    "wallet no longer lists the link",
  );
  const applied = await w.authority.applyUnlink(event);
  assert.equal(applied.valid, true, applied.reason);
  assert.equal(w.authority.useLink(linkId, "presence.read").allow, false);
  const again = await w.authority.verifyAgain(proof, resource, requested);
  assert.equal(again.valid, false);
  evidence.afterUnlink = again.reason;
}

export async function step17(w, evidence) {
  const { a1, hb2 } = w.p;
  await a1.call("disconnect");
  assert.match(
    (await a1.call("sendText", { text: "after disconnect" })).error ?? "",
    /closed/u,
  );
  await expectEventually(
    async () => !(await cursorsOf(hb2)).some((c) => c.issuer === a1.walletId),
    "Agent 1's cursor to disappear within the lease",
    35_000,
  );
  assert.equal((await a1.snapshot()).status, "disconnected");
  evidence.status = "disconnected";
}

export async function step18(w, evidence) {
  const { a1 } = w.p;
  const ctx = await newContext(w.browser);
  w.contexts.push(ctx);
  const pb = new Participant(
    "Origin B visitor",
    ctx,
    w.serverB.siteUrl + "body4ai/",
    "human",
  );
  w.p.pb = pb;
  await pb.open("index.html", config(w, { label: "Origin B" }));
  await pb.identity("Origin B");
  const artifacts = {
    consent: w.consentA1.consent,
    request: w.consentA1.request,
    link: w.link.proof,
    membership: w.authority.memberships.get(a1.walletId),
    issuer: w.authority.issuerJwk,
  };
  const result = await pb.call("foreignChecks", artifacts);
  assert.notEqual(result.origin, w.serverA.origin);
  assert.equal(
    result.consentAccepted,
    false,
    "origin A consent rejected at origin B",
  );
  assert.equal(result.linkValid, false, "origin A link rejected at origin B");
  assert.equal(
    result.membershipOk,
    false,
    "origin A membership rejected at origin B",
  );
  await pb.call("admitMembership", artifacts.membership);
  await pb.connect();
  await pb.call("join");
  await expectEventually(
    async () => (await pb.snapshot()).status !== "signaling",
    "origin B to settle",
    30_000,
  );
  const seen = await pb.snapshot();
  assert.equal(
    seen.peers.length,
    0,
    "origin B shares no room topic with origin A",
  );
  evidence.foreign = result;
}

export async function step19() {
  const source = readFileSync(
    fileURLToPath(new URL("../../packages/p2p/p2p.js", import.meta.url)),
    "utf8",
  );
  if (!/privatePresence|presence:\s*"private"/u.test(source))
    throw new Pending(
      "private presence is not merged yet (Worker A); no feature to detect",
    );
  throw new Pending(
    "private presence detected; step body not wired to its final API yet",
  );
}

export async function step20(w, evidence) {
  const { a1, hb2 } = w.p;
  const node = w.headless.id;
  const state = await w.headless.state();
  assert.ok(
    ["direct-peer-connected"].includes(state.status),
    `headless status ${state.status}`,
  );
  const seenBy = await hb2.snapshot();
  assert.ok(
    seenBy.peers.includes(node),
    `browser peers see the headless agent; hb2 status ${seenBy.status}/${seenBy.directPeerCount} peers ${seenBy.peers.map((x) => x.slice(6, 14))} node ${node.slice(6, 14)} nodeState ${JSON.stringify({ ...state, events: state.events.length, states: state.states.slice(-4) })}`,
  );
  await w.headless.cmd("send", {
    type: "presence/cursor",
    payload: { x: 0.8, y: 0.3, visible: true, label: "headless" },
  });
  await expectEventually(
    async () => (await cursorsOf(hb2)).some((c) => c.issuer === node),
    "headless cursor on Human B's page",
  );
  const text = `from headless ${Date.now()}`;
  await w.headless.cmd("send", { type: "message/text", payload: { text } });
  await expectEventually(
    () => gotText(a1, node, text),
    "Agent 1 receives the headless agent's signed event",
  );
  const toNode = `to headless ${Date.now()}`;
  await a1.call("sendSigned", "message/text", { text: toNode });
  await expectEventually(
    async () =>
      (await w.headless.state()).events.some(
        (e) => e.text === toNode && e.issuer === a1.walletId,
      ),
    "headless agent receives Agent 1's signed event",
  );
  evidence.headlessId = node;
  void CAPS;
}
