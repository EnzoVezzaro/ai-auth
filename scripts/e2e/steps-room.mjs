// Steps 4, 6, 7, 8 and 9: connection state, restricted membership, presence,
// the interaction wheel and agent-to-agent events.
import { COLLABORATION_LIMITS } from "../../packages/p2p/index.js";
import {
  assert,
  CAPS,
  config,
  cursorsOf,
  expectEventually,
  hasEvent,
  networkAware,
} from "./world.mjs";

export async function step4(w, evidence) {
  const { ha, a1, a2, hb } = w.p;
  const { authority, headless } = w;
  await networkAware([ha, a1, a2], async () => {
    // Human A goes first so the transitions are observable from the start.
    // The panel's shadow root is closed, so drive it like a keyboard user:
    // Tab through its controls and press Enter until the consent dialog opens.
    await ha.page.locator("#before-panel").focus();
    for (let i = 0; i < 8; i++) {
      if (await ha.page.locator("#consent-dialog").count()) break;
      await ha.page.keyboard.press("Tab");
      await ha.page.keyboard.press("Enter");
    }
    await ha.page.locator("#consent-dialog").waitFor({ timeout: 15_000 });
    await ha.page.locator("#consent-approve").click();
    await expectEventually(
      async () => (await ha.snapshot()).status !== "idle",
      "Human A to join through the connect panel",
      30_000,
    );
    await expectEventually(
      () =>
        ha.get(
          "b4a.state.connLog.some((s) => s.status === 'waiting-for-peers')",
        ),
      "waiting-for-peers on Human A",
    );
    evidence.firstState = (await ha.snapshot()).status;
    const nodeMembership = await authority.admit(headless.id, [
      "presence.read",
      "messages.send",
    ]);
    await Promise.all([
      a1.call("join"),
      a2.call("join"),
      headless.cmd("join", { membership: nodeMembership }),
    ]);
    // hb joins in step 8; here: HA + A1 + A2 + Node = 3 direct peers each.
    await Promise.all(
      [ha, a1, a2].map((p) => p.waitForPeers(3, { timeout: 120_000 })),
    );
  });
  const states = await ha.get("b4a.state.connLog");
  const waiting = states.findIndex((s) => s.status === "waiting-for-peers");
  const direct = states.findIndex((s) => s.status === "direct-peer-connected");
  assert.ok(
    waiting >= 0 && direct > waiting,
    "waiting-for-peers precedes direct-peer-connected",
  );
  assert.equal(states[waiting].directPeerCount, 0);
  await expectEventually(
    async () => (await ha.snapshot()).directPeerCount === 3,
    "exactly 3 direct peers",
    30_000,
  );
  const snap = await ha.snapshot();
  assert.equal(snap.status, "direct-peer-connected");
  assert.equal(snap.directPeerCount, 3);
  assert.equal(
    await ha.page
      .locator("[data-ai-auth-connect-panel]")
      .getAttribute("data-status"),
    "connected",
  );
  evidence.transitions = states.map((s) => `${s.status}:${s.directPeerCount}`);
  evidence.directPeerCount = snap.directPeerCount;
}

export async function step6(w, evidence) {
  const { ha, a1, a2, a3 } = w.p;
  await a3.connect();
  // Agent 3 knows the origin and room; its membership (if any) is forged.
  const rogue = await w.authority.forgeMembership(a3.walletId, CAPS);
  await a3.call("admitMembership", rogue);
  await networkAware([a3], () => a3.call("join"));
  await a3.waitForPeers(1, { timeout: 120_000 });
  await ha.call("sendText", { text: "members-only chat" });
  await a1.call("sendSigned", "message/text", { text: "members-only signed" });
  await expectEventually(
    () =>
      hasEvent(
        a2,
        "(e) => e.type === 'message/text' && e.issuer === arg",
        a1.walletId,
      ),
    "members to receive restricted content",
  );
  const hostPeer = (await a3.snapshot()).peerList.find(
    (x) => x.id === ha.walletId,
  );
  const forged = await a3.call("sendSigned", "agent/action", {
    kind: "tool-request",
    requestId: "forged00000000001",
    name: "wishlist.add",
    input: { productId: "b4a-001" },
    targetWallet: ha.walletId,
    targetSession: hostPeer?.session ?? "none-none",
    targetNonce: "n".repeat(30),
  });
  const chat = await a3.call("sendText", { text: "uninvited hello" });
  const hostSees = await ha.snapshot();
  assert.ok(
    !hostSees.peers.includes(a3.walletId),
    "host never admitted Agent 3",
  );
  // Agent 3 tries the real tool path if it ever learned a catalog.
  const attempt = await a3.call("callTool", {
    name: "wishlist.add",
    input: { productId: "b4a-001" },
    giveUpMs: 6_000,
  });
  assert.ok(!attempt.ok, "Agent 3 tool call did not succeed");
  const canary = await a1.call("sendText", {
    text: "canary after forged request",
  });
  assert.equal(canary.ok, true);
  await expectEventually(
    () =>
      a2.get(
        "b4a.state.transferLog.some((e) => e.text === 'canary after forged request')",
      ),
    "the canary to reach members",
  );
  const ran = await ha.get(
    "b4a.state.executions.filter((e) => e.requester === arg).length",
    a3.walletId,
  );
  assert.equal(ran, 0, "nothing Agent 3 sent was executed");
  assert.equal(
    await ha.get(
      "b4a.state.transferLog.some((e) => e.text === 'uninvited hello')",
    ),
    false,
  );
  evidence.forgedSend = forged.ok
    ? "sent-locally-dropped-by-host"
    : forged.error;
  evidence.uninvitedChat = chat.ok ? "sent-locally" : chat.error;
  evidence.toolCallByAgent3 = attempt.error;
  // Last: confidentiality. Members must send restricted events only to members.
  const allowed = new Set(["peer/hello", "peer/heartbeat", "peer/goodbye"]);
  const seen = await a3.get(
    "[...new Set(b4a.state.events.map((e) => e.type + ' from ' + e.issuer.slice(6, 14)))]",
  );
  const leaked = seen.filter((t) => !allowed.has(t.split(" ")[0]));
  evidence.agent3Received = seen;
  assert.deepEqual(
    leaked,
    [],
    "uninvited Agent 3 received no restricted-room events",
  );
}

