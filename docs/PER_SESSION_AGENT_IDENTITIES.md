# Per-session agent and subagent identities — design proposal

Status: proposed; implementation and harness validation pending.

## Product contract

Every distinct agent session has its own cryptographic identity. Each spawned subagent has a separate identity linked to its parent through a signed delegation. The identity belongs to the agent session, not to a website, provider account, or harness installation.

A newly created session receives a new identity automatically. A resumed session reuses the existing identity **only if** its original key material is recoverable and the session identity can be verified. Never silently replace an expected identity when its keystore is missing or corrupted. Closing a process does not necessarily terminate the logical session. Irrecoverably lost keys mean continuity cannot be proven.

## User journey

1. A website embeds the AI Auth SDK and shows **Connect agent**.
2. A user opens a small connect panel and copies a short-lived, single-use connection instruction/link containing public connection details and a challenge, not a secret key.
3. The user passes it to a Codex, Claude Code, OpenCode or other supported agent session.
4. The harness adapter discovers or provisions the identity for that **specific session**, then proves possession of its private key with a challenge signature.
5. The site verifies the signature, audience, nonce and expiry, requests explicit capability consent, and separately establishes authenticated peer transport.
6. The UI distinguishes **identity verified**, **permissions approved**, and **agent online**. Only a live authenticated transport qualifies as online.
7. When the agent spawns a subagent, the adapter automatically provisions a fresh identity and issues a parent-signed, narrowly scoped delegation. New privileges require an additional approval; delegation cannot silently expand the parent's authority.

## Identity and lifecycle model

- Identity fields: public key / stable key-derived ID, session ID, harness type, creation time, state, and optional parent ID plus signed delegation. Provider/model/runtime labels are untrusted claims unless independently attested.
- States: created, identity-verified, authorized, connecting, online, offline, expired/revoked, lost. Identity, authorization and transport liveness must not be conflated.
- Session-scoped keystores must be isolated from other chats and subagents. Persist encrypted material only when the harness supports secure restoration; never write private keys into links, room messages, logs or site storage.
- On restart, reattach to the same identity only when both session continuity and key possession are proven. A new chat always gets a distinct identity, even on the same installation.
- Parent/child relationships are explicit signed edges. Revoking a parent delegation must stop downstream authorization as soon as verifiers observe it; account for the existing eventual-consistency revocation model and short-lived grants.
- Agent creation is automatic; access to external resources is never automatic merely because an identity exists.

## Integration boundaries and compatibility

Reuse the existing wallet, headless encrypted keystore, signed consent, capability checks, WebRTC connection-state machine, MCP bridge and revocation facilities. Do not introduce a second competing identity protocol. Add a session identity manager and per-harness lifecycle adapters; determine empirically which harnesses expose stable chat IDs, spawn hooks, resume events and child-agent IDs. Do not claim universal automatic subagent detection until verified.

## Acceptance criteria

- Two chats in the same harness get different public identities.
- A restarted process resuming a recoverable chat retains its identity; an unrecoverable key fails closed.
- Two child agents get distinct identities, both verifiably linked to their parent.
- Child permissions never exceed delegated parent permissions; escalation requires explicit user approval.
- A copied connect link cannot be reused or replayed; signatures and audiences are verified.
- The UI never reports “connected” based solely on a stored grant or key: authenticated live peer connectivity is required.
- Disconnect, expiry, revocation and offline states are distinguishable and tested.
- Tests cover Codex, Claude Code and OpenCode adapters separately; unsupported hooks and behaviors are documented.

## Out of scope for this PR

Runtime implementation, claiming that all harnesses support session-level hooks, production verification and redesigning the entire wallet UI. This is an implementation-ready contract for a subsequent agent to build and test.
