const encoder = new TextEncoder();
const STORAGE_NAME = "ai-auth-wallet-v2";
const STORAGE_VERSION = 1;
const MAX_EVENT_AGE_MS = 120_000;
const MAX_SEEN_EVENTS = 4096;
const MAX_ACTIVITY_ITEMS = 100;

function cryptoApi() {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable");
  return globalThis.crypto;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Invalid base64url value");
  }
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function assertUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new TypeError("Unpaired Unicode surrogate");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Unpaired Unicode surrogate");
    }
  }
}

// RFC 8785 JSON Canonicalization Scheme for ordinary JSON values.
export function canonicalize(value) {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const values = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index))
        throw new TypeError(
          "Sparse arrays are outside the supported JSON data model",
        );
      values.push(canonicalize(value[index]));
    }
    return `[${values.join(",")}]`;
  }
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Value is outside the supported JSON data model");
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${canonicalize(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

export function randomNonce() {
  return base64url(cryptoApi().getRandomValues(new Uint8Array(24)));
}

export async function identityFor(publicKey) {
  if (
    publicKey?.kty !== "EC" ||
    publicKey?.crv !== "P-256" ||
    !publicKey.x ||
    !publicKey.y
  ) {
    throw new TypeError("Expected an ECDSA P-256 public JWK");
  }
  const material = {
    crv: publicKey.crv,
    kty: publicKey.kty,
    x: publicKey.x,
    y: publicKey.y,
  };
  const digest = await cryptoApi().subtle.digest(
    "SHA-256",
    encoder.encode(canonicalize(material)),
  );
  return `agent:${base64url(digest)}`;
}

function openDatabase() {
  if (!globalThis.indexedDB)
    throw new Error("IndexedDB is unavailable in this browser");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_NAME, STORAGE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("wallets"))
        db.createObjectStore("wallets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("activity"))
        db.createObjectStore("activity", {
          keyPath: "sequence",
          autoIncrement: true,
        });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deriveBackupKey(passphrase, salt) {
  const material = await cryptoApi().subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return cryptoApi().subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptPrivateKey(privateJwk, metadata, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    throw new Error("Choose a recovery passphrase with at least 12 characters");
  }
  const salt = cryptoApi().getRandomValues(new Uint8Array(16));
  const iv = cryptoApi().getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt);
  const plaintext = encoder.encode(canonicalize({ metadata, privateJwk }));
  const ciphertext = await cryptoApi().subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return JSON.stringify({
    format: "ai-auth-wallet-backup",
    version: 1,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: 310_000,
      salt: base64url(salt),
    },
    cipher: {
      name: "AES-GCM",
      iv: base64url(iv),
      ciphertext: base64url(ciphertext),
    },
  });
}

export async function createWallet({ name, passphrase }) {
  const label = String(name ?? "")
    .trim()
    .slice(0, 60);
  if (!label) throw new Error("Enter a wallet name");
  const pair = await cryptoApi().subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await cryptoApi().subtle.exportKey("jwk", pair.privateKey);
  const publicKey = await cryptoApi().subtle.exportKey("jwk", pair.publicKey);
  const id = await identityFor(publicKey);
  const createdAt = new Date().toISOString();
  const metadata = { id, name: label, createdAt, publicKey };
  const backup = await encryptPrivateKey(privateJwk, metadata, passphrase);
  const privateKey = await cryptoApi().subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  privateJwk.d = "";
  const wallet = makeWallet({ ...metadata, privateKey, backup });
  await saveWallet(wallet);
  return wallet;
}

function makeWallet({ id, name, createdAt, publicKey, privateKey, backup }) {
  return {
    id,
    name,
    createdAt,
    publicKey,
    privateKey,
    backup,
    sign: async (type, payload) =>
      signEnvelope({ id, publicKey, privateKey }, type, payload),
  };
}

export async function loadWallet() {
  const db = await openDatabase();
  try {
    const record = await idbRequest(
      db.transaction("wallets").objectStore("wallets").get("primary"),
    );
    return record ? makeWallet({ ...record, id: record.identity }) : null;
  } finally {
    db.close();
  }
}

async function saveWallet(wallet) {
  const db = await openDatabase();
  try {
    const transaction = db.transaction("wallets", "readwrite");
    transaction.objectStore("wallets").put({
      id: "primary",
      name: wallet.name,
      createdAt: wallet.createdAt,
      publicKey: wallet.publicKey,
      privateKey: wallet.privateKey,
      backup: wallet.backup,
      identity: wallet.id,
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Wallet storage was aborted"));
    });
  } finally {
    db.close();
  }
}

export async function importWalletBackup(backupText, passphrase) {
  let backup;
  try {
    backup = JSON.parse(backupText);
  } catch {
    throw new Error("Recovery file is not valid JSON");
  }
  if (
    backup?.format !== "ai-auth-wallet-backup" ||
    backup.version !== 1 ||
    backup.kdf?.iterations !== 310_000
  ) {
    throw new Error("Unsupported AI Auth wallet recovery file");
  }
  try {
    const key = await deriveBackupKey(
      passphrase,
      decodeBase64url(backup.kdf.salt),
    );
    const plaintext = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64url(backup.cipher.iv) },
      key,
      decodeBase64url(backup.cipher.ciphertext),
    );
    const { metadata, privateJwk } = JSON.parse(
      new TextDecoder().decode(plaintext),
    );
    if ((await identityFor(metadata.publicKey)) !== metadata.id)
      throw new Error("Recovery identity does not match its public key");
    const privateKey = await cryptoApi().subtle.importKey(
      "jwk",
      privateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const wallet = makeWallet({ ...metadata, privateKey, backup: backupText });
    const probe = await wallet.sign("wallet/recovery-check", {
      nonce: randomNonce(),
    });
    if (!(await verifyEnvelope(probe, { expectedIssuer: wallet.id })))
      throw new Error("Recovery key did not match wallet identity");
    await saveWallet(wallet);
    return wallet;
  } catch (error) {
    throw new Error(
      "Could not unlock this recovery file; check the passphrase and file",
      { cause: error },
    );
  }
}

