# AI Auth protocol contracts

Status: protocol version 1, shipped with `@enzovezzaro/ai-auth-wallet` 0.5.0. Each section says whether it is **implemented** (code and tests exist) or **specified** (contract only; no code yet).

These are AI Auth conventions. They are not WebMCP standards and not a W3C, IETF or other standards-body specification. WebMCP is only the in-page tool surface that AI Auth feature-detects.

## Conventions

- **Canonicalization.** Every signed object is serialized with the package's `canonicalize` (RFC 8785 JSON Canonicalization Scheme): UTF-8, sorted keys, finite numbers only, no `undefined`.
- **Signature.** ECDSA P-256 with SHA-256 (WebCrypto, IEEE-P1363 raw signature), base64url without padding.
- **Domain separation.** The signed bytes are `domain-string + canonical(body)`, where `body` is the object without `signature`. Each object type has its own domain string, so a signature for one type can never validate as another.
- **Identity.** `walletId` is `agent:` plus the base64url SHA-256 fingerprint of the public JWK (`identityFor`). A verifier derives it from the embedded key and rejects a mismatch.
- **Versioning.** Every object has `type` and `v`. A verifier rejects unknown `type`, unknown `v`, missing fields and unknown extra fields (`malformed`). Optional fields are listed explicitly and are signed only when present.
- **Times.** Milliseconds since the epoch. Verifiers allow 30 s of forward clock skew and apply the verifier's own clock.
- **Fail closed.** A missing expectation (origin, room, subject, nonce, trust policy) is a denial, never a skipped check.
- **Claims versus attestations.** A signature proves possession of a private key. It does not prove human identity, site membership, which model is running, or who operates the agent. Fields marked **claim** are self-declared by the signer and are metadata for display and diagnostics only; they must never gate authorization.

## 1. Agent identity (implemented)

The persistent wallet key. One wallet key is one agent identity.

| Field       | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `walletId`  | `agent:<fingerprint>`, derived from `publicKey` |
| `publicKey` | P-256 public JWK (`kty`, `crv`, `x`, `y` only)  |

Security boundary: key possession only. Recovery or rotation yields a new `walletId` (see `docs/RECOVERY.md`). A display name is never identity.

## 2. Instance identity (implemented)

One running instance of an agent, distinct from the key. A wallet may legitimately run in several places (tabs, devices); each is an instance. Instance ids exist so that cloned storage can be noticed.

- `createInstanceId()` returns `inst:` plus 128 random bits as 22 base64url characters.
- `bindInstance(wallet, instanceId)` returns an `ai-auth-instance-binding` v1, domain `ai-auth-instance-binding/v1\n`.

| Field                   | Rule                                      |
| ----------------------- | ----------------------------------------- |
| `type`, `v`             | `"ai-auth-instance-binding"`, `1`         |
| `instanceId`            | matches `^inst:[A-Za-z0-9_-]{22}$`        |
| `walletId`, `publicKey` | the binding wallet; id must match the key |
| `issuedAt`              | ms                                        |
| `signature`             | by the wallet key                         |

An instance id is bound to exactly one wallet. `verifyInstanceBinding` checks shape, key and signature.

**Clone diagnostics.** `createCloneDetector().observe(verifiedDescriptor)` returns `clone-suspected` diagnostics with a `reason`:

- `wallet-multiple-instances`: one wallet presented two different instance ids.
- `instance-multiple-sessions`: one instance id is live in two sessions.
- `instance-wallet-mismatch`: an instance id appeared under a different wallet.

Detection is advisory. It reports; it does not revoke or block. A wallet may have several instances legitimately, so the application decides the policy. It only sees what reaches the observing peer.

## 3. Agent descriptor (implemented)

Signed self-description, `ai-auth-agent-descriptor` v1, domain `ai-auth-agent-descriptor/v1\n`, protocol version 1. Attached to the connect flow: when the wallet approves a v2 permission request it may add the descriptor to the signed `connect/consent` payload as `agentDescriptor`. Binding: `sessionId` and `nonce` are the request nonce, `origin` is the request audience, `room` is the request room, `capabilities` are a subset of the approved capabilities, and `expiresAt` is the challenge expiry. `verifyConsentAgent` (called by `verifyPermissionConsent` and `connectAIAuthModal`) rejects a descriptor whose wallet is not the consent issuer, whose binding differs, or whose signature fails; the whole connection is then refused. Consents without a descriptor (0.4.x wallets, legacy v1) still verify and yield no participant. A legacy v1 consent that carries a descriptor is rejected.

