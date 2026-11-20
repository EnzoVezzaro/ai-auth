# AI Auth wire protocol v1

This is the v1 contract used by `@enzovezzaro/ai-auth-wallet` 0.12.0. It says what peers sign, what they send in a room, and how a receiver checks it. These are AI Auth conventions. They are not WebMCP, OAuth, or a standards-body specification.

## Signed envelope

Room events are `SignedEnvelope` objects:

```json
{
  "body": {
    "protocol": "ai-auth-wallet",
    "version": 1,
    "type": "message/text",
    "issuer": "agent:<base64url-sha256-of-public-jwk>",
    "createdAt": "2026-11-14T00:00:00.000Z",
    "payload": {}
  },
  "proof": {
    "algorithm": "ECDSA-P256-SHA256",
    "publicKey": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
    "signature": "<base64url-signature>"
  }
}
```

- Canonical bytes use RFC 8785 JSON canonicalization: UTF-8, sorted keys, finite numbers, no `undefined`.
- The signature is ECDSA P-256 with SHA-256 over the canonical `body`, encoded as unpadded base64url.
- `issuer` is `agent:` plus the SHA-256 fingerprint of the public JWK, derived by `identityFor`. A verifier derives it again and rejects a mismatch.
- Standalone signed objects below prepend a per-type domain string. A signature for one type cannot validate as another.
- Peer events add `room`, `origin`, `session`, `nonce`, and `expiresAt` to the payload. Events expire after two minutes. A room keeps a bounded seen-nonce table and refuses new traffic when that table is full, rather than clearing replay history.
- A missing expected origin, room, subject, nonce, or trust decision is a denial.
- Agent `provider`, `model`, `runtime`, and `agentType` fields are self-declared claims. They are display metadata, never authorization input.

## Room event types

Each event is a signed envelope. The capability column is the scope the room requires before it delivers the event.

| Type                      | Capability      | Payload fields                                                                                          |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `peer/hello`              | `presence.read` | `label` (claim); `membership` proof in a restricted room                                                |
| `peer/heartbeat`          | `presence.read` | `label` (claim); `membership` proof in a restricted room                                                |
| `peer/goodbye`            | `presence.read` | empty                                                                                                   |
| `presence/cursor`         | `presence.read` | canonical v1 cursor payload, below                                                                      |
| `message/text`            | `messages.send` | `text`, `messageId`, optional `target`                                                                  |
| `collab/text`             | `messages.send` | `text`, `messageId`, optional `target` (legacy name, accepted from older senders)                       |
| `collab/element`          | `content.share` | `metadata`, `messageId`, optional `target`                                                              |
| `collab/attachment`       | `content.share` | transfer `id` (also the `messageId`), chunk fields, optional `target`                                   |
| `ai-auth-receipt`         | none            | `v`, `messageId`, `sender`, `receiver`, `receivedAt`, plus the room fields above                        |
| `agent/action`            | `tools.invoke`  | `kind` of `tool-catalog`, `tool-request`, `tool-cancel`, `tool-response`; or `name`, `state`, `summary` |
| `membership/prove`        | `presence.read` | empty, plus the membership proof                                                                        |
| `revocation/gossip`       | none            | one of `revocation`, `linkRevocation`, `epoch`                                                          |
| `revocation/sync-request` | none            | empty                                                                                                   |
| `revocation/sync`         | none            | `epoch`, `revocations`, `linkRevocations`; at most 32 records in each list                              |

`state` on a named `agent/action` is one of `started`, `progress`, `completed`, `failed`, `cancelled`, `needs-human`, or `denied`.

## Cursor v1

Cursors are published as `presence/cursor` with `type: "ai-auth-cursor"` and `v: 1`. A cursor is data about where a participant is working. It never moves an OS pointer and grants no permission to click, type, or run tools.

