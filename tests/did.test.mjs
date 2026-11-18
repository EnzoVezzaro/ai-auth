import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  didKeyForPublicJwk,
  didKeyMatchesJwk,
  identityFor,
  publicJwkFromDid,
  resolveDidKey,
} from "../packages/p2p/index.js";

globalThis.crypto ??= webcrypto;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DID_PREFIX = "did:key:z";
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

function decodeBase58btc(text) {
  let value = 0n;
  for (const character of text) {
    const digit = ALPHABET.indexOf(character);
    assert.notEqual(digit, -1, `bad base58 character ${character}`);
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function encodeBase58btc(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let text = "";
  while (value > 0n) {
    text = ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  return text;
}

const didOf = (bytes) => DID_PREFIX + encodeBase58btc(bytes);
const rawOf = (did) => decodeBase58btc(did.slice(DID_PREFIX.length));
const jwkOf = (vector) => ({
  kty: "EC",
  crv: "P-256",
  x: vector.x,
  y: vector.y,
});

// Known-answer vectors. The first DID is the W3C did:key spec P-256 test
// vector; its compressed point and JWK were independently derived from the
// DID bytes using Node Web Crypto's raw compressed-point import, which also
// covers both even-y (0x02) and odd-y (0x03) SEC1 prefixes.
const VECTORS = [
  {
    did: "did:key:zDnaerx9CtbPJ1q36T5Ln5wYt3MQYeGRG5ehnPAmxcf5mDZpv",
    compressed:
      "038a0ac59a2d3086e8a12a78fd4773a6d52a0ca61ef6c1419e15a05bcc6dafce7b",
    x: "igrFmi0whuihKnj9R3Om1SoMph72wUGeFaBbzG2vzns",
    y: "efsX5b10x8yjyrj4ny3pGfLcY7Xby1KzgqOdqnsrJIM",
  },
  {
    did: "did:key:zDnaeUKTWUXc1HDpGfKbEK4VRpw8FJVDExddoNqfJW3kJyqzn",
    compressed:
      "0239c3dd74131729446dc1b3da69a8751bbe7e9e8ba2b0b9ad2fda9a69a23d0e87",
    x: "OcPddBMXKURtwbPaaah1G75-nouisLmtL9qaaaI9Doc",
    y: "AXuQgg5s3wXfkmz_xAyhXvWDqvvpyxaoshDekbb47sg",
  },
  {
    did: "did:key:zDnaembgSGUhZULN2Caob4HLJPaxBh92N7rtH21TErzqf8HQo",
    compressed:
      "033a8273eece6b0d82e95c3506617db5000e14ff0023325d0bb0274918bc6a6cdc",
    x: "OoJz7s5rDYLpXDUGYX21AA4U_wAjMl0LsCdJGLxqbNw",
    y: "1dTCts1IylLFZQ-y2ABHc4x7hifNanA1rXgPFTZp-tU",
  },
];

async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    jwk: { kty: "EC", crv: "P-256", x: exported.x, y: exported.y },
    privateKey: pair.privateKey,
  };
}

test("JWK -> did:key -> JWK round-trips for generated P-256 keys", async () => {
  for (let index = 0; index < 8; index += 1) {
    const { jwk, privateKey } = await makeKey();
    const did = didKeyForPublicJwk(jwk);
    assert.match(did, /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u);
    const resolved = resolveDidKey(did);
    assert.deepEqual(resolved, jwk);
    assert.deepEqual(publicJwkFromDid(did), jwk);
    assert.equal(didKeyMatchesJwk(did, jwk), true);
    assert.equal(didKeyForPublicJwk(resolved), did);

    // The resolved public key must still verify a signature from the key.
    const data = new TextEncoder().encode(`round-${index}`);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      data,
    );
    const verifyKey = await crypto.subtle.importKey(
      "jwk",
      resolved,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    assert.equal(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifyKey,
        signature,
        data,
      ),
      true,
    );
  }
});

test("known-answer vectors fix the SEC1, multicodec and base58btc bytes", () => {
  for (const vector of VECTORS) {
    const jwk = jwkOf(vector);
    assert.equal(didKeyForPublicJwk(jwk), vector.did);
    assert.deepEqual(resolveDidKey(vector.did), jwk);
    assert.equal(didKeyMatchesJwk(vector.did, jwk), true);
    const raw = rawOf(vector.did);
    assert.equal(raw.length, 35);
    assert.equal(Buffer.from(raw.slice(0, 2)).toString("hex"), "8024");
    assert.equal(Buffer.from(raw.slice(2)).toString("hex"), vector.compressed);
    assert.equal(b64u(raw.slice(3)), vector.x);
    assert.equal(raw[2] & 1, Buffer.from(vector.y, "base64url").at(-1) & 1);
  }
});