| Field                          | Rule                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- |
| `type`, `v`, `protocolVersion` | `"ai-auth-agent-descriptor"`, `1`, `1`                                     |
| `walletId`, `publicKey`        | identity; id must match key                                                |
| `instanceId`                   | section 2                                                                  |
| `agentType`                    | **claim.** Printable ASCII, 1 to 64 characters                             |
| `runtime`                      | **claim.** `{ name, version }`, printable ASCII                            |
| `provider`, `model`            | **claim**, or `null`                                                       |
| `sessionId`                    | 8 to 128 characters; the session this descriptor is for                    |
| `origin`, `room`               | exact origin and room; verifier must match both                            |
| `capabilities`                 | up to 32 scope-shaped strings the agent _asks_ for. A request, not a grant |
| `nonce`                        | verifier-issued challenge, 16 to 128 base64url characters                  |
| `issuedAt`, `expiresAt`        | lifetime at most 10 minutes (default 2)                                    |
| `signature`                    | by the wallet key                                                          |

`verifyAgentDescriptor(d, { expectedOrigin, expectedRoom, expectedNonce, now })` requires all three expectations. Reasons: `malformed`, `unsupported-version`, `lifetime-out-of-bounds`, `not-yet-valid`, `expired`, `expectations-required`, `wrong-origin`, `wrong-room`, `wrong-nonce`, `wallet-mismatch`, `bad-signature`.

Boundaries: the verifier must issue the nonce and accept it once; the descriptor does not store used nonces. **`agentType`, `runtime`, `provider` and `model` are claims, not attestations.** Nothing proves the agent runs that model or runtime. A passing descriptor means this key signed these claims for this origin, room, nonce and time.

## 4. Membership (implemented)

Site authorization for an identity: `ai-auth-membership` v1, domain `ai-auth-membership/v1\n`. Issued by a site or host key that the verifier's `trustPolicy.issuers` lists.

| Field                   | Rule                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| `id`                    | random, unique; the revocation target                               |
| `issuer`                | issuer public JWK; must be trusted                                  |
| `subject`               | the member's `walletId`                                             |
| `origin`, `room`        | exact; verifier must match                                          |
| `role`                  | `owner`, `member`, `observer` (observers hold only `*.read` scopes) |
| `scopes`                | up to 32; `*` only for owners                                       |
| `issuedAt`, `expiresAt` | lifetime bounded by `durationKind` (below)                          |
| `epoch`                 | optional integer, default 0 (section 10)                            |
| `durationKind`          | optional; one of the kinds below                                    |
| `signature`             | by the issuer                                                       |

**Duration.** `issueMembership(..., { duration })`:

| Kind            | `ttlMs`                  | Cap                                              |
| --------------- | ------------------------ | ------------------------------------------------ |
| `short`         | optional, default 15 min | clamped to 1 hour                                |
| `configured`    | required                 | at most 24 hours, else rejected                  |
| `long`          | required                 | clamped to 30 days                               |
| `until-revoked` | none                     | fixed 365-day signing horizon; re-issue to renew |

Without `duration` the legacy `ttlMs` rules apply (at most 24 hours). `until-revoked` is the longest-lived form and **never grants execution by itself**: protected operations also require an execution grant (section 11). The signed horizon is finite on purpose; there is no unbounded signature.

Membership is not authentication of a human. It says this site's issuer authorized this key for this room.

## 5. Session (implemented in the connect flow)

A bounded connection: one approval, one `sessionId`, one expiry. The wallet-signed connect request and consent already carry `origin`, `room`, `session`, `capabilities`, `nonce` and `expiresAt`, and a session ends at its expiry or disconnect. Session lifetime handling is being reworked separately; this contract does not change it. The agent descriptor and instance id attach to the session through `sessionId`. A session never outlives its consent, and a membership or grant does not extend it.

## 6. Presence (partly implemented)

Verified, live participation in a room, kept alive by a heartbeat lease.

- Implemented: `peer/hello`, `peer/heartbeat` and `peer/goodbye` events, signed per event. In restricted rooms the first two carry the membership proof. A peer is listed only after verification and is dropped when the lease lapses (heartbeat every 8 s; a peer is dropped after 24 s without one).
- Rule: presence requires a valid signature, and in restricted rooms a valid unrevoked membership. A display label in presence is a claim.
- **Private presence** (`P2PRoom` option `privateMode`): the participant joins and receives authorized room events and may send signed actions, but never sends `peer/hello`, `peer/heartbeat`, `peer/goodbye` or `presence/cursor` (the room refuses to), never answers a hello, and is never listed in a peer's presence list. In a restricted room it attaches its membership proof to each event it sends and sends `membership/prove` once to each direct peer so they will deliver room events to it. Its events are signed by its own wallet, so it cannot act as anyone else, and `room.audit()` keeps a bounded log of what it sent. This does not hide it from the transport: direct WebRTC peers and relays see the connection, and every event it sends names its wallet.
- Specified, not yet implemented: carrying `instanceId` and descriptor digest in presence so peers can run clone detection without extra messages.

