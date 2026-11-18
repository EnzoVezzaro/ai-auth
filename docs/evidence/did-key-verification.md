# Independent verification of the P-256 `did:key` adapter

**Date:** 2026-11-18
**Scope:** PR #13 §11 — "Verify the DID with an implementation outside AI Auth and without network access."
**Verdict:** PASS. No disagreement with the adapter was found. One disagreement exists between the task statement's prefix parenthetical and the authoritative external multicodec table (see *Disagreements*).

This is independent verification. The adapter and its tests were **not** modified. All verification primitives (base58btc, the multicodec table, and full `did:key` resolution) come from packages installed in a temporary directory **outside** this repository. No dependency was added to this repo and no manifest or lockfile was changed.

## Environment

- Repo: `/Users/mac/Desktop/Github/ai-auth` (Node `v22.23.4`, npm `10.9.9`, darwin)
- External workdir: `/private/var/folders/lt/lfbc4_451gg2pb0vvbz8lc4m0000gn/T/opencode/did-verify`

## Exact setup commands (run outside the repo)

```sh
TMP=/private/var/folders/lt/lfbc4_451gg2pb0vvbz8lc4m0000gn/T/opencode/did-verify
mkdir -p "$TMP" && cd "$TMP"
npm init -y >/dev/null
npm install multiformats@14.0.6 multicodec@3.2.1 \
  key-did-resolver@4.0.0 did-resolver@6.0.0
```

`npm ls --depth=0` in that directory returned exactly:

| Package | Version | Role |
| --- | --- | --- |
| `multiformats` | 14.0.6 | external `base58btc` codec (`multiformats/bases/base58`) |
| `multicodec` | 3.2.1 | authoritative multicodec code/varint table (deprecated but canonical table) |
| `key-did-resolver` | 4.0.0 | independent `did:key` → DID-document resolver; emits `publicKeyJwk` for P-256 |
| `did-resolver` | 6.0.0 | drives `key-did-resolver` via its documented `Resolver` API |

Resolved tarballs (from the external `package-lock.json`): `multiformats-14.0.6.tgz`, `multicodec-3.2.1.tgz`, `key-did-resolver-4.0.0.tgz`, `did-resolver-6.0.0.tgz`, plus transitive `@noble/curves@1.9.7`, `@noble/hashes@1.8.0`, `varint@6.0.0`, `uint8arrays@5.1.1`. The external resolver uses `@noble/curves`, i.e. a completely separate elliptic-curve implementation from the adapter's hand-written bigint point decompression.

## Rerun the verification

```sh
cd /Users/mac/Desktop/Github/ai-auth
node scripts/verify-did-key.mjs \
  --modules-dir /private/var/folders/lt/lfbc4_451gg2pb0vvbz8lc4m0000gn/T/opencode/did-verify/node_modules
```

Observed output ended with `RESULT: PASS (54/54 checks passed)`, exit code `0`. The script generates 6 fresh P-256 keypairs per run with Node Web Crypto and checks each with all three external layers, then runs rejection cases through the adapter's public API.

## Method

1. Generate P-256 public JWKs locally with `crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"})` / `exportKey("jwk")`.
2. Derive DIDs with AI Auth's `didKeyForPublicJwk(jwk)`.
3. Decode the DID with **external** `base58btc.decode` and inspect codec bytes with **external** `multicodec.getCode` / `getCodec` / `getVarint`.
4. Resolve the DID with **external** `key-did-resolver` (via `did-resolver`) and compare the returned `publicKeyJwk` byte-for-byte to the original JWK.
5. Cross-check the adapter's own `resolveDidKey` and `didKeyMatchesJwk`.
6. Rejection cases: wrong curve/kty, malformed coordinates, wrong multicodec prefixes, malformed DID, and a mismatched JWK.

## Vectors (JWK → DID → external resolution)

