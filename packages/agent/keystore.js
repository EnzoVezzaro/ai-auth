import { webcrypto, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  canonicalize,
  identityFor,
  randomNonce,
  signEnvelope,
  verifyEnvelope,
} from "@enzovezzaro/ai-auth-wallet";
import { promptSecret } from "./prompt.js";

const { subtle } = webcrypto;
const encoder = new TextEncoder();
const FORMAT = "ai-auth-agent-keystore";
const ITERATIONS = 310_000;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const FILE_NAME = "identity.json";
const ENV_NAME = "AI_AUTH_PASSPHRASE";
const INSTANCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const signers = new WeakMap();

export class KeystoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "KeystoreError";
    this.code = code;
  }
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64 = (text) => {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/u.test(text))
    throw new TypeError("bad base64url");
  return new Uint8Array(Buffer.from(text, "base64url"));
};

async function deriveKey(passphrase, salt) {
  const material = await subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const aad = (instanceId) => encoder.encode(`${FORMAT}|1|${instanceId}`);

async function seal({ metadata, privateJwk }, passphrase) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const body = encoder.encode(canonicalize({ metadata, privateJwk }));
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(metadata.instanceId) },
    key,
    body,
  );
  return JSON.stringify({
    format: FORMAT,
    version: 1,
    instanceId: metadata.instanceId,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: ITERATIONS,
      salt: b64(salt),
    },
    cipher: { name: "AES-GCM", iv: b64(iv), ciphertext: b64(ciphertext) },
  });
}

function parseDocument(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new KeystoreError(
      "KEYSTORE_CORRUPT",
      "The keystore file is not valid JSON; it was left untouched",
      { cause: error },
    );
  }
  const ok =
    doc?.format === FORMAT &&
    doc.version === 1 &&
    INSTANCE_PATTERN.test(doc.instanceId ?? "") &&
    doc.kdf?.iterations === ITERATIONS &&
    typeof doc.kdf.salt === "string" &&
    typeof doc.cipher?.iv === "string" &&
    typeof doc.cipher.ciphertext === "string";
  if (!ok)
    throw new KeystoreError(
      "KEYSTORE_CORRUPT",
      "The keystore file has an unsupported or damaged format; it was left untouched",
    );
  return doc;
}

async function openDocument(text, passphrase) {
  const doc = parseDocument(text);
  try {
    const key = await deriveKey(passphrase, unb64(doc.kdf.salt));
    const plain = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64(doc.cipher.iv),
        additionalData: aad(doc.instanceId),
      },
      key,
      unb64(doc.cipher.ciphertext),
    );
    const payload = JSON.parse(new TextDecoder().decode(plain));
    if (payload.metadata?.instanceId !== doc.instanceId)
      throw new Error("instance mismatch");
    return payload;
  } catch (error) {
    throw new KeystoreError(
      "KEYSTORE_UNLOCK_FAILED",
      "Could not unlock the keystore: wrong passphrase or damaged file",
      { cause: error },
    );
  }
}

async function buildWallet({ metadata, privateJwk }) {
  if ((await identityFor(metadata.publicKey)) !== metadata.id)
    throw new KeystoreError(
      "KEYSTORE_CORRUPT",
      "Keystore identity does not match its public key",
    );
  const privateKey = await subtle.importKey("jwk", privateJwk, ECDSA, false, [
    "sign",
  ]);
  const { id, name, instanceId, publicKey } = metadata;
  const signer = Object.freeze({ id, publicKey, privateKey });
  const wallet = Object.freeze({
    id,
    name,
    instanceId,
    publicKey,
    sign: (type, payload) => signEnvelope(signer, type, payload),
  });
  signers.set(wallet, signer);
  const probe = await wallet.sign("wallet/recovery-check", {
    nonce: randomNonce(),
  });
  if (!(await verifyEnvelope(probe, { expectedIssuer: id })))
    throw new KeystoreError(
      "KEYSTORE_CORRUPT",
      "Keystore key did not match its identity",
    );
  return wallet;
}

/**
 * Package-internal: the non-extractable signing key P2PRoom needs. Not part of
 * the public entry point; the key bytes can never be read from it.
 */
export function signingIdentityFor(wallet) {
  const signer = signers.get(wallet);
  if (!signer) throw new TypeError("Not a keystore wallet");
  return signer;
}

async function generateMetadata(name) {
  const pair = await subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const privateJwk = await subtle.exportKey("jwk", pair.privateKey);
  const publicKey = await subtle.exportKey("jwk", pair.publicKey);
  const label =
    String(name ?? "agent")
      .trim()
      .slice(0, 60) || "agent";
  const metadata = {
    id: await identityFor(publicKey),
    name: label,
    instanceId: randomUUID(),
    createdAt: new Date().toISOString(),
    publicKey,
  };
  return { metadata, privateJwk };
}