Boundary: presence proves the key was recently live and (restricted) admitted. It does not prove the key is still authorized after a revocation this peer has not seen.

## 7. Room (implemented)

A named collaboration scope bound to an exact origin. The relay topic is a public SHA-256 of app id, origin and room; it is discovery, not access control.

- `open`: anyone who knows origin and room can join and send. Show `OPEN_ROOM_DISCLOSURE`. Open rooms never authorize protected operations.
- `restricted`: a verified membership is required before any non-presence event is delivered to a listener.

Data travels directly peer to peer. There is no AI Auth server and no relay-mediated application data.

## 8. Cursor

A protocol-level virtual position. It is data an agent publishes to say where it is working; it is **not** a physical mouse or an OS pointer and never moves one.

| Field       | Rule                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`, `v` | `"ai-auth-cursor"`, `1`                                                                                                                    |
| `pageKey`   | page or route key (for example the normalized path), at most 200 characters. The origin is implied by the room and is not part of this key |
| `x`, `y`    | finite numbers in **document coordinates** (CSS pixels from the top left of the document, not the viewport)                                |
| `selector`  | optional stable element hint                                                                                                               |
| `label`     | optional **claim**                                                                                                                         |
| `seq`       | per-sender monotonic integer; older values are dropped                                                                                     |

Cursor events are ordinary signed room events: they inherit signature, session, room, origin, nonce, replay and membership checks, and in restricted rooms require `presence.read`. Receivers clamp or reject out-of-range values, throttle, and render at most an overlay. A cursor grants no permission to click, type or run tools.

## 9. Revocation record (implemented)

`ai-auth-revocation` v1, domain `ai-auth-revocation/v1\n`.

| Field            | Rule                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| `id`             | random unique id; the dedupe key                                                        |
| `kind`           | `membership` (target = membership id), `link` (`link:<64 hex>`), `wallet` (`agent:...`) |
| `target`         | must match the pattern for `kind`                                                       |
| `origin`, `room` | exact; verifier must match                                                              |
| `issuer`         | signer JWK                                                                              |
| `issuedAt`       | ms; not more than 30 s in the future                                                    |
| `signature`      | by the issuer                                                                           |

Trust: the signer must be a trusted issuer, except that a wallet may revoke itself (`kind: "wallet"`, target equal to its own id). Application: idempotent by `id`; a replay is a no-op. A revocation is permanent for the policy instance and does not expire on its own. Link revocations older than ten years are rejected as stale.

**Propagation.** `createRevocationGossip(room)` publishes and receives `revocation/gossip` events through `room.send` and `room.subscribe`. Receivers verify, apply to the local policy, relay once, and ignore further copies by id. Invalid records are never relayed. Link revocations (`ai-auth-link-revocation`, wallet-signed, see `links.js`) travel as `{ "linkRevocation": <envelope> }` in the same gossip event; receivers verify them with `verifyLinkRevocation` and update `policy.revokedLinks` (and an optional site `createRevokedLinkSet`).

**Epoch announcements.** `ai-auth-epoch` v1, domain `ai-auth-epoch/v1\n`: `id`, `epoch`, `origin`, `room`, `issuer`, `issuedAt`, `signature`. Only a trusted issuer may sign one (no self-announcement). Applying it raises the epoch forward only (`policy.applyEpoch`). It travels as `{ "epoch": <record> }`.

**Catch-up.** When a peer first announces itself (hello or heartbeat; throttled to once a minute per peer), a non-private peer pushes `revocation/sync` to it, and a private peer sends `revocation/sync-request` instead (a request is answered with a sync). `revocation/sync` carries the latest epoch record plus at most 32 recent revocation and link-revocation records no older than 7 days and under 48,000 characters in total. Every item is verified and deduplicated exactly like live gossip, a receiver processes at most 32 items per list, and nothing in a sync is relayed.

## 10. Authorization epoch (implemented)

A per-site, per-room monotonic non-negative integer. Membership proofs and execution grants carry the epoch at which they were issued (absent means 0). A verifier holds the latest epoch it knows. `policy.bumpEpoch()` increments it and drops everything older; `policy.observeEpoch(n)` raises it to a value learned elsewhere and never lowers it. Proofs and grants with an epoch below the known epoch are rejected (`stale-epoch`). The epoch is local state: a peer that has not learned the new value still accepts old objects until they expire.

## 11. Tool authorization (implemented)

Protected operations (running tools, writing files, anything with side effects) need more than membership. `authorizeProtected({ policy, walletId, scope, now })` returns `{ allow: true }` only when all of these hold:

1. The room is restricted.
2. The wallet is not revoked and has a live, unrevoked membership.
3. The membership epoch is current.
4. The membership grants `scope` (owners with `*` grant any).
5. A live execution grant exists for the same membership id, with the current epoch, and lists `scope`.

Otherwise it returns `{ allow: false, reason }` (for example `no-execution-grant`, `grant-expired`, `stale-epoch`, `revoked`, `missing-scope`). Any missing or invalid input denies.

**Execution grant**: `ai-auth-execution-grant` v1, domain `ai-auth-execution-grant/v1\n`. Fields: `id`, `issuer`, `subject`, `origin`, `room`, `membershipId`, `scopes` (no `*`), `epoch`, `issuedAt`, `expiresAt`, `signature`. Lifetime at most 15 minutes (default 5). Renew by issuing a new grant (`renewExecutionGrant`); the issuer decides whether to renew. The grant TTL bounds how long a peer that missed a revocation can still act.

`connectAIAuthModal({ participation: { policy } })` enforces step 1 to 5 on the page: a remote `tool-request` that fails `authorizeProtected` is dropped before any listener sees it, and `connection.participation.authorizeProtected(walletId, scope)` exposes the same check to tool layers. Without a policy the connection behaves as in 0.4.x (the human approval gate is the only check); this is opt-in, not a default.

The human approval callback required by the in-page agent bridge is a separate, additional gate. `authorizeProtected` does not replace it.

## 12. Runtime adapter contract (specified)

An adapter lets a particular agent runtime (a CLI agent, an in-page agent, an MCP server) use AI Auth without the SDK knowing the runtime. The contract:

- The adapter holds or is handed a wallet and acts only as that identity.
- It builds an agent descriptor (section 3), binds a stable instance id, and attaches the descriptor to the connect request when that path ships.
- Its descriptor fields are claims.
- It exposes tools only through capabilities the session approved, and gates each protected call through `authorizeProtected` plus the site's human approval.
- It releases the instance on disconnect and surfaces `clone-suspected` diagnostics to its host.
- It never receives private keys it did not create, and never forwards credentials or private page data into a room.

No adapter code is added by protocol version 1; existing adapters (`agent-connect`, the runtime and MCP packages) keep their current behavior.

## Compatibility and migration from 0.4.x

- Additions only. All 0.4.x exports and signed formats are unchanged. The wallet envelope (`docs/WIRE_FORMAT.md`) is untouched.
- 0.4.x peers do not know membership, revocation, grants or descriptors. They have no handler for event types such as `revocation/gossip` and cannot enforce restricted-room rules or revocations; open rooms behave as before. Interoperability of 0.4.x peers with the new event types has not been tested.
- A consent carrying `agentDescriptor` still verifies on 0.4.x verifiers: they do not check for unknown payload fields, so they ignore it (this was checked by reading `verifyPermissionConsent`, not by running a 0.4.x build). Membership proofs without `epoch` and `durationKind` stay valid byte for byte and count as epoch 0, so an epoch bump invalidates them. Proofs that carry the new optional fields are rejected as `malformed` by verifiers older than 0.5.0 (this release line); issue them only to 0.5.0+ verifiers.
- To adopt: keep open rooms as they are; for restricted rooms issue memberships (preferably with `duration` and `epoch`), add `createRevocationGossip(room)`, and gate protected operations with `authorizeProtected` plus execution grants.
- Unknown `v` values must be rejected, not downgraded. A change to signed semantics needs a new `v`.

## Presence tracker and discovery (implemented in `presence.js`, `discovery.js`)

`createPresenceTracker` keeps one entry per verified wallet and session. Cursors follow section 8: `pageKey` plus document coordinates (finite, 0 to 1,000,000), a per-peer monotonic `seq`, and an optional label claim. A peer is `online` while its lease is fresh, `offline` after 16 seconds without a heartbeat, and removed together with its cursor after 24 seconds or on `peer/goodbye`. Stale or repeated `seq` values and invalid fields are dropped without changing state. The tracker consumes events the room has already verified; it does not verify signatures itself. The optional discovery file is described in `DISCOVERY.md`.
