// Full-protocol, multi-agent E2E on the BODY4AI demo site. Real Chromium,
// real public Nostr relays and real direct WebRTC; no SDK mocks. See docs/E2E.md.
import { setTimeout as delay } from "node:timers/promises";
import { launchBrowser, startStaticServer } from "./e2e/helpers.mjs";
import { HeadlessAgent } from "./e2e/participants.mjs";
import { createReport } from "./e2e/report.mjs";
import { createSiteAuthority } from "./e2e/site-authority.mjs";
import { roomName } from "./e2e/world.mjs";
import * as id from "./e2e/steps-identity.mjs";
import * as room from "./e2e/steps-room.mjs";
import * as tools from "./e2e/steps-tools.mjs";
import * as life from "./e2e/steps-lifecycle.mjs";

const RUN_LIMIT_MS = 10 * 60_000;
const report = createReport();
const w = {
  report,
  room: roomName(),
  contexts: [],
  p: {},
  link: null,
};
let browser;

async function cleanup() {
  await Promise.all(w.contexts.map((c) => c.close().catch(() => {})));
  await w.headless?.stop().catch(() => {});
  await browser?.close().catch(() => {});
  await w.serverA?.stop();
  await w.serverB?.stop();
}

async function finish(extra) {
  console.log(report.summary());
  await report.write({ room: w.room, ...extra });
  await cleanup();
  process.exit(report.passed() ? 0 : 1);
}

const limit = setTimeout(async () => {
  console.error(`Whole-run timeout of ${RUN_LIMIT_MS / 1000}s exceeded`);
  report.rows.push({
    step: 99,
    name: "whole-run timeout",
    status: "FAIL",
    durationMs: RUN_LIMIT_MS,
    note: "exceeded 10 minutes",
    evidence: {},
  });
  await finish({ aborted: true });
}, RUN_LIMIT_MS);
limit.unref();

try {
  w.serverA = await startStaticServer();
  w.serverB = await startStaticServer({ basePath: "/ai-auth/", build: false });
  w.authority = await createSiteAuthority({
    origin: w.serverA.origin,
    room: w.room,
  });
  browser = await launchBrowser();
  w.browser = browser;
  await id.bootAgents(w);
  w.headless = new HeadlessAgent({
    origin: w.serverA.origin,
    room: w.room,
    issuer: w.authority.issuerJwk,
    name: "Headless agent",
  });
  await w.headless.start();
  const stopAfter = Number(process.env.B4A_STOP_AFTER ?? 99);
  const run = (n, name, fn) =>
    n > stopAfter ? undefined : report.step(n, name, (ev) => fn(w, ev));
  // B4A_STOP_AFTER can skip `run`, so guard the missing row instead of throwing.
  const ok = async (n, name, fn) => {
    const row = await run(n, name, fn);
    return row ? row.status !== "FAIL" : false;
  };
  await run(
    1,
    "Wallets created on first connect; identities distinct",
    id.step1,
  );
  await id.admitMembers(w);
  await run(
    2,
    "Consent modal: agent approves a subset; site sees only that",
    id.step2,
  );
  w.consentA1 = await w.p.a1.get(
    "({ consent: b4a.state.session.consent, request: b4a.state.session.request })",
  );
  await run(
    3,
    "Session grant: expiry visible, outlives handshake, renews, expires",
    id.step3,
  );
  await run(
    5,
    "Site link: approveLink/verifyLink, listed after reload, scopes only",
    id.step5,
  );
  if (
    await ok(
      4,
      "Connection state: waiting-for-peers -> direct-peer-connected (real count)",
      room.step4,
    )
  ) {
    await run(
      6,
      "Restricted room: uninvited Agent 3 gets nothing and cannot invoke",
      room.step6,
    );
    await run(
      7,
      "Presence/cursors: one cursor per verified identity, claims labelled",
      room.step7,
    );
    await run(
      8,
      "Wheel: broadcast, targeted, receipts, redaction, screenshot, oversize",
      room.step8,
    );
    await run(9, "Agents exchange signed events directly", room.step9);
    await run(
      10,
      "WebMCP: discovery, read-only, approve/deny, cancel, duplicate id",
      tools.step10,
    );
    await run(
      11,
      "Mixed permissions: no tools.invoke scope cannot call wishlist.add",
      tools.step11,
    );
    await run(
      12,
      "Human A closes tab; agents stay connected and keep talking",
      life.step12,
    );
    await run(
      13,
      "Human B opens the site, sees both agents' cursors and messages them",
      life.step13,
    );
    await run(
      14,
      "Agent restart: same identity, rejoins, no ghost cursor",
      life.step14,
    );
    await run(
      15,
      "Revocation propagates; revoked Agent 2's protected calls fail",
      life.step15,
    );
    await run(
      16,
      "Unlink: site applies revocation; link-authorized use fails",
      life.step16,
    );
    await run(
      20,
      "Headless Node agent: visible, exchanges signed events with Agent 1",
      life.step20,
    );
    await run(17, "Disconnect: cursor removed within the lease", life.step17);
    await run(
      18,
      "Cross-origin: Origin B cannot reuse consent, link or membership",
      life.step18,
    );
    await run(
      19,
      "Private presence: no cursor or presence, still receives and is audited",
      life.step19,
    );
  }
} catch (error) {
  report.rows.push({
    step: 0,
    name: "harness setup",
    status: "FAIL",
    durationMs: 0,
    note: String(error?.stack ?? error),
    evidence: {},
  });
} finally {
  clearTimeout(limit);
  await delay(0);
  await finish({});
}
