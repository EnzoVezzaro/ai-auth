// Install a browser-created identity into a headless agent, end to end.
globalThis.BroadcastChannel = class {
  postMessage() {}
  close() {}
};
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import {
  bindInstance,
  createInstanceId,
  createWallet,
  verifyInstanceBinding,
} from "@enzovezzaro/ai-auth-wallet";
import { createFileKeystore } from "../keystore.js";
import { installAgentIdentity } from "../install.js";

globalThis.crypto ??= webcrypto;
globalThis.indexedDB ??= new IDBFactory();
const PASS = "install test passphrase 2026";

async function makeInstallPackage(site) {
  const wallet = await createWallet({
    name: "Installed agent",
    passphrase: PASS,
  });
  const instanceId = createInstanceId();
  const binding = await bindInstance(wallet, instanceId);
  assert.equal((await verifyInstanceBinding(binding)).ok, true);
  return {
    format: "ai-auth-agent-install",
    version: 1,
    name: wallet.name,
    walletId: wallet.id,
    instanceId,
    binding,
    backup: wallet.backup,
    site,
  };
}

test("an installed identity unlocks as the same wallet in the agent keystore", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-install-"));
  try {
    const site = {
      origin: "https://site.example",
      room: "team",
      capabilities: ["presence.read", "messages.send"],
      link: "https://site.example/connect-agent/?room=team",
    };
    const pkg = await makeInstallPackage(site);
    const result = await installAgentIdentity({
      dir,
      installPackage: pkg,
      passphrase: PASS,
    });
    assert.equal(result.id, pkg.walletId);
    assert.equal(result.instanceId, pkg.instanceId);
    assert.deepEqual(result.site, site);

    const info = await stat(result.file);
    assert.equal(info.mode & 0o777, 0o600);

    const keystore = createFileKeystore({ dir, passphrase: PASS, env: {} });
    const wallet = await keystore.unlock();
    assert.equal(wallet.id, pkg.walletId);
    assert.equal(wallet.name, "Installed agent");
    assert.equal(wallet.instanceId, pkg.instanceId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install fails closed on a tampered binding, wrong passphrase or existing key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-auth-install-"));
  try {
    const pkg = await makeInstallPackage(null);
    await assert.rejects(
      () =>
        installAgentIdentity({
          dir,
          installPackage: { ...pkg, walletId: "agent:other" },
          passphrase: PASS,
        }),
      /binding/i,
    );
    await assert.rejects(
      () =>
        installAgentIdentity({
          dir,
          installPackage: pkg,
          passphrase: "wrong passphrase here",
        }),
      /unlock/i,
    );
    await installAgentIdentity({ dir, installPackage: pkg, passphrase: PASS });
    await assert.rejects(
      () =>
        installAgentIdentity({ dir, installPackage: pkg, passphrase: PASS }),
      /already exists/i,
    );
    const text = await readFile(path.join(dir, "identity.json"), "utf8");
    assert.match(text, /ai-auth-agent-keystore/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
