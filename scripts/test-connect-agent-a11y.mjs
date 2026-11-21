// Accessibility + mobile QA for the connect-agent page, against the identity-UX
// audit contract (P2-18 and the accessibility gate). Runs at 320px, keyboard
// only where noted, checks visible focus, an aria-live status region, a real
// .ring.middle animation that stops under reduced motion, non-overlapping
// status-row rects, a non-degraded role=alert, and a textual (not colour-only)
// status signal, and writes sanitized screenshots to screenshots/qa-*.png.
//
// All identity data here is synthetic. No full wallet id, passphrase or signed
// material is placed in an assertion message or in a screenshot. Deterministic
// negative/visual states use the exposed applyVerifiedProof test seam; they are
// UI-evidence states, never a claim of a real remote proof or live peer.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startStaticServer, waitFor } from "./e2e/helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const shotDir = resolve(root, "screenshots");
const SYNTHETIC_ID = "agent:qa-synthetic-evidence";
const REQUIRED_IDS = [
  "#connect",
  "#waiting",
  "#session",
  "#status-pill",
  "#status-text",
  "#agent-id",
  "#agent-name",
  "#status-card",
  "#row-identity",
  "#row-access",
  "#row-connected",
  "#expected-wallet",
  "#begin-verify",
];
const STATUS_ROWS = ["Identity verified", "Access approved", "Connected now"];
const FULL_ID_RE = /\b(?:agent:)?[0-9a-f]{32,}\b/iu;
const SECRET_VALUE_RE =
  /\b(?:passphrase|recovery phrase|private key)\s*[:=]\s*\S{6,}/iu;

const server = await startStaticServer();
let browser;

function blocked(reasons) {
  return new Error(
    `BLOCKED: UX/security contract has not landed in this working tree. Missing:\n  - ${reasons.join("\n  - ")}`,
  );
}

async function capture(page, name) {
  await mkdir(shotDir, { recursive: true });
  const path = resolve(shotDir, name);
  await page.screenshot({ path, fullPage: true });
  // We cannot OCR the PNG here, so enforce sanitization on the exact visible
  // text that produced it; the fixtures contain only synthetic identifiers.
  const text = await page.locator("body").innerText();
  assert.doesNotMatch(
    text,
    FULL_ID_RE,
    `${name}: full wallet id leaked into a capture`,
  );
  assert.doesNotMatch(
    text,
    SECRET_VALUE_RE,
    `${name}: secret value leaked into a capture`,
  );
  console.log(`SHOT ${path}`);
  return path;
}

async function statusRegion(page) {
  return page.evaluate(() => {
    const region = document.querySelector("#status-pill");
    const liveEl =
      region?.closest("[aria-live]") ??
      document.querySelector("#error[aria-live]");
    return {
      live: liveEl?.getAttribute("aria-live") ?? null,
      text: (document.querySelector("#status-text")?.textContent ?? "").trim(),
    };
  });
}

// The animated element in this page is .ring.middle ("animation: spin 18s").
// Measuring it in both contexts is what makes the reduced-motion check real;
// the old check looked for a non-existent ".spinner" and always passed.
function ringDuration(page) {
  return page.evaluate(() => {
    const ring = document.querySelector(".ring.middle");
    return ring ? getComputedStyle(ring).animationDuration : null;
  });
}

