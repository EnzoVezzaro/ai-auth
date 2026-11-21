# User-first end-to-end acceptance plan: Connect Agent

Status: proposed testing contract; not evidence that all flows pass. Scope: AI Auth SDK, wallet, headless runtime, MCP bridge, example consumer generic independent fixture. No protocol replacement.

## 1. User journey (product acceptance)

**Persona:** a nontechnical visitor and their assistant. The visitor opens an AI Auth-enabled site on HTTPS, clicks **Connect Agent**, creates an agent identity with a recovery passphrase, downloads the encrypted backup and install package, pastes the printed install command into their assistant, then sees the agent join a shared space with other humans and agents. The site's own guided flow uses four phases — CREATE, BACKUP, INSTALL, CONNECTED; the headless agent creates its own key and needs no human wallet approval in this flow.

1. **Discover:** Button is visible and understandable. Copy contains only public origin, room, wallet URL, and capabilities; optional `/.well-known/ai-auth.json` discovery. No private keys, MCP bearer secrets or session tokens in copyable/public URLs.
2. **Choose harness:** Test Claude Code, Codex, OpenCode, ChatGPT desktop and ChatGPT web separately. Record whether each supports skill installation, local stdio MCP, remote MCP, or no supported path. A copied instruction cannot install tools or grant permissions by itself. Mark unsupported rather than silently claiming success.
3. **Approve:** Show identity, site origin, exact room, requested capabilities, session duration and privacy disclosure. Decline, narrow scopes, and cancel all leave the site unchanged.
4. **Join:** Only show “Connected” after authenticated direct peer channel opens. Show distinct waiting, signaling, degraded, disconnected, expired and revoked states. Peer roster, cursor/presence and activity should reflect live status.
5. **Collaborate:** Human A, agent A and agent B share a room. Exchange signed messages, targeted messages and delivery receipts; move cursors; discover a page tool; request an action; page owner approves; the action runs once and its result/status is visible. Denial must not execute.
6. **Continuity:** Reconnect after temporary transport loss. Headless agent persists while its process lives, not after it stops. Refreshing a browser page requires explicit Resume; no invisible reauthorization. A new room requires fresh approval.
7. **Exit:** Leave, expire, revoke membership/grant, close tab/process. Verify protected actions stop, stale peers disappear and rejoin cannot widen scopes.
8. **Decentralization:** Demonstrate no AI Auth account, central key service, or mandatory application backend. Nostr relays are signaling dependencies, WebRTC transports direct traffic. When direct connectivity fails without TURN, report failure honestly; do not promise universal connectivity.

## 1b. Audit-aligned flow and proof model (2026-11-20)

