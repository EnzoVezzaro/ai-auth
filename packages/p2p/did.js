// did:key adapter for the wallet's public P-256 JWK.
//
// Additive and self-contained: this module only consumes the *public* JWK
// (kty/crv/x/y). It never reads private key material and does not touch the
// legacy `agent:` identifier, stored sessions, wire formats or keys.
//
// Encoding (W3C did:key / multiformats), for P-256:
//   compressed SEC1 point = (y even ? 0x02 : 0x03) || x (32 bytes)
//   multicodec varint     = 0x80 0x24  (p256-pub, code 0x1200)
//   multibase             = "z" + base58btc(varint || compressed)
//   DID                   = "did:key:" + multibase
//
// Some documents write the p256-pub code as "0x8024"; that is the two
// varint *bytes* 80 24, not the numeric code. The numeric code is 0x1200.

const DID_PREFIX = "did:key:z";
const P256_PUB_CODE = 0x1200;
const P256_PUB_VARINT = Uint8Array.of(0x80, 0x24);
const COORD_BYTES = 32;
const POINT_BYTES = 1 + COORD_BYTES;
const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// NIST P-256 domain parameters: y^2 = x^3 - 3x + b (mod p).
const P = BigInt(
  "0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
);
const A = P - 3n;
const B = BigInt(
  "0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b",
);
const Y_EXPONENT = (P + 1n) / 4n; // p ≡ 3 (mod 4), so this is a sqrt exponent

function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64urlDecode(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new TypeError(`Invalid base64url ${field}`);
  const binary = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length !== COORD_BYTES || base64urlEncode(bytes) !== value)
    throw new TypeError(`Invalid P-256 ${field} coordinate`);
  return bytes;
}

function requirePublicJwk(jwk) {
  if (
    !jwk ||
    typeof jwk !== "object" ||
    Array.isArray(jwk) ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256"
  )
    throw new TypeError("Expected an EC P-256 public JWK");
  return {
    x: base64urlDecode(jwk.x, "x"),
    y: base64urlDecode(jwk.y, "y"),
  };
}

function base58btcEncode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = B58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return "1".repeat(zeros) + encoded;
}

function base58btcDecode(text) {
  if (typeof text !== "string" || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(text))
    throw new TypeError("Invalid base58btc value");
  let value = 0n;
  for (const character of text) {
    const digit = B58_ALPHABET.indexOf(character);
    if (digit < 0) throw new TypeError("Invalid base58btc value");
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  if (zeros) {
    const padded = new Uint8Array(zeros + bytes.length);
    padded.set(bytes, zeros);
    return padded;
  }
  return bytes;
}

function readVarint(bytes) {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new TypeError("Invalid varint");
      return { code: value, offset: index + 1 };
    }
    shift += 7;
    if (shift > 28) throw new TypeError("Invalid varint");
  }
  throw new TypeError("Invalid varint");
}

function modPow(base, exponent) {
  let result = 1n;
  let factor = ((base % P) + P) % P;
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * factor) % P;
    factor = (factor * factor) % P;
    remaining >>= 1n;
  }
  return result;
}

function bigIntToBytes(value) {
  const hex = value.toString(16).padStart(COORD_BYTES * 2, "0");
  const bytes = new Uint8Array(COORD_BYTES);
  for (let index = 0; index < COORD_BYTES; index += 1)
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function decompressPoint(prefix, xBytes) {
  const x = BigInt(
    `0x${[...xBytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
  );
  if (x >= P) throw new TypeError("Invalid P-256 point");
  const right = (modPow(x, 3n) + A * x + B) % P;
  let y = modPow(right, Y_EXPONENT);
  if ((y * y) % P !== right)
    throw new TypeError("Compressed point is not on P-256");
  if ((y & 1n) !== BigInt(prefix & 1)) y = P - y;
  return bigIntToBytes(y);
}

/**
 * Derive a standards-compliant `did:key:z...` from a public P-256 JWK.
 * Only `kty`, `crv`, `x` and `y` are read; `d` is never accessed.
 */
export function didKeyForPublicJwk(jwk) {
  const { x, y } = requirePublicJwk(jwk);
  const point = new Uint8Array(POINT_BYTES);
  point[0] = (y[COORD_BYTES - 1] & 1) === 0 ? 0x02 : 0x03;
  point.set(x, 1);
  const bytes = new Uint8Array(P256_PUB_VARINT.length + POINT_BYTES);
  bytes.set(P256_PUB_VARINT, 0);
  bytes.set(point, P256_PUB_VARINT.length);
  return DID_PREFIX + base58btcEncode(bytes);
}

/** Resolve a P-256 `did:key` back to the exact public JWK. */
export function resolveDidKey(did) {
  if (typeof did !== "string" || !did.startsWith(DID_PREFIX))
    throw new TypeError("Expected a did:key:z P-256 identifier");
  const bytes = base58btcDecode(did.slice(DID_PREFIX.length));
  const { code, offset } = readVarint(bytes);
  if (code !== P256_PUB_CODE)
    throw new TypeError("Unsupported did:key multicodec (expected p256-pub)");
  const point = bytes.slice(offset);
  if (point.length !== POINT_BYTES || (point[0] !== 0x02 && point[0] !== 0x03))
    throw new TypeError("Invalid compressed P-256 point");
  const x = point.slice(1);
  const jwk = Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: base64urlEncode(x),
    y: base64urlEncode(decompressPoint(point[0], x)),
  });
  if (didKeyForPublicJwk(jwk) !== did)
    throw new TypeError("Non-canonical did:key encoding");
  return jwk;
}

/** Alias for {@link resolveDidKey}. */
export const publicJwkFromDid = resolveDidKey;

/** True when `did` is the did:key of exactly this public JWK. */
export function didKeyMatchesJwk(did, jwk) {
  try {
    return didKeyForPublicJwk(jwk) === did;
  } catch {
    return false;
  }
}