The first three are fixed known-answer vectors (also used by the repo's test file); the fourth is a P-256 key generated during this run (random, so not reproducible — shown as a sample of the 6 generated per run).

| # | x | y | did (from adapter) | raw[0:2] | external codec | external resolver JWK == input |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `igrFmi0whuihKnj9R3Om1SoMph72wUGeFaBbzG2vzns` | `efsX5b10x8yjyrj4ny3pGfLcY7Xby1KzgqOdqnsrJIM` | `did:key:zDnaerx9CtbPJ1q36T5Ln5wYt3MQYeGRG5ehnPAmxcf5mDZpv` | `8024` | `4608` / `p256-pub` | yes |
| 2 | `OcPddBMXKURtwbPaaah1G75-nouisLmtL9qaaaI9Doc` | `AXuQgg5s3wXfkmz_xAyhXvWDqvvpyxaoshDekbb47sg` | `did:key:zDnaeUKTWUXc1HDpGfKbEK4VRpw8FJVDExddoNqfJW3kJyqzn` | `8024` | `4608` / `p256-pub` | yes |
| 3 | `OoJz7s5rDYLpXDUGYX21AA4U_wAjMl0LsCdJGLxqbNw` | `1dTCts1IylLFZQ-y2ABHc4x7hifNanA1rXgPFTZp-tU` | `did:key:zDnaembgSGUhZULN2Caob4HLJPaxBh92N7rtH21TErzqf8HQo` | `8024` | `4608` / `p256-pub` | yes |
| 4 (generated) | `5Vk6I4iK6Gl1yN7jchh9cCrXDE7rSR7Z57tE2coaUos` | `3Pp-YbFOMKJG8ci_uTIFyvfopRhIC56-yGJq0wndSPs` | `did:key:zDnaey6Zh7pi5YCzQRtqbJ56zvT5tMfEkRGqYnduAd2d2aAwL` | `8024` | `4608` / `p256-pub` | yes |

All decoded DIDs are 35 bytes (2-byte varint + 33-byte compressed SEC1 point). For every vector: adapter `resolveDidKey(did)` deep-equals the input JWK, `didKeyMatchesJwk(did, jwk)` is `true`, and external `key-did-resolver` returned a `JsonWebKey2020` verification method with an identical `{kty,crv,x,y}`.

## Multicodec prefix facts (from `multicodec@3.2.1`)

| Expression | External result |
| --- | --- |
| `multicodec.P256_PUB` | `4608` = `0x1200` |
| `multicodec.getName(0x1200)` | `"p256-pub"` |
| `multicodec.getVarint(0x1200)` | bytes `80 24` |
| first two bytes of decoded DIDs | `80 24` (observed for all 10 keys across runs) |
| `multicodec.getCode([0xa4,0x01])` | `164` = `0xa4` |
| `multicodec.getCodec([0xa4,0x01])` | throws `Code "164" not found` (unmapped) |
| `multicodec.getVarint(0x8024)` | bytes `a4 80 02` |

## PASS / FAIL / UNKNOWN table

| Check | Result | Evidence |
| --- | --- | --- |
| p256-pub numeric code is `0x1200` | PASS | `multicodec.P256_PUB === 4608` |
| p256-pub varint bytes are `80 24` | PASS | `getVarint(0x1200) → 8024`; decoded DIDs start `8024` |
| Base58btc (`z` multibase) decodes to 35 bytes | PASS | external `base58btc.decode`, all keys |
| External codec of DID == `0x1200` / `p256-pub` | PASS | `getCode`/`getCodec`, all keys |
| Full external did:key resolution == original JWK | PASS | `did-resolver` + `key-did-resolver` (`@noble/curves`) |
| Adapter `resolveDidKey` == original JWK | PASS | deep-equal for all keys |
| Adapter `didKeyMatchesJwk(did, jwk)` true | PASS | all keys |
| Wrong curve `P-384` rejected | PASS | adapter throws `TypeError` |
| Wrong kty `OKP`/`Ed25519` rejected | PASS | adapter throws `TypeError` |
| Malformed `x` coordinate rejected | PASS | adapter throws `TypeError` |
| Mismatched JWK returns `false` | PASS | `didKeyMatchesJwk` |
| Arbitrary string / empty multibase rejected | PASS | `resolveDidKey("agent:abc")`, `resolveDidKey("did:key:z")` throw |
| `a4 01` prefix DID rejected | PASS | `did:key:zHN8WVTguMDSQ94cSPLkxJ8W5u7n3ZwJDxp7P9T99KtLJCd5U` → `Unsupported did:key multicodec` |
| `e7 01` (secp256k1) prefix DID rejected | PASS | `did:key:zQ3shovxv6i36bziX51hYbWKZCdMkFDV6bqEBNFEKMBAy4GdY` → same error |
| `ed 01` (Ed25519) prefix DID rejected | PASS | `did:key:zQebfMtDLQTHTYM9JWCygruv75YDWaKGDjUYy4M688JjtkD4v` → same error |
| Signature verification with resolved key | UNKNOWN here | Exercised by sibling test file, not by this independent script; not re-run as part of this verification |
| Browser (`btoa`/`atob`) environment | UNKNOWN here | Verified under Node 22 only; adapter uses `btoa`/`atob`, which exist in Node 22 and browsers |

## Disagreements

1. **No disagreement with the adapter.** Every DID produced by `didKeyForPublicJwk` was confirmed by the external resolver, and every rejection behaved as expected.
2. **Disagreement with the task statement's parenthetical.** The task text says "p256-pub 0x8024, varint a4 01". The authoritative external table gives the opposite: the numeric code is `0x1200`, its varint bytes are `80 24`, and `a4 01` decodes to the unmapped code `0xa4`. Interpreting `0x8024` as a numeric code yields varint `a4 80 02`, not `a4 01`. The adapter is correct; the parenthetical is not. The adapter's own header comment already documents this exact confusion.

## Limitations / notes on "without network access"

- Package acquisition used the public npm registry (explicitly allowed by the task's "install or run packages … using npx/npm"). The **verification itself is offline**: `scripts/verify-did-key.mjs` only reads local files and imports locally installed packages; `did:key` is self-resolving and performs no HTTP/RPC/DNS calls. No AI Auth network or RPC code was invoked.
- `multicodec@3.2.1` is deprecated in favor of `multiformats`, but it is the package that exposes the canonical code/varint table used here; the base58btc used for decoding is from `multiformats@14.0.6`.
- The four generated keys cited above are from one run; the script regenerates 6 random keys on each run, so exact generated vectors differ between runs while the fixed vectors and all checks remain identical.
