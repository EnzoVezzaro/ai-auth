import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  chmod,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileKeystore, KeystoreError } from "../keystore.js";
// The browser package's verifier (workspace source): Node signatures must pass.
import { verifyEnvelope, identityFor } from "../../p2p/index.js";

const PASS = "correct horse battery staple";
const OTHER = "a completely different passphrase";

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const store = (dir, passphrase = PASS) =>
  createFileKeystore({ dir: path.join(dir, "ks"), passphrase, env: {} });

test("create then unlock round-trips identity and instance id", async (t) => {
  const dir = await scratch(t);
  const created = await store(dir).create({ name: "agent-a" });
  const unlocked = await store(dir).unlock();
  assert.equal(unlocked.id, created.id);
  assert.equal(unlocked.instanceId, created.instanceId);
  assert.match(unlocked.instanceId, /^[0-9a-f-]{36}$/);
  assert.equal(unlocked.id, await identityFor(unlocked.publicKey));
});

test("file mode is 0600, directory 0700, no plaintext key or passphrase", async (t) => {
  const dir = await scratch(t);
  const ks = store(dir);
  await ks.create({ name: "a" });
  if (process.platform !== "win32") {
    assert.equal((await stat(ks.file)).mode & 0o777, 0o600);
    assert.equal((await stat(ks.dir)).mode & 0o777, 0o700);
  }
  const text = await readFile(ks.file, "utf8");
  assert.ok(!text.includes('"d"') && !text.includes(PASS));
});

test(
  "loose permissions are refused",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await scratch(t);
    const ks = store(dir);
    await ks.create({ name: "a" });
    await chmod(ks.file, 0o644);
    await assert.rejects(ks.unlock(), { code: "KEYSTORE_PERMISSIONS" });
  },
);

test("wrong passphrase fails closed and leaks nothing", async (t) => {
  const dir = await scratch(t);
  await store(dir).create({ name: "a" });
  await assert.rejects(store(dir, OTHER).unlock(), (e) => {
    assert.equal(e.code, "KEYSTORE_UNLOCK_FAILED");
    assert.ok(!e.message.includes(OTHER) && !e.message.includes(PASS));
    return true;
  });
});

test("a corrupted file fails closed and is never overwritten", async (t) => {
  const dir = await scratch(t);
  const ks = store(dir);
  await ks.create({ name: "a" });
  await writeFile(ks.file, "{truncated", { mode: 0o600 });
  await assert.rejects(ks.unlock(), { code: "KEYSTORE_CORRUPT" });
  await assert.rejects(ks.create({ name: "b" }), { code: "KEYSTORE_EXISTS" });
  assert.equal(await readFile(ks.file, "utf8"), "{truncated");
});

test("tampered header (instance id) is detected", async (t) => {
  const dir = await scratch(t);
  const ks = store(dir);
  await ks.create({ name: "a" });
  const doc = JSON.parse(await readFile(ks.file, "utf8"));
  doc.instanceId = "00000000-0000-4000-8000-000000000000";
  await writeFile(ks.file, JSON.stringify(doc), { mode: 0o600 });
  await assert.rejects(ks.unlock(), { code: "KEYSTORE_UNLOCK_FAILED" });
});

test("unavailable keystore directory reports a clear error", async (t) => {
  const dir = await scratch(t);
  const file = path.join(dir, "not-a-dir");
  await writeFile(file, "x");
  const ks = createFileKeystore({
    dir: path.join(file, "ks"),
    passphrase: PASS,
    env: {},
  });
  await assert.rejects(ks.unlock(), KeystoreError);
});

test("passphrase from AI_AUTH_PASSPHRASE, required, min 12 chars", async (t) => {
  const dir = await scratch(t);
  const target = path.join(dir, "ks");
  await assert.rejects(
    createFileKeystore({ dir: target, env: {} }).create({}),
    { code: "KEYSTORE_PASSPHRASE" },
  );
  await assert.rejects(store(dir, "short").create({}), {
    code: "KEYSTORE_PASSPHRASE",
  });
  const viaEnv = createFileKeystore({
    dir: target,
    env: { AI_AUTH_PASSPHRASE: PASS },
  });
  await viaEnv.create({ name: "a" });
  assert.ok((await viaEnv.unlock()).id.startsWith("agent:"));
});

test("a passphrase prompt is used when no env passphrase is set", async (t) => {
  const dir = await scratch(t);
  let asked = 0;
  const ks = createFileKeystore({
    dir: path.join(dir, "ks"),
    env: {},
    prompt: async () => (asked++, PASS),
  });
  await ks.create({ name: "a" });
  await ks.unlock();
  assert.equal(asked, 2);
});

test("signatures verify with the browser verifier and reject tampering", async (t) => {
  const dir = await scratch(t);
  const wallet = await store(dir).create({ name: "a" });
  const envelope = await wallet.sign("agent/action", { name: "x" });
  assert.equal(
    await verifyEnvelope(envelope, { expectedIssuer: wallet.id }),
    true,
  );
  assert.equal(
    await verifyEnvelope(envelope, { expectedIssuer: "agent:other" }),
    false,
  );
  const forged = structuredClone(envelope);
  forged.body.payload.name = "y";
  assert.equal(await verifyEnvelope(forged), false);
});

test("wallet exposes and serializes no private key material", async (t) => {
  const dir = await scratch(t);
  const wallet = await store(dir).create({ name: "a" });
  assert.deepEqual(Object.keys(wallet).sort(), [
    "id",
    "instanceId",
    "name",
    "publicKey",
    "sign",
  ]);
  assert.ok(!JSON.stringify(wallet).includes('"d"'));
  assert.ok(!require_inspect(wallet).includes('"d"'));
});
import util from "node:util";
const require_inspect = (v) => util.inspect(v, { depth: 6, showHidden: true });

test("rotate issues a new identity and archives the old one", async (t) => {
  const dir = await scratch(t);
  const ks = store(dir);
  const first = await ks.create({ name: "a" });
  const second = await ks.rotate();
  assert.notEqual(second.id, first.id);
  assert.equal((await ks.unlock()).id, second.id);
  const files = await readdir(ks.dir);
  assert.ok(files.some((f) => f.includes("rotated")));
});

test("backup and restore round-trip; restore never clobbers silently", async (t) => {
  const dir = await scratch(t);
  const ks = store(dir);
  const original = await ks.create({ name: "a" });
  const backup = path.join(dir, "backup.json");
  await ks.backup(backup);
  if (process.platform !== "win32")
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
  await assert.rejects(ks.restore(backup), { code: "KEYSTORE_EXISTS" });
  await ks.delete();
  assert.equal(await ks.exists(), false);
  const restored = await ks.restore(backup);
  assert.equal(restored.id, original.id);
  assert.equal((await store(dir).unlock()).id, original.id);
});

test("restore with the wrong passphrase leaves no keystore behind", async (t) => {
  const dir = await scratch(t);
  const ks = store(dir);
  await ks.create({ name: "a" });
  const backup = path.join(dir, "backup.json");
  await ks.backup(backup);
  await ks.delete();
  await assert.rejects(store(dir, OTHER).restore(backup), {
    code: "KEYSTORE_UNLOCK_FAILED",
  });
  assert.equal(await ks.exists(), false);
});

test("delete removes the keystore and is idempotent", async (t) => {
  const dir = await scratch(t);
  const ks = store(dir);
  await ks.create({ name: "a" });
  await ks.delete();
  await ks.delete();
  assert.equal(await ks.exists(), false);
});