| Field               | Rule                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pageKey`           | Page or route key, at most 200 characters. `null` means site-wide. `mountAIAuthCollaboration` accepts `pageKey` and defaults to `location.pathname`.        |
| `x`, `y`            | Finite numbers in `0..MAX_COORDINATE` (`0..1_000_000`): a 0..1 fraction of the document width and height scaled by `MAX_COORDINATE`, not raw pixel offsets. |
| `seq`               | Per-sender monotonic integer. Older or repeated values are dropped.                                                                                         |
| `visible`, `scroll` | Optional. `visible` is a boolean. `scroll` is a fraction from 0 to 1.                                                                                       |
| `selector`, `label` | Optional. `selector` is a stable element hint. `label` is a claim.                                                                                          |

A peer is online while its heartbeat lease is fresh, shown offline after 16 seconds without a heartbeat, and removed with its cursor after 24 seconds or on `peer/goodbye`.

## Chat types

Chat uses one envelope type, `message/text`. The collaboration wheel, the headless agent runtime, and the MCP `ai_auth_send` tool all send it with a signed `messageId` and an optional `target`. Peers also accept `collab/text` from older senders: it carries the same fields and earns the same signed delivery receipt, but nothing new sends it.

## Receipts

A receipt is an ordinary signed room event of type `ai-auth-receipt` with `v: 1`. It is signed by the receiver. Its payload has `messageId`, `sender`, `receiver`, and `receivedAt`, plus `room`, `origin`, `session`, `nonce`, and `expiresAt`.

A sender accepts a receipt only when the signature is valid, `receiver` is the issuer and is not the sender, `sender` is the local wallet, room and origin match, the nonce is unused, the `messageId` was sent by this sender, the receiver is the signed target when one is present, the receipt is inside the three-minute window, and that receiver has not already acknowledged the message.

A receipt proves that a wallet key signed an acknowledgement. It does not prove that a human read the message. Delivery moves to `received-by-peer` only on a valid receipt.

## Tool events and error codes

WebMCP tools live in the page. The SDK advertises a bounded signed catalog to peers. An agent calls a page tool through `ai_auth_invoke` only after wallet scope checks and the site's explicit human approval. Tool requests, results, catalogs, and action status are visible to connected peers in the shared room.

The runtime value of `TOOL_ERROR_CODES` is defined in `packages/p2p/webmcp.js` and reused by `packages/agent/tool-provider.js`. It has eight codes: `TOOL_UNAVAILABLE`, `SITE_DISCONNECTED`, `CATALOG_EXPIRED`, `AUTH_EXPIRED`, `CANCELLED`, `TIMEOUT`, `NOT_JOINED`, and `DENIED`. The public type declaration in `packages/p2p/index.d.ts` lists only the first six.

## Standalone signed objects

These are signed objects, not wallet envelopes. Each has a `type`, a `v`, a per-type domain string, and the same canonicalization and signature as above.

| Type                       | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `ai-auth-instance-binding` | Binds one running instance id to one wallet key                         |
| `ai-auth-agent-descriptor` | Signed self-description attached to a v2 consent. All fields are claims |
| `ai-auth-membership`       | Site-issued admission to a restricted room                              |
| `ai-auth-execution-grant`  | Short-lived permission for a protected operation, at most 15 minutes    |
| `ai-auth-revocation`       | Revokes a membership, link, or wallet id                                |
| `ai-auth-epoch`            | Announces a new authorization epoch                                     |
| `ai-auth-link`             | Binds a wallet to one site resource, at most 30 days                    |
| `ai-auth-link-revocation`  | Wallet-signed revocation of a link                                      |

Revocation, epoch, and link records are checked against the verifier's local trust policy and an exact origin and room. There is no global revocation service. See [security boundaries](SECURITY.md).

## Discovery

A site may publish `/.well-known/ai-auth.json`. It is a public, unsigned hint for where the site wants to be reached. `fetchDiscovery` validates it. It grants nothing. See [site discovery](DISCOVERY.md).
