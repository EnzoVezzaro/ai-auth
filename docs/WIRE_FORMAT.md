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
- `expiresAt`: the session grant end, equal to `issuedAt + sessionTtlMs`, or `null` for Never.
- `sessionPolicy`: `"never"` when the request names no lifetime. It allows Never, and the wallet pre-selects it. Absent on requests from SDKs that predate Never; those keep the 30 minute default, and a Never consent does not verify against them.
- `sessionTtlMs`: `null` for Never, otherwise an integer between 1 second and 60 minutes. A numeric value is the site's cap and must not be combined with `sessionPolicy`.
- `idleTimeoutMs`: `null` for Never, otherwise at most `sessionTtlMs` and at most the request hint (default 10 minutes, capped by the lifetime).
- `renewsNonce`: present only on a renewal.

A renewal is a fresh request with `renews` set, answered by a new consent signed by the same wallet for the same audience and room. Its capabilities must be a subset of the consent being renewed. Verifiers consume the request nonce against the challenge expiry, so a replayed consent or stale challenge is rejected. A consent without `version` is the legacy form whose `expiresAt` may not exceed the request `expiresAt`.

An independent website must supply a fresh challenge, bind it to its own origin, and consume the nonce exactly once. The UI-only request helper is not an authenticated website identity protocol.

## Capability grant

A `capability/grant` envelope carries `recipient`, `resource`, explicit `capabilities`, random `grantId`, `issuedAt` and `expiresAt`. A verifier can check issuer and recipient identities, resource equality, expiry, and operation membership. The verifier still needs an issuer trust policy and revocation source.

## Peer event

P2P room payloads additionally carry `room`, `origin`, per-tab `session`, random `nonce`, and `expiresAt`. Events expire after two minutes. Each room instance retains seen nonces for that window and rejects additional traffic if its bounded replay table is full rather than clearing replay history.

## Site link (`ai-auth-link`, v1)

A site link binds one wallet to one site resource. The site first issues an unsigned challenge `{ type: "ai-auth-link-challenge", v: 1, origin, resource, capabilities, nonce, createdAt, expiresAt, subject? }` (sorted unique capabilities, millisecond timestamps, challenge lifetime at most 600 seconds). The wallet answers with a standard signed envelope (`protocol: "ai-auth-wallet"`, `version: 1`, `type: "ai-auth-link"`) whose payload is:

`{ type: "ai-auth-link", v: 1, linkId, origin, resource, walletId, publicKey, capabilities, nonce, createdAt, expiresAt, subject? }`

- `linkId` is `link:` plus the hex SHA-256 of the canonical JSON of `{ nonce, origin, resource, walletId }`.
- `capabilities` is the approved subset of the challenge, sorted, unique, no wildcards.
- `expiresAt - createdAt` is at most 30 days. The envelope signature covers the canonical body.
- No unknown payload fields are accepted. `subject` is the site's own opaque account identifier and is optional.

A verifier checks the signature, the `walletId`/`publicKey`/issuer binding, exact `origin` and `resource`, expiry, that the capabilities are a subset of what it expects, that `linkId` is recomputed correctly, that the link is not in its revoked set, and finally that the nonce is consumed exactly once from its own nonce store (a nonce the site did not issue is rejected).

## Site link revocation (`ai-auth-link-revocation`, v1)

Unlinking in the wallet deletes the local record and emits a signed envelope with `type: "ai-auth-link-revocation"` and payload `{ type, v: 1, linkId, origin, resource, walletId, nonce, revokedAt }`. A verifier checks the signature, that the issuer is `walletId`, the exact `origin`, and that `linkId` re-derives from the fields (so only the linked wallet can revoke its own link). The wallet must deliver the event to the site; the site records the `linkId` in its own revoked set and rejects that link afterwards.

## Participation modes

Rooms are `open` or `restricted`. Open rooms use the formats above unchanged.

### Membership proof

```json
{
  "type": "ai-auth-membership",
  "v": 1,
  "id": "<unique base64url id>",
  "issuer": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "subject": "agent:…",
  "origin": "https://site.example",
  "room": "research",
  "role": "owner | member | observer",
  "scopes": ["presence.read", "messages.send"],
  "issuedAt": 0,
  "expiresAt": 0,
  "signature": "<base64url ECDSA-P256-SHA256>"
}
```

