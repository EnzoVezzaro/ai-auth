// Participant wrappers: one isolated Chromium context per person or agent, a
// typed handle on the site's window.__b4a harness, and a Node headless agent.
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clockControlScript,
  fakeScreenCaptureScript,
  iceDiagnosticsScript,
  waitFor,
} from "./helpers.mjs";

export class Participant {
  constructor(name, context, siteUrl, kind) {
    this.name = name;
    this.context = context;
    this.siteUrl = siteUrl;
    this.kind = kind;
    this.page = null;
    this.walletId = null;
    this.errors = [];
  }

  call(method, ...args) {
    return this.page.evaluate(
      ([m, a]) => window.__b4a[m](...a),
      [method, args],
    );
  }

  snapshot() {
    return this.call("snapshot");
  }

  get(expression, arg) {
    return this.page.evaluate(
      ([source, value]) =>
        new Function("b4a", "arg", `return ${source}`)(window.__b4a, value),
      [expression, arg ?? null],
    );
  }

  async open(path, config) {
    this.page = await this.context.newPage();
    this.page.on("pageerror", (error) => this.errors.push(error.message));
    this.page.on("console", (message) => {
      if (message.type() === "error") this.errors.push(message.text());
    });
    await this.page.goto(`${this.siteUrl}${path}`);
    await this.page.waitForFunction(() => Boolean(window.__b4a));
    await this.call("init", config);
    return this;
  }

  async identity(label) {
    const result = await this.call("identity", {
      label,
      passphrase: `E2E passphrase for ${label}`,
    });
    this.walletId = result.walletId;
    return result;
  }

  /** Opens the consent dialog, applies `approve` (default: all) and waits. */
  async connect({ approve } = {}) {
    const connecting = this.call("connect");
    await this.page.locator("#consent-dialog").waitFor({ timeout: 15_000 });
    if (approve) {
      for (const box of await this.page
        .locator('#consent-dialog input[name="capability"]')
        .all()) {
        const value = await box.getAttribute("value");
        await box.setChecked(approve.includes(value));
      }
    }
    await this.page.locator("#consent-approve").click();
    return connecting;
  }

  waitForPeers(count, { timeout = 90_000 } = {}) {
    return waitFor(
      async () => {
        const s = await this.snapshot();
        return s.directPeerCount >= count && s;
      },
      { timeout, message: `${this.name} to reach ${count} direct peers` },
    );
  }
}

export async function newContext(
  browser,
  { clock = false, capture = false } = {},
) {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(iceDiagnosticsScript);
  if (clock) await context.addInitScript(clockControlScript);
  if (capture) await context.addInitScript(fakeScreenCaptureScript);
  return context;
}

/** Node headless agent in a child process with a temp keystore. */
export class HeadlessAgent {
  constructor({ origin, room, issuer, name }) {
    this.config = { origin, room, issuer, name };
    this.seq = 0;
    this.pending = new Map();
    this.id = null;
  }

  async start() {
    this.dir = await mkdtemp(pathJoin(tmpdir(), "b4a-keystore-"));
    return this.spawn();
  }

  async spawn() {
    this.child = fork(
      fileURLToPath(new URL("./headless-agent.mjs", import.meta.url)),
      {
        env: {
          ...process.env,
          AI_AUTH_PASSPHRASE: "E2E headless agent passphrase",
          B4A_AGENT: JSON.stringify({ ...this.config, dir: this.dir }),
        },
      },
    );
    await new Promise((resolve, reject) => {
      this.child.once("message", resolve);
      this.child.once("error", reject);
    });
    this.child.on("message", (m) => {
      const waiter = this.pending.get(m.id);
      if (waiter) {
        this.pending.delete(m.id);
        m.ok ? waiter.resolve(m.result) : waiter.reject(new Error(m.error));
      }
    });
    this.id = (await this.cmd("prepare")).id;
    return this.id;
  }

  cmd(cmd, args) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, cmd, args });
    });
  }

  state() {
    return this.cmd("state");
  }

  /** Kills the process (no goodbye) and starts a new one on the same keystore. */
  async restart() {
    this.child.kill("SIGKILL");
    this.pending.clear();
    return this.spawn();
  }

  async stop() {
    try {
      await Promise.race([
        this.cmd("close"),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    } catch {
      // Already gone.
    }
    this.child?.kill("SIGKILL");
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
