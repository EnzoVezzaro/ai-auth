// Install an identity that was created in a browser into a headless agent.
//
// The browser creates the wallet and an encrypted backup, binds it to a fresh
// instance id, and hands over an install package. This module verifies that
// binding, converts the backup into the agent keystore format, and writes a
// mode 0600 identity file. The private key is never exposed to page code.

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyInstanceBinding } from "@enzovezzaro/ai-auth-wallet";
import { KeystoreError, agentKeystoreFromWalletBackup } from "./keystore.js";

const FILE_NAME = "identity.json";

function readPackage(installPackage) {
  let value = installPackage;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new KeystoreError(
        "KEYSTORE_CORRUPT",
        "The install package is not valid JSON",
        { cause: error },
      );
    }
  }
  if (
    !value ||
    value.format !== "ai-auth-agent-install" ||
    value.version !== 1 ||
    typeof value.walletId !== "string" ||
    typeof value.instanceId !== "string" ||
    typeof value.backup !== "string" ||
    !value.binding
  )
    throw new KeystoreError(
      "KEYSTORE_CORRUPT",
      "The install package has an unsupported or damaged format",
    );
  return value;
}

/**
 * @param {object} options
 * @param {string} options.dir directory for the agent keystore
 * @param {object|string} options.installPackage install package from the site
 * @param {string} options.passphrase recovery passphrase for the backup
 * @param {boolean} [options.replace] archive an existing identity first
 */
export async function installAgentIdentity({
  dir,
  installPackage,
  passphrase,
  replace = false,
} = {}) {
  if (typeof dir !== "string" || !dir)
    throw new TypeError("A keystore directory is required");
  const pkg = readPackage(installPackage);
  const binding = await verifyInstanceBinding(pkg.binding);
  if (
    !binding.ok ||
    binding.instanceId !== pkg.instanceId ||
    binding.walletId !== pkg.walletId
  )
    throw new KeystoreError(
      "KEYSTORE_CORRUPT",
      "The instance binding does not match the install package",
    );

  const text = await agentKeystoreFromWalletBackup({
    backupText: pkg.backup,
    passphrase,
    instanceId: pkg.instanceId,
  });
  const root = path.resolve(dir);
  const file = path.join(root, FILE_NAME);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  let existed = false;
  try {
    await stat(file);
    existed = true;
  } catch {}
  if (existed && !replace)
    throw new KeystoreError(
      "KEYSTORE_EXISTS",
      "An identity already exists here; pass replace to archive it first",
    );
  if (existed) {
    const archive = path.join(root, `identity.${Date.now()}.replaced.json`);
    await writeFile(archive, await readFile(file, "utf8"), { mode: 0o600 });
  }
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  return Object.freeze({
    id: pkg.walletId,
    name: typeof pkg.name === "string" ? pkg.name : "agent",
    instanceId: pkg.instanceId,
    file,
    site: pkg.site ?? null,
  });
}
