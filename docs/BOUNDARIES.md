# SDK / website boundary

This repo is the SDK. A website is a downstream consumer. The two sides meet
only at the public API below. The SDK is generic: it must work for any origin,
any room, any catalog and any brand without modification.

## Ownership

| Side                | Owns                                                                                                                                                                                                                                          | Must not contain                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **SDK (this repo)** | Identity and keys; wallet signing; consent and sessions; room transport and presence protocol; cursors and activity events; WebMCP catalog and tool protocol; the headless agent runtime; the MCP server. It exposes a documented public API. | Any particular website's name, origin, room defaults, copy, language, branding, layout, catalog data or tools. |
| **Website**         | Its tools; its UI (connect button, panels, placement, copy, languages, dashboard); its policy (which capabilities it asks for, its room name); its data and hosting.                                                                          | Protocol internals, signing formats, or a private fork of the SDK.                                             |
| **Shared contract** | Only the public exports listed in the package type definitions and the documented events. Anything else is internal.                                                                                                                          | Undeclared imports, private modules, or assumed defaults.                                                      |

## Rules

**SDK rule.** Code and docs under `packages/` must stay site-neutral. Names,
origins, room defaults, copy, languages, branding, layout, catalog data and
tools belong to a website, never to the SDK. The only site-named material
allowed in this repo lives under clearly marked examples (`examples/`,
`packages/*/examples/`) and test fixtures (`tests/fixtures/`,
`packages/*/test/`). `tests/boundary-guard.test.mjs` fails when SDK package
source (`packages/**/*.js`, `*.mjs`, `*.ts`, outside examples and fixtures)
contains a site-specific name or origin.

**Website rule.** A website consumes the SDK through the public API only. It
supplies its own origin, room name, capability set, tool catalog, authorization
policy, copy, branding and hosting. It does not change signed formats or
protocol behaviour to fit itself, and it keeps its own data and UI in its own
repo.

**Shared-contract rule.** The contract is the named exports in
`packages/p2p/index.d.ts` (including its re-exported modules) and
`packages/agent/index.d.ts`, plus the documented events in the section below.
Everything not on that list is internal and may change. Neither side depends on
it. In particular, `promptSecret` is exported by `packages/agent/index.js` but
is **not** declared in `packages/agent/index.d.ts`, so it is internal, not
public API.

## Public API (verified runtime exports)

Derived from the declarations in `packages/p2p/index.d.ts` and
`packages/agent/index.d.ts` (including the modules they re-export), then checked
against a live import of each package entry on 2026-11-16. Type-only
declarations (interfaces and type aliases) are part of the typed contract but
are not runtime imports, so they are not in these lists.

### `@enzovezzaro/ai-auth-wallet` — 139 runtime exports (entry `packages/p2p/index.js`)

