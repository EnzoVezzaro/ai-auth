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

The local demo request is an unsigned request object created by its sample UI. It carries `type: "ai-auth/permission-request"`, `version: 1`, exact `audience`, random `nonce`, millisecond `createdAt` and `expiresAt`, and a sorted unique `capabilities` list. The wallet approval is a signed `connect/consent` envelope whose payload repeats the exact audience and request nonce plus a subset of the requested capabilities.

An independent website must supply a fresh challenge, bind it to its own origin, and consume the nonce exactly once. The UI-only request helper is not an authenticated website identity protocol.

## Capability grant

A `capability/grant` envelope carries `recipient`, `resource`, explicit `capabilities`, random `grantId`, `issuedAt` and `expiresAt`. A verifier can check issuer and recipient identities, resource equality, expiry, and operation membership. The verifier still needs an issuer trust policy and revocation source.

## Peer event

P2P room payloads additionally carry `room`, `origin`, per-tab `session`, random `nonce`, and `expiresAt`. Events expire after two minutes. Each room instance retains seen nonces for that window and rejects additional traffic if its bounded replay table is full rather than clearing replay history.
