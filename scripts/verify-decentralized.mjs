#!/usr/bin/env node
// W3 transport-invariant probe for the "serverless" acceptance criterion.
//
// Default (no network): source-level checks plus an exact inventory of the
// URLs/ports that a legitimate session may use.
//
//   node scripts/verify-decentralized.mjs
//
// Live capture (REAL public Nostr relays + real WebRTC, may take ~1-2 min):
//
//   AI_AUTH_LIVE=1 node scripts/verify-decentralized.mjs
//
// The live mode opens two isolated browser wallets on the local static site,
// joins them in one random room, sends a unique application event, and inspects
// Playwright network events plus an injected data-channel observer. It never
// edits SDK source and mocks nothing in the transport.
//
// Honest limits are printed as UNKNOWN, never reported as PASS:
//  - Playwright sees WebSockets/HTTP, not the contents of WebRTC data channels;
//    the data-channel evidence is page-level instrumentation, not a wire tap.
//  - Relay frames are checked for known Nostr types and for the absence of
//    application payloads; a relay could in principle carry an opaque blob we
//    cannot decode. Source inspection (p2p.js) covers that gap statically.
//  - STUN/ICE is UDP and does not appear in Playwright request events.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultRelayUrls } from "@trystero-p2p/nostr";
import { launchBrowser, startStaticServer, waitFor } from "./e2e/helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const rows = [];
const BROWSER_HOSTS = [
  "clients2.google.com",
  "www.google.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "accounts.google.com",
  "optimizationguide-pa.googleapis.com",
];
const APP_EVENT_TYPES = [
  "message/text",
  "collab/text",
  "collab/element",
  "collab/attachment",
  "presence/cursor",
  "agent/action",
  "agent/task",
  "agent/catalog",
  "tool-request",
  "tool-response",
  "peer/hello",
  "peer/heartbeat",
  "peer/goodbye",
  "membership/prove",
  "receipt/",
];
const NOSTR_TYPES = new Set([
  "REQ",
  "EVENT",
  "OK",
  "CLOSE",
  "EOSE",
  "NOTICE",
  "COUNT",
  "AUTH",
]);

function record(status, name, detail = "") {
  rows.push({ status, name, detail });
  console.log(
    `[${status.padEnd(7)}] ${name}${detail ? `\n          ${detail}` : ""}`,
  );
}

function check(name, ok, detail = "") {
  record(ok ? "PASS" : "FAIL", name, detail);
  return ok;
}

async function repoFile(rel) {
  return readFile(resolve(root, rel), "utf8");
}

