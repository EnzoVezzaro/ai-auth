# User-first end-to-end acceptance plan: Connect Agent

Status: proposed testing contract; not evidence that all flows pass. Scope: AI Auth SDK, wallet, headless runtime, MCP bridge, example consumer generic independent fixture. No protocol replacement.

## 1. User journey (product acceptance)

**Persona:** a nontechnical visitor and their assistant. The visitor opens an AI Auth-enabled site on HTTPS, clicks **Connect Agent**, copies a public instruction/link, pastes “Connect to this website” into their assistant, reviews requested origin/room/scopes, approves, and sees the agent join a shared space with other humans and agents.

1. **Discover:** Button is visible and understandable. Copy contains only public origin, room, wallet URL, and capabilities; optional `/.well-known/ai-auth.json` discovery. No private keys, MCP bearer secrets or session tokens in copyable/public URLs.
2. **Choose harness:** Test Claude Code, Codex, OpenCode, ChatGPT desktop and ChatGPT web separately. Record whether each supports skill installation, local stdio MCP, remote MCP, or no supported path. A copied instruction cannot install tools or grant permissions by itself. Mark unsupported rather than silently claiming success.
3. **Approve:** Show identity, site origin, exact room, requested capabilities, session duration and privacy disclosure. Decline, narrow scopes, and cancel all leave the site unchanged.
4. **Join:** Only show “Connected” after authenticated direct peer channel opens. Show distinct waiting, signaling, degraded, disconnected, expired and revoked states. Peer roster, cursor/presence and activity should reflect live status.
5. **Collaborate:** Human A, agent A and agent B share a room. Exchange signed messages, targeted messages and delivery receipts; move cursors; discover a page tool; request an action; page owner approves; the action runs once and its result/status is visible. Denial must not execute.
6. **Continuity:** Reconnect after temporary transport loss. Headless agent persists while its process lives, not after it stops. Refreshing a browser page requires explicit Resume; no invisible reauthorization. A new room requires fresh approval.
7. **Exit:** Leave, expire, revoke membership/grant, close tab/process. Verify protected actions stop, stale peers disappear and rejoin cannot widen scopes.
8. **Decentralization:** Demonstrate no AI Auth account, central key service, or mandatory application backend. Nostr relays are signaling dependencies, WebRTC transports direct traffic. When direct connectivity fails without TURN, report failure honestly; do not promise universal connectivity.

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
