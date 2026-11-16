// Shared helpers for the browser E2E scripts: static servers, Chromium launch,
// bounded polling, ICE diagnostics, a controllable clock and the wallet-modal
// approval flow. Nothing here mocks the SDK, Nostr or WebRTC.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const root = fileURLToPath(new URL("../../", import.meta.url));

export async function freePort() {
  const probe = createNetServer();
  await new Promise((done, fail) => {
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", done);
  });
  const { port } = probe.address();
  await new Promise((done, fail) =>
    probe.close((error) => (error ? fail(error) : done())),
  );
  return port;
}

/** Starts scripts/serve.mjs. Only the first server may build dist-p2p. */
export async function startStaticServer({
  basePath = "/ai-auth/",
  build = true,
  host = "127.0.0.1",
} = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(root, "scripts/serve.mjs")], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      BASE_PATH: basePath,
      ...(build ? {} : { AI_AUTH_SKIP_BUILD: "1" }),
    },
    stdio: "inherit",
  });
  const origin = `http://${host}:${port}`;
  const server = {
    child,
    port,
    origin,
    basePath,
    siteUrl: `${origin}${basePath}`,
    walletUrl: `${origin}${basePath}wallet/?debug=1`,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, delay(5_000)]).catch(() => {});
    },
  };
  await waitForServer(server.siteUrl, child);
  return server;
}

export async function waitForServer(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null)
      throw new Error(`Static server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  throw new Error(`Static server did not serve ${url}`);
}

export function launchBrowser(extraArgs = []) {
  return chromium.launch({
    headless: true,
    args: [
      ...(process.env.AI_AUTH_BLOCK_THIRD_PARTY
        ? ["--test-third-party-cookie-phaseout"]
        : []),
      ...extraArgs,
    ],
    ...(process.env.AI_AUTH_CHROMIUM_PATH
      ? { executablePath: process.env.AI_AUTH_CHROMIUM_PATH }
      : {}),
  });
}

/**
 * Polls `check` until it returns a truthy value or the deadline passes.
 * Never a fixed sleep: the poll interval only bounds how often we look.
 */
export async function waitFor(
  check,
  { timeout = 30_000, interval = 150, message = "condition" } = {},
) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await delay(interval);
  }
  const detail = last instanceof Error ? `: ${last.message}` : "";
  throw new Error(
    `Timed out after ${timeout} ms waiting for ${message}${detail}`,
  );
}

/** Records ICE failures in the page so a failed run can say why. */
export function iceDiagnosticsScript() {
  const NativePeerConnection = window.RTCPeerConnection;
  if (!NativePeerConnection) return;
  window.__aiAuthIceDiagnostics = [];
  window.RTCPeerConnection = new Proxy(NativePeerConnection, {
    construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      peer.addEventListener("iceconnectionstatechange", async () => {
        if (!["failed", "disconnected"].includes(peer.iceConnectionState))
          return;
        const stats = await peer.getStats().catch(() => new Map());
        const entries = [...stats.values()];
        window.__aiAuthIceDiagnostics.push({
          iceConnectionState: peer.iceConnectionState,
          connectionState: peer.connectionState,
          candidates: entries
            .filter((s) => s.type.endsWith("-candidate"))
            .map(({ type, candidateType, protocol, port }) => ({
              type,
              candidateType,
              protocol,
              port,
            })),
          pairs: entries
            .filter((s) => s.type === "candidate-pair")
            .map(({ state, nominated, bytesSent, bytesReceived }) => ({
              state,
              nominated,
              bytesSent,
              bytesReceived,
            })),
        });
      });
      return peer;
    },
  });
}

/** Both Date.now() and new Date() follow window.__clockOffset (ms). */
export function clockControlScript() {
  const RealDate = Date;
  window.__RealDate = RealDate;
  window.__clockOffset = 0;
  window.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() + window.__clockOffset);
    }
    static now() {
      return RealDate.now() + window.__clockOffset;
    }
  };
}

/** Synthetic screen capture: the only mock, and only for getDisplayMedia. */
export function fakeScreenCaptureScript() {
  window.addEventListener("DOMContentLoaded", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    context.fillStyle = "#17634d";
    context.fillRect(0, 0, 640, 360);
    let flip = false;
    setInterval(() => {
      flip = !flip;
      context.fillStyle = flip ? "#17634d" : "#1c6e54";
      context.fillRect(0, 0, 640, 360);
    }, 100);
    canvas.style.cssText = "position:fixed;left:-10000px;top:0";
    document.body.append(canvas);
    HTMLMediaElement.prototype.play = async () => {};
    for (const [name, value] of [
      ["videoWidth", 640],
      ["videoHeight", 360],
    ])
      Object.defineProperty(HTMLVideoElement.prototype, name, {
        configurable: true,
        get: () => value,
      });
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      if (source instanceof HTMLVideoElement) {
        this.fillStyle = "#17634d";
        this.fillRect(0, 0, this.canvas.width, this.canvas.height);
        return;
      }
      return drawImage.call(this, source, ...args);
    };
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => canvas.captureStream(2),
    });
  });
}

/**
 * Drives the real wallet iframe: creates a wallet on first use, approves the
 * capabilities in `approve`, and waits for the site to report a connection.
 * The host page must expose #connect and set window.__connected.
 */
export async function approveWallet(
  context,
  { siteUrl, name, passphrase, approve, withIceDiagnostics = true },
) {
  if (withIceDiagnostics) await context.addInitScript(iceDiagnosticsScript);
  const site = await context.newPage();
  const siteDiagnostics = [];
  const popupErrors = [];
  site.on("console", (message) => {
    if (message.text().includes("[AI Auth debug]"))
      siteDiagnostics.push(message.text());
    if (message.type() === "error") popupErrors.push(message.text());
  });
  site.on("pageerror", (error) => popupErrors.push(error.message));
  await site.goto(siteUrl);
  await site.locator("#connect").click();
  await site.locator('dialog iframe[title="AI Auth wallet"]').waitFor();
  const popup = await (
    await site.locator('dialog iframe[title="AI Auth wallet"]').elementHandle()
  ).contentFrame();
  assert.ok(popup, "wallet iframe exists");
  await popup.waitForFunction(
    () =>
      document
        .querySelector("#view")
        ?.innerText.includes("Requested capabilities"),
    undefined,
    { timeout: 10_000 },
  );
  if (await popup.locator("[data-go-wallet]").count()) {
    await popup.locator("[data-go-wallet]").click();
    await popup.locator("#wallet-name").fill(name);
    await popup.locator("#wallet-passphrase").fill(passphrase);
    await popup.locator("#wallet-passphrase-confirm").fill(passphrase);
    assert.notEqual(await site.evaluate(() => window.__connected), true);
    const download = site.waitForEvent("download");
    await popup.locator('#create-wallet-form button[type="submit"]').click();
    await download;
  }
  try {
    await popup
      .locator("#external-permission-form")
      .waitFor({ timeout: 30_000 });
  } catch (error) {
    throw new Error(
      `Wallet popup did not show the permission form. Current view: ${await popup.locator("#view").innerText()} Errors: ${popupErrors.join(" | ")}`,
      { cause: error },
    );
  }
  for (const capability of approve)
    await popup
      .locator(`input[name="external-capability"][value="${capability}"]`)
      .check();
  assert.notEqual(await site.evaluate(() => window.__connected), true);
  await popup
    .locator('#external-permission-form button[type="submit"]')
    .click();
  await site.waitForFunction(() => window.__connected === true, undefined, {
    timeout: 30_000,
  });
  return { site, popup, popupErrors, siteDiagnostics };
}