```text
AGENT_DESCRIPTOR_TYPE
AGENT_DESCRIPTOR_VERSION
AGENT_PROTOCOL_VERSION
CATCHUP_MAX_AGE_MS
CATCHUP_MAX_RECORDS
CHALLENGE_MAX_MS
COLLABORATION_LIMITS
CONNECTION_STATUSES
CONNECTION_TRANSITIONS
CONSENT_VERSION
CURSOR_TYPE
CURSOR_VERSION
CollaborationTransfers
DEFAULT_DESCRIPTOR_TTL_MS
DEFAULT_EXECUTION_GRANT_TTL_MS
DEFAULT_IDLE_TIMEOUT_MS
DEFAULT_SESSION_TTL_MS
DISCOVERY_PATH
DISCOVERY_TYPE
DISCOVERY_VERSION
DURATION_KINDS
DURATION_LIMITS
EPOCH_TYPE
EPOCH_VERSION
EXECUTION_GRANT_TYPE
INSTANCE_BINDING_TYPE
LINK_POLICY
MAX_DESCRIPTOR_TTL_MS
MAX_EVENT_AGE_MS
MAX_EXECUTION_GRANT_TTL_MS
MAX_MEMBERSHIP_TTL_MS
MAX_MESSAGE_CHARS
MAX_SEEN_EVENTS
MAX_SESSION_TTL_MS
MEMBERSHIP_TYPE
MEMBERSHIP_VERSION
MESSAGE_STATES
MIN_SESSION_TTL_MS
ManualWebRTC
NonceGuard
NostrWebRTC
OPEN_ROOM_DISCLOSURE
P2PRoom
RECEIPT_TYPE
RECEIPT_VERSION
REVOCATION_GOSSIP_EVENT
REVOCATION_KINDS
REVOCATION_SYNC_EVENT
REVOCATION_SYNC_REQUEST_EVENT
REVOCATION_TYPE
REVOCATION_VERSION
ROLES
ROOM_MODES
SENSITIVE_SELECTOR
SESSION_RECORD_VERSION
SessionLease
TOOL_ERROR_CODES
agentKeyFor
appendActivity
approveLink
approvePermissionRequest
authorizeProtected
bindInstance
buildCursorPayload
buildReceiptPayload
canResumeSession
canTransition
canonicalize
connectAIAuthModal
connectAIAuthPopup
createAIAuthAgentClient
createAIAuthConnectController
createAIAuthConnectInstruction
createAgentDescriptor
createCapabilityGrant
createCloneDetector
createConnectionState
createDeliveryLedger
createEpochRecord
createInstanceId
createLinkChallenge
createLinkNonceStore
createParticipationPolicy
createPermissionRequest
createPresenceTracker
createRevocation
createRevocationGossip
createRevokedLinkSet
createSessionStore
createSharedRoomTopic
createWallet
deriveLinkId
downloadBackup
extractSafeText
fetchDiscovery
forgetWallet
identityFor
importWalletBackup
inlineCreateWalletForm
isAddressedTo
isSensitiveElement
issueExecutionGrant
issueMembership
listLinks
listResumableSessions
loadWallet
mountAIAuthCollaboration
mountAIAuthConnectPanel
mountAIAuthInPageAgent
mountCollaborationWheel
parseCursorPayload
randomNonce
readActivity
recordFromConsent
registerAIAuthPageActions
renewExecutionGrant
resolveDuration
resumeAIAuthSession
sessionLimits
signEnvelope
unlink
validateCursor
validateDiscovery
verifyAgentDescriptor
verifyCapabilityGrant
verifyConsentAgent
verifyEnvelope
verifyEpochRecord
verifyExecutionGrant
verifyInstanceBinding
verifyLink
verifyLinkRevocation
verifyMembership
verifyPermissionConsent
verifyPermissionRequest
verifyPopupPermissionRequest
verifyReceipt
verifyRevocation
verifyStoredConsent
```

### `@enzovezzaro/ai-auth-agent` — 6 runtime exports (entry `packages/agent/index.js`)

```text
KeystoreError
NodeRTCPeerConnection
createAgentRuntime
createFileKeystore
createToolProvider
withNodeRtc
```

## Documented events

These listener registrations are the public event surface. All other messages
on internal channels are protocol internals.

- `P2PRoom.subscribe(listener)` — signed room traffic and peer diagnostics.
- `NostrWebRTC.onConnectionState(listener)` / `AgentRuntime.onConnectionState(listener)` — connection snapshots.
- `AIAuthPageConnection.onEvent(listener)` — signed page events; `onLifecycle(listener)` — connected/disconnected; `onDisconnect(listener)`; `onRoomReady(listener)` — room session.
- `AIAuthPageConnection.transfers.subscribe(listener)` — text, element, attachment and receipt events.
- `AIAuthAgentClient.onCatalog(listener)` — published WebMCP tool catalogs.
- `AgentRuntime.onEvent(listener)`, `onError(listener)`, `onPeerStale(listener)` — runtime traffic, errors and stale peers.
