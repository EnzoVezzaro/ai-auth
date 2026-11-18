# Phase 0 review: `docs/IDENTITY_STANDARDS_RFC.md`

**Status:** research findings only — no production code changed, no commit.
**Date:** 2026-11-18. **Baseline:** `main` at `7ad5294`.
**Methods:** Node 22.23.4 Web Crypto; independently generated P-256 JWKs; `jose` 6.2.17 `calculateJwkThumbprint` (installed at `packages/mcp/node_modules/jose`, source `dist/webapi/jwk/thumbprint.js`); published RFC 7515 JWK; RFC 8785 Appendix B fixture. Temporary scripts lived outside the repo.

## 1. Verified findings

### 1.1 `identityFor()` is RFC 7638 SHA-256 — VERIFIED TRUE

Evidence: `packages/p2p/index.js:88-108` builds `material = {crv, kty, x, y}` (lines 97-102), serializes with `canonicalize` (50-82; ASCII keys sorted at 80-81), SHA-256 over UTF-8 (103-106), unpadded base64url (16-23), prefixed `agent:` (107). RFC 7638's EC required members are exactly `crv,kty,x,y` in lexicographic byte order — confirmed independently in `jose`'s EC `requiredMembers` branch. `publicJwk()` (`packages/p2p/codec.js:18`) uses the same four members. Optional JWK members are ignored by both implementations.

| Vector                                                                                                                                | `identityFor` digest (after `agent:`)         | manual RFC 7638 JSON | jose 6.2.17 | Match                |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------- | ----------- | -------------------- |
| generated P-256 key #1                                                                                                                | `XitPFZjpMyXZkKE2FUoeyH-Kuac1Q7llcWTdt6eUYC8` | same                 | same        | yes                  |
| generated P-256 key #2                                                                                                                | `hyCZKCCv4h4JJEMAAR5UXcXrzvHtQYaW5W6FE_FqWdk` | same                 | same        | yes                  |
| published JWK: RFC 7515 App. A.3.1 (`x=f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU`, `y=x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0`) | `oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U` | same                 | same        | yes                  |
| key #1 plus `alg/kid/use/d` extras                                                                                                    | `XitPFZjpMyXZkKE2FUoeyH-Kuac1Q7llcWTdt6eUYC8` | same                 | same        | yes (extras ignored) |

Canonical serialization observed for the vector: `{"crv":"P-256","kty":"EC","x":"f83O…","y":"x_FE…"}`.
**Scope of claim:** parity holds for the _digest_ of valid P-256 JWKs; `identityFor` rejects missing/empty `x`/`y`, and the full `agent:` string is a private prefix, not a DID. `did:key` encodes a multicodec compressed SEC1 point, so its bytes differ — no byte reuse.

### 1.2 `canonicalize()` vs RFC 8785 (JCS) — VERIFIED on published fixture

`canonicalize` reproduced RFC 8785 Appendix B sample exactly: `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$…"}` (including `333333333.33333329→333333333.3333333`, `1E30→1e+30`, `-0→0`, escaping). Existing tests: `tests/p2p-wallet.test.mjs:48-56`. Caveat: one fixture is not exhaustive proof of JCS conformance for all inputs. Note UTF-16 (`.sort()`) vs UTF-8 (RFC 7638) key ordering can diverge for non-ASCII names, but the four JWK names are ASCII, so parity is unaffected.

### 1.3 Baseline commands — ALL PASS (network E2E skipped)

- `npm run test:all`: **681 tests, 681 pass, 0 fail** (root 547, runtime 7, mcp 79, agent 48); wall **27.92s**.
- `npm run test:types`: **pass**, wall **2.18s**.
- `npm run build`: **pass**, wall **0.56s** (outputs `dist-p2p`, gitignored).
- `npm run verify:packages`: **pass** (exit 0), wall **6.80s**; prints resolved exports for the five packages, no numeric pass/fail counts by design.

