/** A P-256 `did:key` identifier (base58btc multibase, p256-pub codec). */
export type DidKey = `did:key:z${string}`;

/** The exact public-only JWK that a P-256 `did:key` resolves to. */
export interface DidP256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/**
 * Derive a `did:key` from a public P-256 JWK.
 * Reads only `kty`, `crv`, `x` and `y`; never uses private key material.
 *
 * @throws {TypeError} if the JWK is not a valid EC P-256 public JWK.
 */
export function didKeyForPublicJwk(jwk: JsonWebKey): DidKey;

/**
 * Resolve a P-256 `did:key` to the exact public JWK.
 *
 * @throws {TypeError} for an invalid DID, codec, point or encoding.
 */
export function resolveDidKey(did: string): Readonly<DidP256PublicJwk>;

/** Alias for {@link resolveDidKey}. */
export function publicJwkFromDid(did: string): Readonly<DidP256PublicJwk>;

/** True when `did` is the did:key of exactly this public JWK. */
export function didKeyMatchesJwk(did: string, jwk: JsonWebKey): boolean;
