#!/usr/bin/env node
// Independent, rerunnable verification of the did:key adapter in
// packages/p2p/did.js using implementations installed OUTSIDE this repo.
//
// This script imports the AI Auth adapter from the repo, but every
// verification primitive (base58btc, multicodec table, did:key resolution)
// is loaded from an external node_modules directory supplied with
// --modules-dir. No dependency is added to this repository.
//
// Usage:
//   mkdir -p <dir> && cd <dir> && npm init -y >/dev/null && \
//     npm install multiformats@14.0.6 multicodec@3.2.1 \
//       key-did-resolver@4.0.0 did-resolver@6.0.0
//   node scripts/verify-did-key.mjs --modules-dir <dir>/node_modules
//
// See docs/evidence/did-key-verification.md for the full evidence record.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

globalThis.crypto ??= webcrypto;

const ADAPTER_URL = new URL("../packages/p2p/did.js", import.meta.url);

function modulesDirFrom(argv) {
  const index = argv.indexOf("--modules-dir");
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  return process.env.DID_VERIFY_MODULES_DIR;
}

const modulesDir = modulesDirFrom(process.argv.slice(2));
if (!modulesDir) {
  console.error(
    "ERROR: supply --modules-dir <dir>/node_modules (or DID_VERIFY_MODULES_DIR) " +
      "pointing at an external install of multiformats, multicodec, " +
      "key-did-resolver and did-resolver.",
  );
  process.exit(2);
}

// Resolve specifiers from the EXTERNAL directory, never from this repo.
const externalRequire = createRequire(path.join(modulesDir, "noop.js"));
async function loadExternal(specifier) {
  const resolved = externalRequire.resolve(specifier);
  return import(pathToFileURL(resolved).href);
}

const [
  { didKeyForPublicJwk, resolveDidKey, didKeyMatchesJwk },
  base58,
  multicodecMod,
  keyDid,
  didResolverMod,
] = await Promise.all([
  import(ADAPTER_URL.href),
  loadExternal("multiformats/bases/base58"),
  loadExternal("multicodec"),
  loadExternal("key-did-resolver"),
  loadExternal("did-resolver"),
]);

const base58btc = base58.base58btc;
const multicodec = multicodecMod.default;
const externalResolver = new didResolverMod.Resolver(keyDid.getResolver());

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", detail: error.message });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", detail: error.message });
  }
}
const jwkOf = (jwk) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });

console.log("== version manifest (external modules) ==");
for (const name of [
  "multiformats",
  "multicodec",
  "key-did-resolver",
  "did-resolver",
]) {
  const pkg = JSON.parse(
    readFileSync(path.join(modulesDir, name, "package.json"), "utf8"),
  );
  console.log(`  ${name}@${pkg.version}`);
}
console.log("");

// ---- multicodec constant cross-check (authoritative external table) ----
const P256_CODE = multicodec.P256_PUB;
const P256_VARINT = Buffer.from(multicodec.getVarint(P256_CODE)).toString(
  "hex",
);
check("external multicodec p256-pub numeric code is 0x1200", () =>
  assert.equal(P256_CODE, 0x1200),
);
check("external multicodec p256-pub varint bytes are 8024", () =>
  assert.equal(P256_VARINT, "8024"),
);
check("external table name for 0x1200 is p256-pub", () =>
  assert.equal(multicodec.getName(0x1200), "p256-pub"),
);
check("'a4 01' is NOT the p256-pub varint (decodes to unmapped 0xa4)", () => {
  const code = multicodec.getCode(Uint8Array.of(0xa4, 0x01));
  assert.equal(code, 0xa4);
  assert.notEqual(code, 0x1200);
  // 0xa4 has no name in the external table, proving it is not p256-pub.
  assert.throws(() => multicodec.getCodec(Uint8Array.of(0xa4, 0x01)));
});

// ---- generate several P-256 JWKs locally with Node Web Crypto ----
async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return jwkOf(exported);
}

const KEYS = [];
for (let i = 0; i < 6; i += 1) KEYS.push(await makeKey());

