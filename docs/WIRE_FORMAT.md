# AI Auth wallet wire format v1

All signed objects use UTF-8 RFC 8785 JSON Canonicalization Scheme bytes. Unknown top-level protocol versions and unsupported JSON values must be rejected.

```json
{
  "body": {
    "protocol": "ai-auth-wallet",
    "version": 1,
    "type": "message/text",
    "issuer": "agent:<base64url-sha256-public-key-fingerprint>",
    "createdAt": "2026-11-14T00:00:00.000Z",
    "payload": {}
  },
  "proof": {
    "algorithm": "ECDSA-P256-SHA256",
    "publicKey": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
    "signature": "<base64url-WebCrypto-signature>"
  }
}
```

The signature covers the canonical `body` object. The verifier derives the `agent:` issuer fingerprint from the public JWK and rejects a mismatch. Signature payloads must be JSON-compatible values with finite numbers and valid Unicode.

## Permission request

The request is an unsigned challenge object. It carries `type: "ai-auth/permission-request"`, `version` 2 (1 is still accepted), exact `audience`, random `nonce`, millisecond `createdAt` and `expiresAt`, and a sorted unique `capabilities` list. `expiresAt` is the **handshake expiry only**: 1–120 seconds, single use. Version 2 adds optional `sessionTtlMs` and `idleTimeoutMs` (hints, each 1 second to 60 minutes) and `renews` (the request nonce of the consent being renewed).

The wallet approval is a signed `connect/consent` envelope with `payload.version: 2`:

- `audience`, `requestNonce`, `room`, `capabilities` (subset of the request).
- `issuedAt` and `challengeExpiresAt` (must equal the request `expiresAt`; `issuedAt` must not be later than it).
- `expiresAt`: the session grant end, equal to `issuedAt + sessionTtlMs`.
- `sessionTtlMs`: at most the request hint (default 30 minutes) and never more than the 60 minute hard cap.
- `idleTimeoutMs`: at most `sessionTtlMs` and at most the request hint (default 10 minutes).
- `renewsNonce`: present only on a renewal.

A renewal is a fresh request with `renews` set, answered by a new consent signed by the same wallet for the same audience and room. Its capabilities must be a subset of the consent being renewed. Verifiers consume the request nonce against the challenge expiry, so a replayed consent or stale challenge is rejected. A consent without `version` is the legacy form whose `expiresAt` may not exceed the request `expiresAt`.

An independent website must supply a fresh challenge, bind it to its own origin, and consume the nonce exactly once. The UI-only request helper is not an authenticated website identity protocol.

## Capability grant

A `capability/grant` envelope carries `recipient`, `resource`, explicit `capabilities`, random `grantId`, `issuedAt` and `expiresAt`. A verifier can check issuer and recipient identities, resource equality, expiry, and operation membership. The verifier still needs an issuer trust policy and revocation source.

## Peer event

P2P room payloads additionally carry `room`, `origin`, per-tab `session`, random `nonce`, and `expiresAt`. Events expire after two minutes. Each room instance retains seen nonces for that window and rejects additional traffic if its bounded replay table is full rather than clearing replay history.