export async function forgetWallet() {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(["wallets", "activity"], "readwrite");
    transaction.objectStore("wallets").clear();
    transaction.objectStore("activity").clear();
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Wallet removal was aborted"));
    });
  } finally {
    db.close();
  }
}

export function downloadBackup(wallet) {
  return wallet.backup;
}

export async function signEnvelope(identity, type, payload) {
  if (typeof type !== "string" || !/^[a-z0-9][a-z0-9/._-]{1,63}$/u.test(type))
    throw new Error("Invalid signed record type");
  const body = {
    protocol: "ai-auth-wallet",
    version: 1,
    type,
    issuer: identity.id,
    createdAt: new Date().toISOString(),
    payload,
  };
  const signature = await cryptoApi().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.privateKey,
    encoder.encode(canonicalize(body)),
  );
  return {
    body,
    proof: {
      algorithm: "ECDSA-P256-SHA256",
      publicKey: identity.publicKey,
      signature: base64url(signature),
    },
  };
}

export async function verifyEnvelope(
  envelope,
  { expectedIssuer, now = Date.now(), maxAgeMs = MAX_EVENT_AGE_MS } = {},
) {
  try {
    const { body, proof } = envelope;
    if (
      body.protocol !== "ai-auth-wallet" ||
      body.version !== 1 ||
      typeof body.createdAt !== "string"
    )
      return false;
    const time = Date.parse(body.createdAt);
    if (!Number.isFinite(time) || time > now + 30_000 || now - time > maxAgeMs)
      return false;
    if (
      proof.algorithm !== "ECDSA-P256-SHA256" ||
      (await identityFor(proof.publicKey)) !== body.issuer
    )
      return false;
    if (expectedIssuer && body.issuer !== expectedIssuer) return false;
    const publicKey = await cryptoApi().subtle.importKey(
      "jwk",
      proof.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return cryptoApi().subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decodeBase64url(proof.signature),
      encoder.encode(canonicalize(body)),
    );
  } catch {
    return false;
  }
}

export async function appendActivity(wallet, type, payload) {
  const envelope = await signEnvelope(wallet, type, payload);
  const db = await openDatabase();
  try {
    const transaction = db.transaction("activity", "readwrite");
    const activity = transaction.objectStore("activity");
    const added = activity.add(envelope);
    added.onsuccess = () => {
      const count = activity.count();
      count.onsuccess = () => {
        let excess = count.result - MAX_ACTIVITY_ITEMS;
        if (excess <= 0) return;
        const cursorRequest = activity.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || excess <= 0) return;
          cursor.delete();
          excess -= 1;
          cursor.continue();
        };
      };
    };
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
  return envelope;
}

export async function readActivity() {
  const db = await openDatabase();
  try {
    return await idbRequest(
      db.transaction("activity").objectStore("activity").getAll(),
    );
  } finally {
    db.close();
  }
}

export { MAX_EVENT_AGE_MS, MAX_SEEN_EVENTS };
export {
  createPermissionRequest,
  approvePermissionRequest,
  verifyPermissionRequest,
  verifyPopupPermissionRequest,
  verifyPermissionConsent,
  NonceGuard,
} from "./connect.js";
export {
  createCapabilityGrant,
  verifyCapabilityGrant,
} from "./capabilities.js";
export { P2PRoom, ManualWebRTC } from "./p2p.js";