for (let i = 0; i < KEYS.length; i += 1) {
  const jwk = KEYS[i];
  const label = `key[${i}]`;
  const did = didKeyForPublicJwk(jwk);

  check(`${label}: DID shape`, () =>
    assert.match(did, /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u),
  );

  // External base58btc decode + external multicodec codec check.
  const raw = base58btc.decode(did.slice("did:key:".length));
  check(`${label}: external base58btc decode -> 35 bytes`, () =>
    assert.equal(raw.length, 35),
  );
  check(`${label}: external multicodec codec == 0x1200`, () => {
    assert.equal(multicodec.getCode(raw), 0x1200);
    assert.equal(multicodec.getCodec(raw), "p256-pub");
  });
  check(`${label}: raw prefix bytes == 8024`, () =>
    assert.equal(Buffer.from(raw.slice(0, 2)).toString("hex"), "8024"),
  );

  // Full external did:key resolution to a verification method JWK.
  await checkAsync(
    `${label}: external key-did-resolver JWK == original`,
    async () => {
      const doc = await externalResolver.resolve(did);
      assert.equal(doc.didResolutionMetadata.error, undefined);
      const vm = doc.didDocument.verificationMethod[0];
      assert.deepEqual(jwkOf(vm.publicKeyJwk), jwk);
    },
  );

  // Adapter's own resolution + match predicate.
  check(`${label}: adapter resolveDidKey == original`, () =>
    assert.deepEqual(resolveDidKey(did), jwk),
  );
  check(`${label}: adapter didKeyMatchesJwk true`, () =>
    assert.equal(didKeyMatchesJwk(did, jwk), true),
  );
}

// ---- rejection cases via the adapter's public API ----
const base = KEYS[0];
const other = KEYS[1];
const baseDid = didKeyForPublicJwk(base);

check("wrong curve P-384 rejected", () =>
  assert.throws(
    () => didKeyForPublicJwk({ kty: "EC", crv: "P-384", x: base.x, y: base.y }),
    TypeError,
  ),
);
check("wrong kty OKP/Ed25519 rejected", () =>
  assert.throws(
    () =>
      didKeyForPublicJwk({ kty: "OKP", crv: "Ed25519", x: base.x, y: base.y }),
    TypeError,
  ),
);
check("malformed x coordinate rejected", () =>
  assert.throws(
    () => didKeyForPublicJwk({ ...base, x: base.x.slice(0, 10) }),
    TypeError,
  ),
);
check("mismatched JWK returns false", () =>
  assert.equal(didKeyMatchesJwk(baseDid, other), false),
);
check("arbitrary string is not a DID", () =>
  assert.throws(() => resolveDidKey("agent:abc"), TypeError),
);
check("empty multibase rejected", () =>
  assert.throws(() => resolveDidKey("did:key:z"), TypeError),
);

// Build a DID with the (incorrect) "a4 01" prefix using the EXTERNAL encoder.
const wrongPrefixRaw = Uint8Array.of(0xa4, 0x01, ...raw0().slice(2));
function raw0() {
  return base58btc.decode(didKeyForPublicJwk(base).slice("did:key:".length));
}
const wrongPrefixDid = "did:key:" + base58btc.encode(wrongPrefixRaw);
check("'a4 01' prefix DID rejected by adapter", () =>
  assert.throws(() => resolveDidKey(wrongPrefixDid), TypeError),
);
const secpRaw = Uint8Array.of(0xe7, 0x01, ...raw0().slice(2));
check("secp256k1 (e7 01) prefix DID rejected by adapter", () =>
  assert.throws(
    () => resolveDidKey("did:key:" + base58btc.encode(secpRaw)),
    TypeError,
  ),
);

// ---- report ----
console.log("== results ==");
for (const r of results) {
  console.log(`  [${r.status}] ${r.name}${r.detail ? " -- " + r.detail : ""}`);
}
const failures = results.filter((r) => r.status !== "PASS");
console.log("");
console.log(
  `RESULT: ${failures.length === 0 ? "PASS" : "FAIL"} (${results.length - failures.length}/${results.length} checks passed)`,
);
if (failures.length) process.exitCode = 1;