async function writePrivate(file, text, { exclusive = false } = {}) {
  const temp = `${file}.${randomNonce().slice(0, 8)}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
  await chmod(temp, 0o600);
  try {
    if (exclusive && (await exists(file)))
      throw new KeystoreError(
        "KEYSTORE_EXISTS",
        "A keystore already exists here",
      );
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new KeystoreError(
      "KEYSTORE_UNAVAILABLE",
      `Keystore is unavailable (${error.code ?? "error"})`,
      { cause: error },
    );
  }
}

async function assertPrivate(file) {
  if (process.platform === "win32") return;
  const { mode } = await stat(file);
  if (mode & 0o077)
    throw new KeystoreError(
      "KEYSTORE_PERMISSIONS",
      `Keystore permissions are too open (${(mode & 0o777).toString(8)}); run chmod 600 on it`,
    );
}

/**
 * One wallet per agent instance, encrypted at rest in `<dir>/identity.json`
 * (mode 0600, dir 0700). Never overwrites an existing or corrupted file.
 */
export function createFileKeystore({
  dir,
  passphrase,
  env = process.env,
  prompt,
} = {}) {
  if (typeof dir !== "string" || dir.length === 0)
    throw new TypeError("A keystore directory is required");
  const root = path.resolve(dir);
  const file = path.join(root, FILE_NAME);

  async function secret({ confirmLength = false } = {}) {
    let value =
      typeof passphrase === "function" ? await passphrase() : passphrase;
    value ??= env[ENV_NAME] || undefined;
    if (value === undefined)
      value = await (prompt ?? ((q) => promptSecret(q)))(
        "Keystore passphrase: ",
      ).catch(() => undefined);
    if (typeof value !== "string" || value.length === 0)
      throw new KeystoreError(
        "KEYSTORE_PASSPHRASE",
        `A keystore passphrase is required (set ${ENV_NAME} or enter it at a TTY prompt)`,
      );
    if (confirmLength && value.length < 12)
      throw new KeystoreError(
        "KEYSTORE_PASSPHRASE",
        "Use a passphrase with at least 12 characters",
      );
    return value;
  }

  async function ensureDir() {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700);
    } catch (error) {
      throw new KeystoreError(
        "KEYSTORE_UNAVAILABLE",
        `Keystore directory is unavailable (${error.code ?? "error"})`,
        { cause: error },
      );
    }
  }

  async function readFileChecked() {
    if (!(await exists(file)))
      throw new KeystoreError(
        "KEYSTORE_MISSING",
        "No keystore found; create one first",
      );
    await assertPrivate(file);
    return readFile(file, "utf8");
  }

  const api = {
    dir: root,
    file,
    exists: () => exists(file),
    async create({ name } = {}) {
      const pass = await secret({ confirmLength: true });
      await ensureDir();
      if (await exists(file))
        throw new KeystoreError(
          "KEYSTORE_EXISTS",
          "A keystore already exists here; it was not modified",
        );
      const material = await generateMetadata(name);
      await writePrivate(file, await seal(material, pass), { exclusive: true });
      return buildWallet(material);
    },
    async unlock() {
      const text = await readFileChecked();
      return buildWallet(await openDocument(text, await secret()));
    },
    async rotate({ name } = {}) {
      const text = await readFileChecked();
      const pass = await secret({ confirmLength: true });
      const previous = await openDocument(text, pass);
      const material = await generateMetadata(name ?? previous.metadata.name);
      const archive = path.join(root, `identity.${Date.now()}.rotated.json`);
      await writePrivate(archive, text);
      await writePrivate(file, await seal(material, pass));
      return buildWallet(material);
    },
    async backup(target) {
      const text = await readFileChecked();
      parseDocument(text);
      await writePrivate(path.resolve(target), text, { exclusive: true });
    },
    async restore(source, { replace = false } = {}) {
      const text = await readFile(path.resolve(source), "utf8");
      const payload = await openDocument(text, await secret());
      const wallet = await buildWallet(payload);
      await ensureDir();
      if (await exists(file)) {
        if (!replace)
          throw new KeystoreError(
            "KEYSTORE_EXISTS",
            "A keystore already exists here; pass replace to archive it first",
          );
        await writePrivate(
          path.join(root, `identity.${Date.now()}.replaced.json`),
          await readFile(file, "utf8"),
        );
      }
      await writePrivate(file, text);
      return wallet;
    },
    async delete() {
      await rm(file, { force: true });
    },
  };
  return Object.freeze(api);
}
