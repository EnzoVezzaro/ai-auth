import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ApprovalError,
  GRANT_FILE,
  createApprovalLease,
  grantPath,
  lifetimeFromEnv,
  readSavedGrant,
  writeSavedGrant,
} from "../approval.js";

const ORIGIN = "https://site.example";
const ROOM = "lobby";
const REQUESTED = ["messages.send", "presence.read", "tools.invoke"];

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-grants-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("lifetimeFromEnv defaults to Never and bounds a numeric session", () => {
  assert.deepEqual(lifetimeFromEnv({}), {
    sessionTtlMs: null,
    idleTimeoutMs: null,
  });
  assert.deepEqual(lifetimeFromEnv({ AI_AUTH_SESSION_TTL_MS: "60000" }), {
    sessionTtlMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  assert.deepEqual(
    lifetimeFromEnv({
      AI_AUTH_SESSION_TTL_MS: "600000",
      AI_AUTH_IDLE_TIMEOUT_MS: "30000",
    }),
    { sessionTtlMs: 600_000, idleTimeoutMs: 30_000 },
  );
  assert.throws(
    () => lifetimeFromEnv({ AI_AUTH_SESSION_TTL_MS: "0" }),
    ApprovalError,
  );
  assert.throws(
    () => lifetimeFromEnv({ AI_AUTH_IDLE_TIMEOUT_MS: "soon" }),
    ApprovalError,
  );
});

test("a saved approval snapshot is non-secret, reused and strictly matched", async (t) => {
  const dir = await scratch(t);
  const file = grantPath(dir);
  assert.equal(path.basename(file), GRANT_FILE);
  assert.equal(
    await readSavedGrant({
      dir,
      origin: ORIGIN,
      room: ROOM,
      requested: REQUESTED,
    }),
    null,
  );

  await writeSavedGrant({
    dir,
    origin: ORIGIN,
    room: ROOM,
    requested: REQUESTED,
    granted: ["presence.read"],
    sessionTtlMs: 90_000,
    idleTimeoutMs: 20_000,
    approvedAt: 1_000,
  });
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, "utf8");
  for (const secret of ["privateKey", "passphrase", "token", "signature", "d:"])
    assert.ok(!text.includes(secret), `grant file leaks ${secret}`);

  const saved = await readSavedGrant({
    dir,
    origin: ORIGIN,
    room: ROOM,
    requested: REQUESTED,
  });
  assert.deepEqual([...saved.scopes], ["presence.read"]);
  assert.equal(saved.sessionTtlMs, 90_000);
  assert.equal(saved.idleTimeoutMs, 20_000);
  assert.equal(saved.approvedAt, 1_000);

  const mismatch = async (overrides) =>
    assert.rejects(
      readSavedGrant({
        dir,
        origin: ORIGIN,
        room: ROOM,
        requested: REQUESTED,
        ...overrides,
      }),
      /does not match|unreadable/u,
    );
  await mismatch({ origin: "https://other.example" });
  await mismatch({ room: "elsewhere" });
  await mismatch({ requested: [...REQUESTED, "content.share"] });
  await mismatch({ requested: ["presence.read"] });

  await writeFile(file, "{broken", "utf8");
  await mismatch({});
});

test("an approval lease ends on fixed expiry, idle and revocation", () => {
  let clock = 1_000;
  const lease = createApprovalLease({
    sessionTtlMs: 10_000,
    idleTimeoutMs: 3_000,
    approvedAt: 1_000,
    now: () => clock,
  });
  assert.equal(lease.check(), "active");
  assert.equal(lease.expiresAt, 11_000);
  clock += 2_000;
  assert.equal(lease.touch(), true);
  clock += 2_000;
  assert.equal(lease.check(), "active", "activity refreshed the idle clock");
  clock += 2_000;
  assert.equal(lease.check(), "expired", "idle maps to expired");
  assert.equal(lease.touch(), false);

  const fixed = createApprovalLease({
    sessionTtlMs: 1_000,
    approvedAt: 1_000,
    now: () => clock,
  });
  assert.equal(fixed.check(), "expired");

  const live = createApprovalLease({ now: () => clock });
  assert.equal(live.check(), "active", "Never has no end");
  clock += 10_000_000;
  assert.equal(live.check(), "active");
  live.revoke();
  assert.equal(live.check(), "revoked");
  assert.throws(() => createApprovalLease({ sessionTtlMs: -1 }), ApprovalError);
});