export async function step7(w, evidence) {
  const { ha, a1, a2, a3 } = w.p;
  // Protocol v1 cursors: document coordinates (CSS px) on a page key.
  const spots = [
    [ha, 110, 210],
    [a1, 330, 430],
    [a2, 550, 650],
  ];
  // A pointer streams positions; a cursor sent before a peer has verified our
  // membership is legitimately dropped, so keep moving until each is seen.
  const move = async () => {
    for (const [p, x, y] of spots) await p.call("moveCursor", x, y);
    await a3.call("moveCursor", 900, 900);
  };
  const issuers = [ha, a1, a2].map((p) => p.walletId);
  const withCursor = (list) => list.filter((c) => c.x !== null);
  for (const viewer of [ha, a1, a2]) {
    const expected = issuers.filter((id) => id !== viewer.walletId);
    await expectEventually(async () => {
      await move();
      const list = withCursor(await cursorsOf(viewer));
      return expected.every((id) => list.some((c) => c.issuer === id));
    }, `${viewer.name} to see the other cursors`);
    const list = await cursorsOf(viewer);
    const ids = list.map((c) => c.issuer);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${viewer.name}: one entry per identity`,
    );
    assert.ok(
      !ids.includes(viewer.walletId),
      "own identity is not a remote cursor",
    );
    assert.ok(!ids.includes(a3.walletId), "uninvited agent has no presence");
    for (const entry of list) assert.match(entry.text, /claims to be/u);
  }
  const seen = await cursorsOf(ha);
  const forA1 = seen.find((c) => c.issuer === a1.walletId);
  assert.deepEqual(
    [forA1.x, forA1.y, forA1.page],
    [330, 430, "/ai-auth/body4ai/index.html"],
  );
  // Same page, same overlay: Agent 1 and Agent 2 browse the catalog page.
  await expectEventually(
    async () => (await a1.call("overlay")).includes(a2.walletId),
    "Agent 2's cursor drawn on Agent 1's catalog page",
  );
  assert.ok(
    !(await a1.call("overlay")).includes(ha.walletId),
    "Human A is on another page",
  );
  evidence.cursorsSeenByHumanA = seen.map((c) => ({
    issuer: c.issuer.slice(0, 18),
    state: c.state,
    x: c.x,
    y: c.y,
    page: c.page,
  }));
}

async function openWheel(page) {
  const toggle = page.locator(
    '[data-ai-auth-collaboration-wheel] button[aria-label="Open collaboration"]',
  );
  if (await toggle.count()) await toggle.click();
}

export async function step8(w, evidence) {
  const { ha, hb, a1, a2, a3 } = w.p;
  await hb.connect();
  await networkAware([hb], () => hb.call("join"));
  await hb.waitForPeers(3, { timeout: 120_000 });
  // Let every membership settle first: peer-list changes re-render the wheel.
  await expectEventually(
    async () => (await ha.snapshot()).peers.includes(hb.walletId),
    "Human A to verify Human B",
    60_000,
  );
  await openWheel(ha.page);
  await ha.page
    .getByRole("textbox", { name: "Message" })
    .fill("Hello everyone from Human A");
  await ha.page.getByRole("button", { name: "Send", exact: true }).click();
  const text = (p, t) =>
    p.get(
      "b4a.state.transferLog.some((e) => e.type === 'text' && e.text === arg)",
      t,
    );
  for (const p of [a1, a2, hb])
    await expectEventually(
      () => text(p, "Hello everyone from Human A"),
      `${p.name} receives broadcast`,
    ).catch(async (error) => {
      const wheel = await ha.page
        .locator("[data-ai-auth-collaboration-wheel]")
        .evaluate((h) => h.shadowRoot.textContent.slice(0, 600));
      throw new Error(
        `${error.message}; wheel: ${wheel}; ha status ${JSON.stringify(await ha.get("b4a.state.statusLog.slice(-4)"))}`,
      );
    });
  await expectEventually(async () => {
    const receivers = await ha.get(
      "[...new Set(b4a.state.transferLog.filter((e) => e.type === 'receipt').map((e) => e.receiptReceiver))]",
    );
    return (
      [a1, a2, hb].every((p) => receivers.includes(p.walletId)) && receivers
    );
  }, "signed receipts from every recipient");
  await expectEventually(
    async () =>
      /Signed receipt from/u.test(
        await ha.page
          .locator("[data-ai-auth-collaboration-wheel] .log")
          .innerText(),
      ),
    "wheel shows a receipt-driven state",
  );
  // Targeted: Agent 1 -> Agent 2 only.
  const sent = await a1.call("sendText", {
    text: "for agent 2 only",
    target: a2.walletId,
  });
  assert.equal(sent.ok, true, sent.error);
  await expectEventually(
    () => text(a2, "for agent 2 only"),
    "Agent 2 receives the targeted message",
  );
  await expectEventually(async () => {
    const receipts = await a1.get(
      "b4a.state.transferLog.filter((e) => e.type === 'receipt' && e.receiptMessageId === arg).map((e) => e.receiptReceiver)",
      sent.messageId,
    );
    return receipts.length > 0 && receipts;
  }, "Agent 1 gets a signed receipt for the targeted message").then(
    (receipts) => {
      assert.deepEqual(receipts, [a2.walletId], "only the target acknowledged");
      evidence.targetedReceiptFrom = receipts;
    },
  );
  assert.equal(
    await text(hb, "for agent 2 only"),
    false,
    "Human B did not receive the targeted message",
  );
  const toStranger = await a1.call("sendText", {
    text: "to the uninvited",
    target: a3.walletId,
  });
  evidence.targetToUninvited = toStranger.ok ? "sent" : toStranger.error;
  // With the delivery bug from step 6 the uninvited target may still receive it.
  evidence.uninvitedTargetReceived = await text(a3, "to the uninvited");
  // Element share: the password field is redacted and cannot be selected.
  await ha.page.getByRole("button", { name: "Share element" }).click();
  await ha.page.locator("#gift-code").click({ force: true });
  assert.match(
    await ha.page
      .locator("[data-ai-auth-collaboration-wheel] .status")
      .innerText(),
    /private or sensitive/u,
  );
  await ha.page.getByRole("button", { name: "Share element" }).click();
  await ha.page.locator("#share-target").click({ position: { x: 5, y: 5 } });
  await ha.page.locator('[data-action="confirm"]').waitFor({ timeout: 10_000 });
  await ha.page.locator('[data-action="confirm"]').click();
  await expectEventually(
    () => a1.get("b4a.state.transferLog.some((e) => e.type === 'element')"),
    "Agent 1 receives the shared element",
  );
  const element = await a1.get(
    "b4a.state.transferLog.find((e) => e.type === 'element').elementText",
  );
  assert.ok(!/GIFT-SECRET/u.test(element), "password value is redacted");
  assert.match(element, /Public product notes/u);
  evidence.sharedElementText = element.slice(0, 80);
  // Synthetic screenshot (the only mocked piece: getDisplayMedia).
  await ha.page.getByRole("button", { name: "Screenshot" }).click();
  await ha.page.locator('[data-action="confirm"]').waitFor({ timeout: 10_000 });
  await ha.page.locator('[data-action="confirm"]').click();
  await expectEventually(
    () =>
      a1.get(
        "b4a.state.transferLog.some((e) => e.type === 'attachment' && e.kind === 'screenshot')",
      ),
    "Agent 1 receives the screenshot",
    45_000,
  );
  // Oversized attachment: rejected by the SDK before anything is sent.
  const big = await a1.call("sendAttachment", {
    size: COLLABORATION_LIMITS.screenshotBytes + 1,
    kind: "screenshot",
    name: "big.png",
    mime: "image/png",
  });
  assert.ok(big.error, "oversized attachment rejected");
  assert.match(big.error, /Unsupported attachment type, name, or size/u);
  evidence.oversizedRejected = big.error;
  // Agent 2 never approved content.share, so the SDK refuses before sending.
  const noShare = await a2.call("sendAttachment", {
    size: 100,
    kind: "screenshot",
    name: "x.png",
    mime: "image/png",
  });
  assert.match(noShare.error ?? "", /content\.share/u);
}

export async function step9(w, evidence) {
  const { a1, a2 } = w.p;
  const has = (p, from) =>
    p
      .get(
        "b4a.state.events.some((e) => e.type === 'message/text' && e.issuer === arg)",
        from,
      )
      .then(Boolean);
  assert.equal(
    (await a1.call("sendSigned", "message/text", { text: "a1 to a2" })).ok,
    true,
  );
  assert.equal(
    (await a2.call("sendSigned", "message/text", { text: "a2 to a1" })).ok,
    true,
  );
  await expectEventually(
    () => has(a2, a1.walletId),
    "Agent 2 receives Agent 1's signed event",
  );
  await expectEventually(
    () => has(a1, a2.walletId),
    "Agent 1 receives Agent 2's signed event",
  );
  evidence.exchanged = ["a1->a2 message/text", "a2->a1 message/text"];
}