test("point decompression matches Web Crypto for even and odd y", async () => {
  const parities = new Set();
  for (const vector of VECTORS) {
    const compressed = rawOf(vector.did).slice(2);
    const key = await crypto.subtle.importKey(
      "raw",
      compressed,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const oracle = await crypto.subtle.exportKey("jwk", key);
    parities.add(compressed[0]);
    assert.equal(oracle.x, vector.x);
    assert.equal(oracle.y, vector.y);
    assert.deepEqual(resolveDidKey(vector.did), {
      kty: "EC",
      crv: "P-256",
      x: oracle.x,
      y: oracle.y,
    });
  }
  assert.deepEqual([...parities].sort(), [0x02, 0x03]);
});

test("wrong curve or key type is rejected", () => {
  const { x, y } = VECTORS[0];
  assert.throws(
    () => didKeyForPublicJwk({ kty: "EC", crv: "P-384", x, y }),
    TypeError,
  );
  assert.throws(
    () => didKeyForPublicJwk({ kty: "RSA", crv: "P-256", x, y }),
    TypeError,
  );
  assert.throws(
    () => didKeyForPublicJwk({ kty: "OKP", crv: "Ed25519", x, y }),
    TypeError,
  );
  assert.throws(() => didKeyForPublicJwk(null), TypeError);
});

test("malformed x/y coordinates are rejected", () => {
  const { x, y } = VECTORS[0];
  const short = b64u(new Uint8Array(31));
  const long = b64u(new Uint8Array(33));
  const invalid = [
    { x: short, y },
    { x: long, y },
    { x, y: short },
    { x, y: long },
    { x: "not!base64", y },
    { x, y: 42 },
    { y },
    { x },
  ];
  for (const coords of invalid)
    assert.throws(
      () => didKeyForPublicJwk({ kty: "EC", crv: "P-256", ...coords }),
      TypeError,
    );
});

test("a DID does not match a different or mutated key", () => {
  const jwkA = jwkOf(VECTORS[0]);
  const jwkB = jwkOf(VECTORS[1]);
  const didA = didKeyForPublicJwk(jwkA);
  assert.equal(didKeyMatchesJwk(didA, jwkB), false);
  assert.equal(didKeyMatchesJwk(didA, { ...jwkA, x: jwkB.x }), false);
  assert.equal(didKeyMatchesJwk(didA, { ...jwkA, y: jwkB.y }), false);
  assert.equal(didKeyMatchesJwk(didKeyForPublicJwk(jwkB), jwkA), false);
  assert.equal(didKeyMatchesJwk("not-a-did", jwkA), false);
  assert.notDeepEqual(resolveDidKey(didA), jwkB);
});

test("malformed DIDs, wrong codec and bad points are rejected", () => {
  const raw = rawOf(VECTORS[0].did);
  assert.throws(() => resolveDidKey("agent:abc"), TypeError);
  assert.throws(() => resolveDidKey("did:key:z0OIl"), TypeError);
  assert.throws(() => resolveDidKey("did:key:z"), TypeError);
  assert.throws(
    () => resolveDidKey(`did:key:z1${VECTORS[0].did.slice(DID_PREFIX.length)}`),
    TypeError,
  );
  // "a4 01" is sometimes mistaken for the p256-pub prefix; it is not it.
  assert.throws(
    () => resolveDidKey(didOf(Uint8Array.of(0xa4, 0x01, ...raw.slice(2)))),
    TypeError,
  );
  assert.throws(
    () => resolveDidKey(didOf(Uint8Array.of(0xed, 0x01, ...raw.slice(2)))),
    TypeError,
  );
  assert.throws(
    () =>
      resolveDidKey(didOf(Uint8Array.of(0x80, 0x24, 0x04, ...raw.slice(3)))),
    TypeError,
  );
  assert.throws(() => resolveDidKey(didOf(raw.slice(0, -1))), TypeError);
  assert.throws(
    () =>
      resolveDidKey(
        didOf(
          Uint8Array.of(0x80, 0x24, 0x02, ...new Uint8Array(32).fill(0xff)),
        ),
      ),
    TypeError,
  );
});

test("the legacy agent: identity is unchanged before and after deriving a DID", async () => {
  const { jwk } = await makeKey();
  const before = await identityFor(jwk);
  assert.match(before, /^agent:[A-Za-z0-9_-]+$/u);
  const did = didKeyForPublicJwk(jwk);
  assert.equal(await identityFor(jwk), before);
  assert.equal(await identityFor(resolveDidKey(did)), before);
  assert.notEqual(did, before);
});

test("derivation never reads private key material", async () => {
  const { jwk, privateKey } = await makeKey();
  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);
  assert.equal(typeof privateJwk.d, "string");
  const expected = didKeyForPublicJwk(jwk);
  assert.equal(didKeyForPublicJwk({ ...jwk, d: privateJwk.d }), expected);
  const poisoned = {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    get d() {
      throw new Error("private key material was read");
    },
  };
  const did = didKeyForPublicJwk(poisoned);
  assert.equal(did, expected);
  const resolved = resolveDidKey(did);
  assert.deepEqual(Object.keys(resolved).sort(), ["crv", "kty", "x", "y"]);
  assert.equal("d" in resolved, false);
});