The signature covers `"ai-auth-membership/v1\n"` followed by the RFC 8785 canonical JSON of every field except `signature`. Unknown fields are rejected. `expiresAt - issuedAt` must be positive and at most 24 hours. Verifiers require a trusted issuer, and exact matches for origin, room, and subject.

### Presenting a proof

A restricted-room peer includes the proof as `payload.membership` in its signed `peer/hello` and `peer/heartbeat` events (at most 4096 serialized characters). The receiver accepts it only when `subject` equals the envelope `issuer`. Other event types are processed only after admission, and only within the proof's scopes (the event-to-capability mapping is the same as for wallet capabilities).

### Public topic

The room topic (`ai-auth-v1-<sha256(appId, origin, room)>`) is public. It is discovery metadata, not authorization; open rooms are public.

## Protocol 1 objects (0.5.0)

Membership, execution-grant, revocation, agent-descriptor and instance-binding objects are standalone signed objects, not wallet envelopes. Each has `type` and `v`, a per-type signature domain string, and the same canonicalization and ECDSA P-256/SHA-256 signature as above. Their fields, validation rules and security boundaries are in `docs/PROTOCOL.md`. Revocations travel as the room event `revocation/gossip` with payload `{ "revocation": <ai-auth-revocation> }`.

## Delivery receipt (`ai-auth-receipt`, v1)

A receipt is an ordinary signed room envelope. It is issued by the **receiver** and acknowledges one collaboration message.

- `body.type`: `"ai-auth-receipt"`.
- `body.issuer`: the receiver wallet id.
- `body.payload`: `v: 1`, `messageId` (UUID of the acknowledged message), `sender` (wallet id that sent the message), `receiver` (must equal `body.issuer`), `receivedAt` (milliseconds), plus the standard peer-event fields `room`, `origin`, `session`, `nonce`, and `expiresAt`.

Message ids and optional targets travel inside the signed payload of `collab/text`, `collab/element`, and every `collab/attachment` chunk: `messageId` (for attachments, equal to the transfer `id`) and optional `target` (a wallet id). A receiver whose wallet id differs from a present `target` drops the message and sends no receipt; a malformed `target` is also dropped.

A sender accepts a receipt only if all of these hold: valid signature by the receiver key, issuer derived from that key, `receiver` equals the issuer and differs from the sender, `sender` is the local wallet, `room` and `origin` match exactly, the nonce is unused, the `messageId` is a message this sender sent, the receiver is the target (when the message was targeted), the receipt arrives within the three-minute receipt window, and that receiver has not already acknowledged the message. Receivers acknowledge only messages addressed to them, after accepting them.

A receipt proves that the receiver's wallet key signed an acknowledgement of that message id in that room and origin. It does **not** prove that a human saw, read, or understood the content, and a receiver can sign without displaying it. Senders show "received-by-peer" only after a valid receipt and never otherwise; a lost receipt leaves the message at "sent-to-transport" and later "expired".

## Protocol 1 additions (0.5.0, second part)

- `connect/consent` v2 may carry `agentDescriptor` (an `ai-auth-agent-descriptor` v1, see `docs/PROTOCOL.md`). It is signed inside the consent payload.
- `ai-auth-epoch` v1 announces the authorization epoch. Room events: `revocation/gossip` payload is one of `{ "revocation": ... }`, `{ "linkRevocation": <ai-auth-link-revocation envelope> }`, `{ "epoch": ... }`; `revocation/sync-request` has an empty payload; `revocation/sync` has `{ "epoch": record|null, "revocations": [...], "linkRevocations": [...] }` with at most 32 items per list.
- `membership/prove` (empty payload plus the membership proof) is sent by private participants in restricted rooms instead of presence.
- Page-to-wallet `ai-auth/room-ready` may carry `features: { targets, receipts }`; the page treats absence as unsupported. `ai-auth/transfer-request` args may end with an options object holding only `messageId`, `target` and, for attachments, `kind` and `name`.