This section **extends** the generic contract above; it does not replace section 1 and it introduces no new protocol. It reflects the flow and vocabulary of `docs/AGENT_IDENTITY_UX_AUDIT_2026_11_20.md`. Like the rest of this document, it is a testing contract, not evidence that the flows pass. The functional work referenced here is being implemented by other workers and is marked PENDING in the [changelog](../CHANGELOG.md#unreleased).

### Three user-visible chapters

| Chapter               | What the person does                                                                                                           | What must NOT be claimed here                                                                        | Relation to the four implementation phases |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Choose** (Connect)  | Press one primary action, pick a harness or the manual path, and reuse or create an identity with explicit permission.         | That a detected harness or a copied instruction is already authorized or installed.                  | CREATE (entry), harness selection          |
| **Approve / Install** | Approve local setup on this device, create or import the encrypted identity with a recovery choice, and back it up.            | That an install package or a local keystore file alone proves a running agent controls the identity. | CREATE, BACKUP, INSTALL                    |
| **Verify & Connect**  | The target instance signs a verifier-issued fresh challenge; the owner approves scoped site access; a live peer channel opens. | That a grant, a descriptor or endpoint reachability is the same as a live connection.                | CONNECTED, plus proof and authorization    |

The four implementation phases CREATE / BACKUP / INSTALL / CONNECTED remain the page's internal vocabulary. The three chapters are the user-facing story; they are a superset of the phases, not a rename. A browser-only or unsupported client gets honest manual steps and an explicit proof action, never a fake one-click installation. The per-client evidence lives in [Agent harness support](AGENT_HARNESS_SUPPORT.md).

### Five independent concepts

Never collapse these into one overloaded `connected` boolean. Each row needs its own test and its own UI state.

| Concept                     | What it is                                                                                      | What proves it                                                                                                                         | What does NOT prove it                                                                                 | Truthful UI state when satisfied     |
| --------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| **Identity**                | Persistent public agent wallet id; the agent controls a key.                                    | Key created or imported under explicit consent, with an installation receipt.                                                          | Creating a key alone; a saved grant; a self-asserted name or provider.                                 | Identity created / installed         |
| **Installation / instance** | Intended runtime instance id and locally verified install receipt.                              | Signed instance binding checked on local import (`verifyInstanceBinding`).                                                             | A copied install package; a keystore file present on disk; a copied descriptor from another process.   | Identity installed on this device    |
| **Proof of possession**     | Response to a verifier-issued nonce signed by the active instance key.                          | Fresh single-use nonce, expected wallet id and instance id, exact origin/room/request context, signing key and timestamp all verified. | An install receipt, a heartbeat, a message from a different peer, or a replayed/copied descriptor.     | Identity verified on this connection |
| **Authorization**           | Owner-approved capabilities for a specific site/session, with duration, refusal and revocation. | Valid signed grant for the current origin, room, effective scopes and lifetime.                                                        | Requested or default scopes; a grant that is expired, revoked or for another site; transport liveness. | Access approved (effective scopes)   |
| **Connection**              | Authenticated live peer data channel for the expected identity and current generation.          | Lifecycle reaching `direct-peer-connected` with the expected peer authenticated for this origin, room, session and nonce.              | MCP endpoint reachable, discovery, room membership, presence, or a key created earlier.                | Connected now                        |

Trust/claim levels, lowest to highest: `Public claim` (name, provider, model, runtime — self-reported), `Key verified` (valid signature over the current verifier challenge by the expected key), `Instance matched` (expected instance binding and challenge context), `Authorized` (signed site grant valid for current origin, room, scopes and lifetime), `Online` (authenticated data channel open now for that identity). No level attests a vendor's model software or a physical machine.

### Additional acceptance assertions

- A peer arriving before, during or after a pairing never completes another pairing; mismatched wallet, instance, nonce, origin, room, signature or stale generation fails closed.
- Key creation, key import, saved grant, discovery, room registration, an endpoint answering, or wallet consent alone never produce a "Connected" state.
- Requested and default capabilities are never displayed as approved. Show exactly the verified effective scopes; if they cannot be determined, show "Permissions not verified".
- "Identity verified" may remain as a historical fact when the peer goes offline; "Connected now" must clear immediately on transport loss, expiry or revocation.
- A locally imported backup without a fresh signed response is "installed", not "online". Runtime/provider/model claims are labeled self-reported.
- Deny, cancel and revoke have no side effects on scopes and widen nothing; a signed safe test ping cannot invoke arbitrary site tools.
- Harness results follow the evidence rules in [Agent harness support](AGENT_HARNESS_SUPPORT.md); ChatGPT web is tested independently from desktop, and no result is inferred from a listed MCP server.

## 2. Automated tests (code perspective)

**Unit/contract:** connect-instruction schema and clipboard secrecy; origin/nonce/room/scope/expiry signature checks; restricted/open room policy; approval narrowing; state machine illegal transitions; tool catalog validation; action authorization per call; signed receipt identity; event bounds and untrusted input; error codes; revocation epoch; Code Mode optionality and cancellation/partial side effects.

**Integration:** real SDK wallet + two browser peers + headless agent + MCP tool bridge; origin isolation; room isolation; signed message/receipt; tool invocation with explicit approval; denial; reconnect; expiration; resume; process termination; malformed peer traffic.

**Browser E2E:** Playwright (or existing browser harness), deterministic fixture site and independent consumer smoke test. Click Connect Agent -> copy -> parse -> approve -> connect -> show roster -> send message -> invoke safe demo action -> revoke -> verify denial. Use controlled fake clipboard where needed and a real browser for WebRTC behavior. Never mock the data channel in the network acceptance suite.

**Network E2E:** retain existing `.github/workflows/e2e-network.yml`; test real WebRTC on two isolated processes and browsers, signaling relay reachable/unreachable, blocked UDP/NAT case, dropped connections, delayed gossip, bounded catch-up. Run separate local deterministic and opt-in external-network suites; do not make flaky external infrastructure a prerequisite for every PR.

**Harness compatibility:** manual reproducible matrix with date, version, platform, transport, installation steps, approvals, status tool result, screenshot/log redaction, and outcome PASS / FAIL / BLOCKED / UNSUPPORTED / NOT TESTED. Do not call a listed MCP server proof of a completed tool call. ChatGPT web must be tested independently from desktop; no claim of arbitrary remote MCP connectivity without evidence.

**Security adversarial:** malicious connect instructions, prompt injection from peer messages, forged origin/room, replayed nonce, scope escalation, tool catalog flood, private/public room confusion, untrusted scripts in Code Mode, HTTP MCP secret leakage, revoked-but-offline peer, unsafe action retry after timeout. Verify fail-closed behavior and bounded effects.

## 3. Implementation map and test ownership

- A neutral standalone test fixture (new `tests/fixtures/connect-agent-site/`): human-visible connect UX and safe demo tools; no product-specific integration.
- `packages/p2p/`, wallet SDK: signed session lifecycle, peers, WebRTC, rooms, authorization.
- `packages/agent/`: encrypted headless identity, reconnect, heartbeat, persistence.
- `packages/mcp/bridge.js`: status, join, events, message, cursor, tool catalog, invocation, optional code mode.
- `tests/agent-connect.test.mjs`, `tests/agent-connection-e2e.test.mjs`, `tests/agent-scenarios.test.mjs`: extend existing generic tests rather than duplicate them.
- `.github/workflows/ci.yml` and `.github/workflows/e2e-network.yml`: separate deterministic PR gates from live network tests.

## 4. Execution order

P0: baseline inventory of existing tests, fixture and reproducible manual neutral fixture walkthrough; record actual behavior and missing cases.

P1: deterministic user journey tests for copy, approval, join, presence, messaging, safe action, rejection, revoke and exit.

P2: real-browser/multi-peer WebRTC and MCP integration with evidence that `connected=true` means a real data channel.

P3: harness matrix with a **separate** ChatGPT web result; document supported setup and limitations.

P4: network failures, privacy and adversarial security; prioritize any uncovered authorization bypass.

P5: release gate: one-command smoke path, artifact logs with secrets redacted, compatibility table and release notes.

## 5. Definition of done

- Every user-visible step has a repeatable test and expected status.
- At least one supported assistant completes discovery -> approval -> live join -> signed collaboration -> approved site action -> revocation -> exit on a real data channel.
- Browser, headless, and MCP boundaries are tested without conflating session validity with live connectivity.
- All denied, expired, revoked and out-of-room tool calls fail closed; side effects and receipts are distinguishable.
- Compatibility matrix accurately states ChatGPT web support or lack thereof; no marketing claim exceeds evidence.
- CI reports deterministic checks, network suite reports its environment and limitations; maintainers can reproduce results.
- Existing code, protocols, and PR #14 work are not replaced or duplicated. This PR is the acceptance specification; implementation and passing test evidence come in follow-up commits/PRs.
