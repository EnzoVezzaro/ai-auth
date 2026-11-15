// Shared encoding helpers for the signed protocol objects (membership,
// revocation, agent descriptor). Internal: not re-exported from the package root.

export function b64u(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function unb64u(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value))
    throw new TypeError("Invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const publicJwk = (k) => ({ kty: k.kty, crv: k.crv, x: k.x, y: k.y });
export const isObject = (v) =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
export const randomId = (bytes = 18) =>
  b64u(crypto.getRandomValues(new Uint8Array(bytes)));

const encoder = new TextEncoder();

/** ECDSA P-256 / SHA-256 over `domain + canonical(body)`, base64url. */
export async function signDomain(privateKey, domain, canonicalBody) {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(domain + canonicalBody),
  );
  return b64u(sig);
}

export async function verifyDomain(jwk, signature, domain, canonicalBody) {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk(jwk),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      unb64u(signature),
      encoder.encode(domain + canonicalBody),
    );
  } catch {
    return false;
  }
}
