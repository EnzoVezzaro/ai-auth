# did:key identity adapter (Phase 1)

The wallet's canonical identity is still the legacy `agent:` identifier produced
by `identityFor(publicKey)`. The `did:key` adapter is **additive**: it derives a
second, optional identifier from the same public P-256 JWK. It does not change
the legacy ID, stored sessions, wire formats, keys, or the signing model.

```js
import {
  didKeyForPublicJwk,
  resolveDidKey,
  didKeyMatchesJwk,
} from "@enzovezzaro/ai-auth-wallet";

const did = didKeyForPublicJwk(wallet.publicKey); // "did:key:zDna..."
const jwk = resolveDidKey(did); // { kty: "EC", crv: "P-256", x, y }
const same = didKeyMatchesJwk(did, wallet.publicKey); // true
```

## What the adapter uses

Only the **public** JWK members `kty`, `crv`, `x` and `y`. The browser signing
key stays non-extractable: the adapter never imports, exports, or reads the
private key (including `d`). `resolveDidKey` returns a public-only JWK with no
`d` member, so a resolved key can verify signatures but cannot sign.

## Encoding

For P-256, did:key is a deterministic encoding of the public key:

1. Compress the SEC1 point: `0x02` if the last byte of `y` is even, `0x03` if
   odd, followed by the 32-byte `x` coordinate (33 bytes total).
2. Prefix the multicodec varint `80 24` — the `p256-pub` code `0x1200`. (Some
   documents write this code as `0x8024`, which is actually the two varint
   _bytes_ `80 24`; it is not a one-byte code, and the varint bytes `a4 01`
   are not p256-pub.)
3. base58btc-encode the bytes, prefix with multibase `z`, then `did:key:`.

The implementation is dependency-free and browser-safe. Decompression uses a
small local big-integer implementation of `y = sqrt(x³ - 3x + b) mod p` for the
P-256 prime, with the parity selected by the SEC1 prefix. It rejects points
that are off-curve, coordinates that are not 32 bytes, non-canonical base58,
and any codec other than p256-pub.

Known-answer vector (W3C did:key P-256 test vector):

- DID: `did:key:zDnaerx9CtbPJ1q36T5Ln5wYt3MQYeGRG5ehnPAmxcf5mDZpv`
- bytes: `8024 038a0ac59a2d3086e8a12a78fd4773a6d52a0ca61ef6c1419e15a05bcc6dafce7b`
- `x`: `igrFmi0whuihKnj9R3Om1SoMph72wUGeFaBbzG2vzns`
- `y`: `efsX5b10x8yjyrj4ny3pGfLcY7Xby1KzgqOdqnsrJIM`

## What did:key does _not_ mean

- **Not trust or authorization.** A DID is just a key encoded as a string.
  Anyone can compute one for any key. Never use a did:key value as evidence of
  identity, membership, consent, or approval; keep using signed envelopes,
  capability grants, and participation policies for those decisions.
- **No server or registry.** Resolution is a local computation. There is no
  network lookup, no registration, no update and no deactivation. Offline
  resolution always produces the same result.
- **No rotation or recovery.** Because the DID is derived from the key, a new
  key means a new DID. A key compromise changes the DID rather than rotating
  in place, so a did:key is best treated as an ephemeral or short-lived alias.
- **Correlatable.** The public key is embedded in the identifier, so reusing
  one DID across contexts lets those contexts recognize the same key.

## Relationship to the legacy alias

`identityFor(publicKey)` remains the canonical, stable `agent:` ID used in
stored sessions, consent records, envelopes, and existing wire formats. A
did:key is an alias derived from the same public key; deriving it neither reads
nor mutates any of that state. `identityFor` is unchanged before and after a
DID is derived. Treat the legacy ID as canonical in all existing protocols and
the DID as an optional, key-derived view of the same public key.
