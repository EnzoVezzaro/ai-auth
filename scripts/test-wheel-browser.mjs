// Browser checks for the interaction wheel using a stub connection (no network,
// no wallet): layout at 360px, focus handling, privacy blocking, previews,
// targeting, receipt-driven states, and capture cleanup. Run `npm run build` first.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const dist = new URL("../dist-p2p/", import.meta.url);
const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body>
<main><p id="plain">Plain text</p><input id="pw" type="password" value="hunter2"><div id="edit" contenteditable="true">draft</div>
<section id="priv" data-ai-auth-private>secret</section></main>
<script type="module">
import { mountCollaborationWheel } from "/ai-auth.js";
const listeners = new Set(); const calls = []; window.__calls = calls;
const connection = { supportsTargets: true, supportsReceipts: true,
  subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
  async sendText(text, o) { calls.push(["text", text, o]); },
  async sendElement(m, o) { calls.push(["element", m, o]); },
  async sendAttachment(b, o) { calls.push(["attachment", o]); } };
window.__emit = (e) => listeners.forEach((l) => l(e));
const net = { connectionState: { status: "waiting-for-peers", directPeerCount: 0, peers: [] }, ls: new Set(),
  onConnectionState(l) { net.ls.add(l); return () => net.ls.delete(l); } };
window.__net = (s) => { net.connectionState = s; net.ls.forEach((l) => l(s)); };
const A = "agent:" + "A".repeat(43), kp = { kty: "EC", crv: "P-256", x: "x", y: "y" };
window.__peerId = A;
const room = { wallet: { id: "agent:" + "S".repeat(43) }, peers: new Map(), subscribe: () => () => {} };
window.__room = room;
window.__remove = mountCollaborationWheel(connection, { capabilities: ["messages.send", "content.share"], room, network: net });
let stops = 0; window.__stops = () => stops;
navigator.mediaDevices.getDisplayMedia = async () => { const c = document.createElement("canvas"); c.width = 64; c.height = 64;
  c.getContext("2d").fillRect(0, 0, 64, 64); const s = c.captureStream(5);
  s.getTracks().forEach((t) => { const o = t.stop.bind(t); t.stop = () => { stops++; o(); }; }); return s; };
</script>`;

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/") return res.setHeader("content-type", "text/html").end(PAGE);
  try {
    const body = await readFile(new URL(`.${path}`, dist));
    res.setHeader("content-type", "text/javascript").end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
  ],
  ...(process.env.AI_AUTH_CHROMIUM_PATH
    ? { executablePath: process.env.AI_AUTH_CHROMIUM_PATH }
    : {}),
});
try {
  const page = await (
    await browser.newContext({ viewport: { width: 360, height: 640 } })
  ).newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const toggle = page.locator("[data-ai-auth-collaboration-wheel] .toggle");
  const sh = (sel) => page.locator(`[data-ai-auth-collaboration-wheel] ${sel}`);
  await toggle.click();
  const box = await sh(".panel").boundingBox();
  assert.ok(
    box.x >= 0 && box.x + box.width <= 360 && box.y >= 0,
    `panel off-screen: ${JSON.stringify(box)}`,
  );

  // No peers: controls explain why they are unavailable.
  assert.equal(await sh("input").isDisabled(), true);
  assert.match(await sh(".hint").textContent(), /No peers/);
  assert.equal(
    await sh('[data-action="element"]').getAttribute("aria-disabled"),
    "true",
  );

  // A direct peer connects and shows up with a fingerprint, not a name.
  await page.evaluate(() => {
    window.__room.peers.set("p", {
      id: window.__peerId,
      publicKey: {},
      seenAt: Date.now(),
    });
    window.__net({
      status: "direct-peer-connected",
      directPeerCount: 1,
      peers: [{ peerId: "p" }],
    });
  });
  // Wait for the wheel to reflect the new peer instead of sleeping a fixed tick.
  await page.waitForFunction(() => {
    const wheel = document.querySelector("[data-ai-auth-collaboration-wheel]");
    const input = wheel?.shadowRoot?.querySelector("input");
    return Boolean(input && !input.disabled);
  });
  assert.match(await sh(".peers").textContent(), /No verified peers yet/);
  assert.equal(
    await sh("input").isDisabled(),
    false,
    "broadcast stays available once a direct peer exists",
  );
  assert.match(
    await sh(".warn").first().textContent(),
    /public room can see and save/,
  );

  // Escape closes and returns focus to the toggle; Tab stays inside the dialog.
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector("[data-ai-auth-collaboration-wheel]")
        .shadowRoot.querySelector(".panel")
        .contains(
          document.querySelector("[data-ai-auth-collaboration-wheel]")
            .shadowRoot.activeElement,
        ),
    ),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await sh(".panel").isHidden(), true);
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector("[data-ai-auth-collaboration-wheel]").shadowRoot
          .activeElement?.className,
    ),
    "toggle",
  );

  // Sensitive elements are refused; nothing is staged or sent.
  await toggle.click();
  for (const id of ["#pw", "#edit", "#priv"]) {
    await sh('[data-action="element"]').click();
    await page.locator(id).click({ force: true });
    assert.match(await sh(".status").textContent(), /private or sensitive/, id);
  }
  assert.equal(await page.evaluate(() => window.__calls.length), 0);

  // Preview first, then send; state is honest until a receipt arrives.
  await sh('[data-action="element"]').click();
  await page.locator("#plain").click({ force: true });
  await sh('[data-action="confirm"]').waitFor();
  assert.match(await sh(".preview-body").textContent(), /Plain text/);
  await sh('[data-action="confirm"]').click();
  const sent = await page.evaluate(() => window.__calls[0]);
  assert.equal(sent[0], "element");
  assert.match(sent[2].messageId, /^[0-9a-f-]{36}$/);
  assert.match(
    await sh(".log").textContent(),
    /Sent to transport\. Not confirmed delivered/,
  );
  assert.doesNotMatch(await sh(".log").textContent(), /Signed receipt/);
  await page.evaluate(
    (id) =>
      window.__emit({
        type: "receipt",
        receipt: {
          messageId: id,
          receiver: "agent:" + "R".repeat(43),
          receivedAt: Date.now(),
          nonce: "n".repeat(24),
        },
      }),
    sent[2].messageId,
  );
  assert.match(
    await sh(".log").textContent(),
    /Signed receipt from .*does not mean anyone read it/,
  );

  // Recording: cancel stops every track and sends nothing.
  await sh('[data-action="record"]').click();
  await sh('[data-action="cancel-record"]:not([hidden])').waitFor();
  await sh('[data-action="cancel-record"]').click();
  await page.waitForFunction(() => window.__stops() >= 1);
  assert.equal(
    await page.evaluate(
      () => window.__calls.filter((c) => c[0] === "attachment").length,
    ),
    0,
  );

  // Closing mid-recording also releases the screen.
  const before = await page.evaluate(() => window.__stops());
  await sh('[data-action="record"]').click();
  await sh('[data-action="cancel-record"]:not([hidden])').waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction((n) => window.__stops() > n, before);

  // Unmount removes the wheel.
  await page.evaluate(() => window.__remove());
  assert.equal(
    await page.locator("[data-ai-auth-collaboration-wheel]").count(),
    0,
  );
  console.log(
    "Wheel browser checks passed (360px layout, focus, privacy, preview, receipts, capture cleanup).",
  );
} finally {
  await browser.close();
  server.close();
}