### 1.4 Standard / library claims

- **Correct in RFC:** did:key is a community method (w3c-ccg), not DID Core itself; DID Core is the W3C Recommendation; `agent:` is not a DID; browsers store a non-extractable signing CryptoKey in IndexedDB (`index.js:190-208`); headless keystore uses PBKDF2/AES-GCM and mode `0600` (`packages/agent/keystore.js:51-86,203-209`); no TURN fallback (`docs/ARCHITECTURE.md:49`).
- **Supported offline:** jose 6.2.17 exports `SignJWT`, `compactVerify`, `importJWK`, `calculateJwkThumbprint` — claim that it provides standard ES256/JWS primitives is consistent with inspection (no full JWS round-trip run in Phase 0).
- **Independently verified after Phase 1:** the P-256 multicodec numeric code is `0x1200` (4608) and its varint bytes are `80 24`, not `a4 01`. `key-did-resolver@4.0.0` resolved every derived DID to a JWK deep-equal to the original public JWK. Evidence: `docs/evidence/did-key-verification.md`, `scripts/verify-did-key.mjs` (54/54 checks pass). Library-level P-256 claims in the RFC's authorization section remain unverified offline.
- **UNVERIFIED (not installed / no offline docs):** UCAN spec P-256 listing and ucanto P-256 API; Biscuit spec/library P-256 support (local knowledge: added in Biscuit 2.x — RFC's "fair correction" is plausibly right but unproven offline); VC DM 2.0 / A2A cards / Credo / Veramo / OpenA2A AIM / Alien Agent ID / ANP / HelixID claims. Do not present these as established facts.

## 2. Corrections to the RFC

1. §2: change "hypothesis to confirm with an independent library and test vectors" to "independently confirmed for valid P-256 JWKs" and cite the four vectors above.
2. §2: upgrade the `canonicalize` caveat — the official JCS fixture passes; retain "not exhaustively proven" wording.
3. §3 table row for key-did-resolver and §5 UCAN/Biscuit "Crypto" rows: relabel library-level P-256 support **UNVERIFIED offline**; keep the bake-off and explicit API tests as mandatory.
4. §4/§2: state explicitly that RFC 7638 parity means keys are reusable but `did:key` bytes are _not_ the thumbprint; aliases must resolve back to the same key.
5. §8 Phase 0: record the actual baseline results (§1.3).

## 3. Decision record (short)

**Context:** need interoperable identity without invalidating wallets, sessions, consent, or v1 wire formats.
**Decision:** adopt an **additive `did:key` alias** derived from the existing public P-256 JWK as the first alias; **do not replace** the canonical `agent:` ID. Keep `agent:` as the stable legacy identifier and verification anchor in stored records, envelopes, grants and recovery.
**Rationale:** RFC 7638 parity proves the existing key is reusable; did:key adds a portable, registry-free identifier with no custody change. Different byte formats make coexistence natural rather than a migration.
**Constraints honored:** preserve key material, consent boundaries, public exports, v1 wire formats, no-server custody; browser key stays non-extractable; an alias is accepted only if it resolves to the same verified key, and ambiguous mappings are refused. No change to `signEnvelope`/`verifyEnvelope` issuer bytes. UCAN-vs-Biscuit stays a gated Phase 3 bake-off with negative tests.

## 4. Open questions

- Which maintained did:key P-256 adapter works with a non-extractable browser key? (UNVERIFIED)
- Confirm compressed-SEC1→multicodec derivation with independent vectors before coding.
- Do ucanto/biscuit-wasm actually expose P-256, and at what bundle/startup cost? (UNVERIFIED)
- Key-rotation continuity under site policy; pairwise IDs vs cross-site correlation.
- Full JCS conformance beyond the single published fixture.
- An untracked `packages/p2p/did.js` appeared in `git status` during this review; it was **not** created by this review and was left untouched — flag to the parent session.
