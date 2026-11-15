// Real network test: two OS processes, public Nostr relays, real WebRTC.
// Opt-in because it needs internet and a network that permits peer candidates:
//   npm run test:network --prefix packages/agent
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../examples/peer.mjs", import.meta.url));

function run(dir, room, name, seconds) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [script, dir, room, name, String(seconds)],
      {
        env: { ...process.env, AI_AUTH_PASSPHRASE: "network test passphrase" },
      },
    );
    const lines = [];
    child.stdout.on("data", (d) =>
      lines.push(
        ...String(d)
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      ),
    );
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", () => resolve(lines));
  });
}

test("two Node processes become direct peers and exchange a signed event", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "ai-auth-net-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const room = `net-${process.pid}-${Date.now()}`;
  const [a, b] = await Promise.all([
    run(path.join(base, "a"), room, "A", 30),
    run(path.join(base, "b"), room, "B", 30),
  ]);
  for (const [lines, other] of [
    [a, "B"],
    [b, "A"],
  ]) {
    assert.ok(
      lines.some(
        (l) => l.event === "state" && l.status === "direct-peer-connected",
      ),
      "direct peer connected",
    );
    assert.ok(
      lines.some(
        (l) => l.event === "received" && l.text === `hello from ${other}`,
      ),
      "received signed message",
    );
  }
  console.log(JSON.stringify({ A: a, B: b }, null, 1));
});