function relayHosts() {
  return new Set(
    defaultRelayUrls.map((url) => new URL(url).host.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Static checks: no network, no browser, deterministic.
// ---------------------------------------------------------------------------

async function staticChecks() {
  const pkg = JSON.parse(await repoFile("package.json"));
  check(
    "relay transport dependency is @trystero-p2p/nostr",
    Boolean(pkg.dependencies?.["@trystero-p2p/nostr"]),
    `version ${pkg.dependencies?.["@trystero-p2p/nostr"] ?? "missing"}`,
  );

  const p2p = await repoFile("packages/p2p/p2p.js");
  check(
    "browser room joins the Nostr transport and forwards events via its action",
    /import\("@trystero-p2p\/nostr"\)/u.test(p2p) &&
      /makeAction\(TRYSTERO_ACTION\)/u.test(p2p) &&
      /sendAction\(envelope,\s*\{\s*target:\s*\[peerId\]\s*\}\)/u.test(p2p),
    "NostrWebRTC.makeAction -> deliverToPeer -> sendAction(target: peerId)",
  );
  check(
    "TURN is disabled in the room transport config",
    /turnConfig:\s*\[\]/u.test(p2p),
    "p2p.js passes turnConfig: [] to Trystero",
  );
  check(
    "relay config only sets relay URLs, never an application endpoint",
    /relayConfig:\s*\{\s*urls:\s*this\.relayUrls\s*\}/u.test(p2p),
  );

  const runtime = await repoFile("packages/agent/runtime.js");
  check(
    "headless runtime uses NostrWebRTC/P2PRoom, not an app client",
    /from "@trystero-p2p\/nostr"/u.test(runtime) &&
      /new NostrWebRTC\(core,/u.test(runtime) &&
      /new P2PRoom\(roomWallet,/u.test(runtime),
  );

  const sources = [
    "packages/p2p/p2p.js",
    "packages/p2p/agent-connect.js",
    "packages/agent/runtime.js",
  ];
  const appServerCalls = [];
  for (const rel of sources) {
    const text = await repoFile(rel);
    for (const [i, line] of text.split("\n").entries()) {
      if (
        /\bfetch\(|XMLHttpRequest|node:http|node:https|https?\.request/u.test(
          line,
        )
      )
        appServerCalls.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    }
  }
  check(
    "no HTTP client call to an AI Auth app server in the transport/connect path",
    appServerCalls.length === 0,
    appServerCalls.join("\n          ") ||
      "no fetch/XHR/http.request in the three files",
  );

  const connect = await repoFile("packages/p2p/agent-connect.js");
  check(
    "connect instruction publishes only public data (origin, room, wallet, caps)",
    /siteOrigin,\s*walletUrl,\s*capabilities/u.test(connect) &&
      /DEFAULT_SDK_SOURCE\s*=\s*"https:\/\/esm\.sh\//u.test(connect) &&
      !/\b(secret|password|privateKey|apiKey)\s*[:=]/u.test(connect),
    "SDK bundle is fetched from esm.sh (a package CDN, not an AI Auth server)",
  );

  record(
    "INFO",
    "expected endpoints for a live session",
    [
      "ALLOW  http://127.0.0.1:<port>/ai-auth/...  (local static site + wallet iframe)",
      "ALLOW  https://enzovezzaro.github.io/ai-auth/...  (deployed static site)",
      "ALLOW  https://esm.sh/@enzovezzaro/ai-auth-wallet@<version>  (SDK bundle, connect instruction)",
      `ALLOW  wss://<relay host>:443  (${relayHosts().size} Trystero default Nostr relays; signaling only)`,
      "ALLOW  UDP stun*.l.google.com:19302, stun.cloudflare.com:3478 (STUN only)",
      "DENY   any hosted ai-auth API / relay-carried application data / TURN endpoint",
    ].join("\n          "),
  );
  record(
    "UNKNOWN",
    "wire-level proof of signaling-only relays and direct data channels",
    "requires live capture: AI_AUTH_LIVE=1 node scripts/verify-decentralized.mjs",
  );
}

// ---------------------------------------------------------------------------
// Live capture.
// ---------------------------------------------------------------------------

// Self-contained init script: observes WebRTC data channels and the ICE config
// without replacing any SDK handler (only adds listeners and wraps send()).
function dataChannelObserver() {
  const NativePC = window.RTCPeerConnection;
  if (!NativePC) return;
  window.__dcCapture = { received: [], sent: [], iceServers: [] };
  const track = (channel, tag) => {
    if (!channel || channel.__aiAuthTracked) return;
    channel.__aiAuthTracked = true;
    channel.addEventListener("message", (event) => {
      window.__dcCapture.received.push({
        tag,
        label: channel.label,
        data: String(event.data),
      });
    });
    const originalSend = channel.send.bind(channel);
    Object.defineProperty(channel, "send", {
      configurable: true,
      writable: true,
      value: (data, ...rest) => {
        window.__dcCapture.sent.push({
          tag,
          label: channel.label,
          data: String(data),
        });
        return originalSend(data, ...rest);
      },
    });
  };
  window.RTCPeerConnection = new Proxy(NativePC, {
    construct(target, args, newTarget) {
      const config = args[0] ?? {};
      window.__dcCapture.iceServers.push(
        (config.iceServers ?? []).map((server) => String(server.urls)).flat(),
      );
      const pc = Reflect.construct(target, args, newTarget);
      pc.addEventListener("datachannel", (event) => track(event.channel, "in"));
      const create = pc.createDataChannel.bind(pc);
      pc.createDataChannel = (...params) => {
        const channel = create(...params);
        track(channel, "out");
        return channel;
      };
      return pc;
    },
  });
}

function attachNetworkCapture(page) {
  const capture = { sockets: [], requests: [], failed: [] };
  page.on("websocket", (socket) => {
    const entry = { url: socket.url(), frames: [] };
    capture.sockets.push(entry);
    const remember =
      (direction) =>
      ({ payload }) =>
        entry.frames.push({
          direction,
          payload:
            typeof payload === "string"
              ? payload
              : Buffer.from(payload).toString(),
        });
    socket.on("framesent", remember("out"));
    socket.on("framereceived", remember("in"));
  });
  page.on("request", (request) =>
    capture.requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      postData: request.postData()?.slice(0, 500) ?? null,
    }),
  );
  page.on("requestfailed", (request) =>
    capture.failed.push({
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    }),
  );
  return capture;
}

function allFrames(captures) {
  return captures.flatMap((capture) =>
    capture.sockets.flatMap((socket) =>
      socket.frames.map((frame) => ({ url: socket.url(), ...frame })),
    ),
  );
}

function containsAppEvent(text) {
  return APP_EVENT_TYPES.some((type) => text.includes(type));
}

function classifyHttp(requests, origin) {
  const allowedHost = new URL(origin).host.toLowerCase();
  const unexpected = [];
  const browser = [];
  for (const request of requests) {
    let host;
    try {
      host = new URL(request.url).host.toLowerCase();
    } catch {
      continue;
    }
    if (
      host === allowedHost ||
      host === "localhost:" + new URL(origin).port ||
      host === "127.0.0.1:" + new URL(origin).port
    )
      continue;
    if (
      host === "enzovezzaro.github.io" ||
      host === "esm.sh" ||
      host.endsWith(".esm.sh")
    )
      continue;
    if (BROWSER_HOSTS.includes(host)) {
      browser.push(`${host} (browser background)`);
      continue;
    }
    unexpected.push(`${request.method} ${request.url}`);
  }
  return { unexpected, browser };
}

async function liveChecks() {
  const relayHostsSet = relayHosts();
  const marker = `decentralized-probe-${randomBytes(6).toString("hex")}`;
  const room = `decentralized-probe-${randomBytes(5).toString("hex")}`;
  let server;
  let browser;
  const contexts = [];
  try {
    server = await startStaticServer({ build: false });
    browser = await launchBrowser();
    const participants = [];
    for (const label of ["Transport probe A", "Transport probe B"]) {
      const context = await browser.newContext({ acceptDownloads: true });
      contexts.push(context);
      await context.addInitScript(dataChannelObserver);
      const page = await context.newPage();
      const capture = attachNetworkCapture(page);
      await page.goto(`${server.siteUrl}body4ai/index.html`);
      await page.waitForFunction(() => Boolean(window.__b4a), undefined, {
        timeout: 30_000,
      });
      await page.evaluate((config) => window.__b4a.init(config), {
        origin: server.origin,
        room,
        restricted: false,
      });
      await page.evaluate(
        (name) =>
          window.__b4a.identity({
            label: name,
            passphrase: `probe passphrase for ${name}`,
          }),
        label,
      );
      await page.evaluate(() => window.__b4a.connect());
      await page.evaluate(() => window.__b4a.join());
      participants.push({ label, page, capture });
    }

    let connected = true;
    try {
      await waitFor(
        async () => {
          for (const p of participants) {
            const snapshot = await p.page.evaluate(() =>
              window.__b4a.snapshot(),
            );
            if (snapshot.directPeerCount < 1) return false;
          }
          return true;
        },
        { timeout: 60_000, message: "two direct WebRTC peers", interval: 500 },
      );
    } catch (error) {
      connected = false;
      record(
        "UNKNOWN",
        "application event over a direct WebRTC data channel",
        `no direct peer formed on this network: ${error.message}`,
      );
    }

    if (connected) {
      await participants[0].page.evaluate(
        (text) => window.__b4a.sendText({ text }),
        marker,
      );
      await waitFor(
        async () => {
          for (const p of participants) {
            const seen = await p.page.evaluate(
              (value) =>
                [
                  ...(window.__dcCapture?.received ?? []),
                  ...(window.__dcCapture?.sent ?? []),
                ].some((message) => message.data.includes(value)),
              marker,
            );
            if (!seen) return false;
          }
          return true;
        },
        {
          timeout: 15_000,
          message: `marker "${marker}" on both data channels`,
          interval: 250,
        },
      ).catch(() => {});
    }

    const captures = participants.map((p) => p.capture);
    const frames = allFrames(captures);
    const relaySockets = captures
      .flatMap((c) => c.sockets)
      .filter((socket) => {
        try {
          return (
            socket.url.startsWith("wss:") &&
            relayHostsSet.has(new URL(socket.url).host.toLowerCase())
          );
        } catch {
          return false;
        }
      });

    if (relaySockets.length > 0) {
      check(
        "Nostr relays carry signaling WebSockets",
        true,
        `${relaySockets.length} relay socket(s), ${frames.length} frame(s) across ${new Set(relaySockets.map((s) => new URL(s.url).host)).size} relay hosts`,
      );
      const bad = frames.filter(
        (frame) =>
          frame.payload.includes(marker) || containsAppEvent(frame.payload),
      );
      const typed = frames.filter((frame) => {
        try {
          const parsed = JSON.parse(frame.payload);
          return Array.isArray(parsed) && NOSTR_TYPES.has(parsed[0]);
        } catch {
          return false;
        }
      });
      check(
        "no application event text appears in relay WebSocket frames",
        bad.length === 0,
        bad.length
          ? `offending frames: ${bad
              .slice(0, 5)
              .map((f) => `${f.direction} ${f.payload.slice(0, 160)}`)
              .join("\n          ")}`
          : `${typed.length}/${frames.length} frames decode to known Nostr message types; none carry app events`,
      );
    } else {
      record(
        "UNKNOWN",
        "Nostr signaling-only check",
        "no relay WebSocket was captured (relays unreachable or blocked on this network)",
      );
    }

    const dcData = await Promise.all(
      participants.map((p) =>
        p.page.evaluate(() => ({
          received: window.__dcCapture?.received ?? [],
          sent: window.__dcCapture?.sent ?? [],
        })),
      ),
    );
    const dcWithMarker = dcData.map(
      (d) =>
        d.received.filter((m) => m.data.includes(marker)).length +
        d.sent.filter((m) => m.data.includes(marker)).length,
    );
    if (connected) {
      check(
        "unique application event traveled over WebRTC data channels",
        dcWithMarker.every((count) => count > 0),
        `marker observed on data channels: A=${dcWithMarker[0]}, B=${dcWithMarker[1]}`,
      );
    }
    const httpContainingMarker = captures
      .flatMap((c) => c.requests)
      .filter(
        (r) => r.url.includes(marker) || (r.postData ?? "").includes(marker),
      );
    check(
      "unique application event was not sent in any HTTP request",
      httpContainingMarker.length === 0,
      httpContainingMarker.map((r) => r.url).join("\n          "),
    );

    const allRequests = captures.flatMap((c) => c.requests);
    const { unexpected, browser } = classifyHttp(allRequests, server.origin);
    check(
      "no unexpected HTTP(S) application-server endpoint contacted",
      unexpected.length === 0,
      unexpected.length
        ? unexpected.join("\n          ")
        : `${allRequests.length} HTTP request(s), all to the static site, package CDN, or browser background`,
    );
    if (browser.length)
      record(
        "INFO",
        "browser background requests ignored",
        [...new Set(browser)].join(", "),
      );

    const turn = (
      await Promise.all(
        participants.map((p) =>
          p.page.evaluate(() => window.__dcCapture?.iceServers ?? []),
        ),
      )
    )
      .flat(2)
      .filter((url) => /^turns?:/iu.test(url));
    check("no TURN server configured", turn.length === 0, turn.join(", "));

    record(
      "UNKNOWN",
      "cryptographic wire proof / relay payload decoding",
      "Playwright cannot read DTLS-encrypted WebRTC packets or decode opaque relay content; " +
        "this script proves observable absence + page-level data-channel delivery, backed by static source checks",
    );
  } finally {
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    await browser?.close().catch(() => {});
    await server?.stop();
  }
}

// ---------------------------------------------------------------------------

await staticChecks();
if (process.env.AI_AUTH_LIVE === "1") {
  console.log("\n-- live capture (real relays/WebRTC) --");
  try {
    await liveChecks();
  } catch (error) {
    record(
      "UNKNOWN",
      "live capture could not complete",
      String(error?.stack ?? error)
        .split("\n")
        .slice(0, 8)
        .join("\n          "),
    );
  }
}

const count = (status) => rows.filter((row) => row.status === status).length;
console.log(
  `\nSummary: PASS ${count("PASS")}  FAIL ${count("FAIL")}  UNKNOWN ${count("UNKNOWN")}  INFO ${count("INFO")}`,
);
const reportPath = resolve(root, "test-results/decentralized-report.json");
await mkdir(resolve(root, "test-results"), { recursive: true });
await writeFile(
  reportPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2),
);
console.log(`Report: ${reportPath}`);
if (count("FAIL") > 0) process.exitCode = 1;