// B1: measure label vs value boxes of every status row. A shared grid cell
// produces a positive intersection in both axes; stacking them in separate
// rows must leave at least one axis with no overlap.
async function assertNoRowOverlap(page, where) {
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".status-row")].map((row) => {
      const box = (selector) => {
        const r = row.querySelector(selector)?.getBoundingClientRect();
        return r
          ? {
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              width: r.width,
              height: r.height,
            }
          : null;
      };
      return { id: row.id, label: box(".row-label"), value: box(".row-value") };
    }),
  );
  assert.equal(rows.length, 3, `${where}: three status rows must be present`);
  for (const row of rows) {
    assert.ok(
      row.label && row.value,
      `${where}: ${row.id} must have a label and a value`,
    );
    const vertical =
      Math.min(row.label.bottom, row.value.bottom) -
      Math.max(row.label.top, row.value.top);
    const horizontal =
      Math.min(row.label.right, row.value.right) -
      Math.max(row.label.left, row.value.left);
    assert.ok(
      vertical <= 0.5 || horizontal <= 0.5,
      `${where}: ${row.id} label/value overlap (vertical=${vertical.toFixed(1)}px, horizontal=${horizontal.toFixed(1)}px, label=${JSON.stringify(row.label)}, value=${JSON.stringify(row.value)})`,
    );
  }
  console.log(`RECTS ${where}: ${JSON.stringify(rows)}`);
  return rows;
}

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 320, height: 720 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${server.siteUrl}connect-agent/`);
  await waitFor(() => page.locator("#connect").isVisible(), {
    message: "single CTA is visible at 320px",
  });

  // Preflight: report exactly which contract pieces are absent instead of
  // claiming accessibility passes on the old transient screen.
  const missing = [];
  for (const id of REQUIRED_IDS)
    if ((await page.locator(id).count()) === 0) missing.push(`element ${id}`);
  const domText = await page.locator("body").textContent();
  for (const row of STATUS_ROWS)
    if (!domText.includes(row)) missing.push(`status card row "${row}"`);
  const initialStatus = await statusRegion(page);
  if (!["polite", "assertive"].includes(initialStatus.live))
    missing.push("aria-live on the status region");
  if (missing.length) throw blocked(missing);

  // 320px must not scroll sideways; the primary CTA must still be usable.
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    ctaWidth:
      document.querySelector("#connect")?.getBoundingClientRect().width ?? 0,
  }));
  assert.ok(
    layout.scrollWidth <= layout.clientWidth + 1,
    `horizontal overflow at 320px: ${JSON.stringify(layout)}`,
  );
  assert.ok(
    layout.ctaWidth >= 44,
    `primary CTA tap target too small: ${layout.ctaWidth}px`,
  );

  await capture(page, "qa-connect-agent-initial.png");

  // B2 baseline: prove the page actually animates before asserting that reduced
  // motion stops it. Measuring only the reduced context (or a missing element)
  // makes the check vacuous.
  const normalDuration = await ringDuration(page);
  assert.ok(
    normalDuration !== null && parseFloat(normalDuration) > 0,
    `normal motion must be active on .ring.middle: ${normalDuration}`,
  );

  // Synthetic expected wallet, set without moving focus so the keyboard walk
  // below still starts from the top of the document.
  await page.evaluate((value) => {
    const wallet = document.querySelector("#expected-wallet");
    wallet.value = value;
    wallet.dispatchEvent(new Event("input", { bubbles: true }));
    const instance = document.querySelector("#expected-instance");
    instance.value = "inst:qa-synthetic";
    instance.dispatchEvent(new Event("input", { bubbles: true }));
  }, SYNTHETIC_ID);

  // Keyboard only: reach the CTA with Tab and confirm the focus is visible.
  let focusedId = "";
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    focusedId = await page.evaluate(() => document.activeElement?.id ?? "");
    if (focusedId === "connect") break;
  }
  assert.equal(focusedId, "connect", "connect CTA must be reachable with Tab");
  const focus = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  const focusVisible =
    (focus.outlineStyle !== "none" && parseFloat(focus.outlineWidth) > 0) ||
    Boolean(focus.boxShadow && focus.boxShadow !== "none");
  assert.ok(
    focusVisible,
    `focus must be visible on #connect: ${JSON.stringify(focus)}`,
  );

  // Enter activates the one CTA and the status region announces the change.
  await page.keyboard.press("Enter");
  await waitFor(() => page.locator("#waiting").isVisible(), {
    message: "keyboard activation reaches the waiting state",
  });
  const waitingStatus = await statusRegion(page);
  assert.ok(
    ["polite", "assertive"].includes(waitingStatus.live),
    "waiting status must be announced by a live region",
  );
  assert.ok(
    waitingStatus.text.length > 0,
    "status must be text, not colour alone",
  );
  await capture(page, "qa-connect-agent-waiting.png");

  // Space activates the secondary button without leaving the waiting state.
  let copyAgainFocused = false;
  for (let step = 0; step < 12; step += 1) {
    const id = await page.evaluate(() => document.activeElement?.id ?? "");
    if (id === "again") {
      copyAgainFocused = true;
      break;
    }
    await page.keyboard.press("Tab");
  }
  assert.ok(copyAgainFocused, "copy-again button must be reachable with Tab");
  await page.keyboard.press("Space");
  assert.equal(
    await page.locator("#waiting").isVisible(),
    true,
    "Space on copy-again keeps the waiting state",
  );

  // Deterministic UI states for the evidence screenshots. These use synthetic
  // identities only and never stand in for a real proof or live connection.
  // The wizard gates phase changes on verificationStarted, so enter chapter 3
  // through the real control (no responder is attached in this static harness).
  await page.locator("#begin-verify").click();
  await waitFor(
    async () =>
      (await page.evaluate(
        () => window.__connectAgent?.verificationStarted,
      )) === true,
    { message: "verification chapter reached" },
  );

  // Rejected: a proof for a different wallet must fail closed with a text
  // diagnosis, and must never show CONNECTED NOW.
  await page.evaluate(() => {
    window.__connectAgentControls.applyVerifiedProof({
      walletId: "agent:qa-synthetic-other-wallet",
      instanceId: "inst:qa-synthetic-other",
      claims: {},
      verifiedAt: Date.now(),
    });
  });
  await waitFor(
    async () =>
      (await page.evaluate(() => window.__connectAgent?.phase)) === "error",
    { message: "wrong-wallet proof is rejected" },
  );
  const rejectedStatus = await statusRegion(page);
  assert.notEqual(rejectedStatus.text, "CONNECTED NOW");
  assert.match(
    await page.locator("#diagnosis").innerText(),
    /different wallet/iu,
  );
  await capture(page, "qa-connect-agent-rejected.png");

  // Verified offline: identity verified is a historical fact, while the live
  // status row stays offline until an authenticated peer exists.
  await page.evaluate((id) => {
    window.__connectAgentControls.applyVerifiedProof({
      walletId: id,
      instanceId: "inst:qa-synthetic",
      claims: {
        authorization: {
          audience: location.origin,
          scopes: ["presence.read"],
        },
      },
      verifiedAt: Date.now(),
    });
  }, SYNTHETIC_ID);
  await waitFor(
    async () =>
      (await page.evaluate(() => window.__connectAgent?.phase)) === "offline",
    { message: "verified-offline state reached" },
  );
  assert.equal(
    (await page.locator("#identity-status").innerText()).trim(),
    "Verified",
  );
  assert.notEqual(
    (await page.locator("#connected-status").innerText()).trim(),
    "Online now",
  );
  await capture(page, "qa-connect-agent-verified-offline.png");

  // B1 regression: the verified-offline screenshot used to show label/value
  // overlapping in all three rows at 320px. Measure the live rects here.
  await assertNoRowOverlap(page, "verified-offline@320px");

  // Authorized + online needs a real authenticated peer; this static a11y run
  // deliberately does not fake it. The page E2E covers that with a live agent.
  console.log(
    "SKIP authorized-online: no live verified peer in the accessibility harness; no synthetic screenshot written",
  );

  // Reduced motion: the spinner must stop and the CTA must remain visible.
  const reducedContext = await browser.newContext({
    viewport: { width: 320, height: 720 },
    reducedMotion: "reduce",
  });
  try {
    const reducedPage = await reducedContext.newPage();
    await reducedPage.goto(`${server.siteUrl}connect-agent/`);
    await waitFor(() => reducedPage.locator("#connect").isVisible(), {
      message: "CTA visible with reduced motion",
    });
    const reducedDuration = await ringDuration(reducedPage);
    const reduced = await reducedPage.evaluate(() => ({
      matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
      ctaVisible:
        (document.querySelector("#connect")?.getBoundingClientRect().width ??
          0) > 0,
    }));
    assert.equal(
      reduced.matches,
      true,
      "reduced-motion media query must match",
    );
    console.log(
      `MOTION .ring.middle: normal=${normalDuration} reduced=${reducedDuration}`,
    );
    assert.ok(
      reducedDuration !== null && parseFloat(reducedDuration) < 0.01,
      `reduced motion must stop .ring.middle animation: normal=${normalDuration}, reduced=${reducedDuration}`,
    );
    assert.equal(
      reduced.ctaVisible,
      true,
      "reduced motion must not hide the CTA",
    );
  } finally {
    await reducedContext.close();
  }

  // B3 regression: role="alert" already implies an assertive live region, so an
  // explicit aria-live="polite" silently degrades it. Fail if any alert region
  // carries the polite value (the old code did, on #error). Kept last so the
  // layout/motion evidence above is still collected if this assertion trips.
  const alertRegions = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"]')].map((el) => ({
      id: el.id || null,
      live: el.getAttribute("aria-live"),
    })),
  );
  assert.ok(
    alertRegions.length > 0,
    "an error region with role=alert must exist",
  );
  for (const alert of alertRegions)
    assert.notEqual(
      alert.live,
      "polite",
      `role="alert" must not be degraded to aria-live="polite" (#${alert.id})`,
    );

  assert.deepEqual(errors, []);
  console.log(
    "PASS connect-agent a11y: 320px layout, no status-row overlap, keyboard focus, aria-live status, non-degraded role=alert, textual status and real reduced motion all held.",
  );
} catch (error) {
  const message = error?.message ?? String(error);
  console.error(
    message.startsWith("BLOCKED:") ? message : `A11Y_FAIL ${message}`,
  );
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop?.();
  server.child?.kill("SIGTERM");
}
