# Feature → code → test traceability

This matrix is the audit behind the claim "the documented features work". A
feature is only marked **verified** when a test exercises its behaviour, not
when an identifier merely exists. "Browser E2E" means the multi-agent scenario
on the example site (`docs/E2E.md`); "scenario" means `tests/agent-scenarios.test.mjs`.

Run everything offline with `npm run test:all` and
`node --test tests/agent-scenarios.test.mjs`. Connection-bound presence is
covered by `tests/connection-lifecycle.test.mjs` (12 tests). The generic browser
scenario is `npm run test:e2e` and the Body4AI scenario is
`npm run test:e2e:body4ai`; both need Chromium plus relay/ICE connectivity.

## Identity and wallet

| Feature                                          | Code                                                                               | Evidence                                                              | Status                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------- |
| Stable, cryptographically derived identity       | `packages/p2p/index.js` (`identityFor`, `signEnvelope`)                            | `p2p-wallet.test.mjs`, `agent-identity.test.mjs`                      | Verified (unit)            |
| Browser key generation and origin-scoped storage | `packages/p2p/index.js` (IndexedDB wallet)                                         | `p2p-wallet.test.mjs`; browser E2E wallet creation                    | Verified (unit + E2E)      |
| Headless key generation, encrypted file storage  | `packages/agent/keystore.js`                                                       | `keystore.test.mjs` (permissions, corruption, wrong passphrase)       | Verified (unit)            |
| Backup, restore, rotate, delete                  | `packages/agent/keystore.js`                                                       | `keystore.test.mjs`; `docs/RECOVERY.md`                               | Verified (unit)            |
| Signed messages and actions                      | `signEnvelope` / `verifyEnvelope` in `packages/p2p`                                | `e2e.test.mjs`, `agent-scenarios` A/F, browser E2E steps 9/20         | Verified (unit + E2E)      |
| Challenge-response consent                       | `createPermissionRequest` / `approvePermissionRequest` / `verifyPermissionConsent` | `e2e.test.mjs`, `connect-cancel.test.mjs`, browser E2E step 2         | Verified (unit + E2E)      |
| Site-specific capabilities                       | `packages/p2p/capabilities.js`, `P2PRoom` policy                                   | `participation.test.mjs`, browser E2E steps 11/18                     | Verified (unit + E2E)      |
| Session length, renewal, expiry, idle end        | `packages/p2p/session.js`                                                          | `session-lifetime.test.mjs`, browser E2E step 3                       | Verified (unit + E2E)      |
| Revocable permissions and links                  | `packages/p2p/revocation.js`, `links.js`                                           | `revocation.test.mjs`, `site-links.test.mjs`, browser E2E steps 15/16 | Verified (unit + E2E)      |
| Multiple independent wallets                     | separate IndexedDB / keystore per agent                                            | scenario A (three wallets); browser E2E (six participants)            | Verified (scenario + E2E)  |
| Reconnection with the same identity              | `packages/agent/runtime.js` (`resume`, `join`)                                     | `runtime.test.mjs`, scenario E                                        | Verified (unit + scenario) |
| Concurrent sessions of one identity              | —                                                                                  | `packages/agent/README.md` says a keystore clone is the same identity | **Limitation**             |

## Agent, runtime, connection, room

| Feature                                              | Code                                       | Evidence                                                  | Status                           |
| ---------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------- | -------------------------------- |
| Identity outlives a connection                       | keystore + `runtime.js`                    | scenario E; `runtime.test.mjs` restart/resume             | Verified (scenario)              |
| Runtime owns the connection; page close is unrelated | `packages/agent/runtime.js`, `NostrWebRTC` | scenario B; browser E2E step 12                           | Verified (scenario + E2E)        |
| Presence ends when the runtime ends (no ghost)       | heartbeat leases + `peer/goodbye`          | `presence.test.mjs`, `runtime.test.mjs`, scenario E       | Verified (unit + scenario)       |
| A visitor returning sees identities and cursors      | `createAIAuthAgentClient`, `presence.js`   | `agent-client-presence.test.mjs`, scenario C, E2E step 13 | Verified (unit + scenario + E2E) |
| Rooms are shared environments, open or restricted    | `packages/p2p/p2p.js`, `membership.js`     | `p2p-transport.test.mjs`, `participation.test.mjs`        | Verified (unit + E2E)            |
| Private presence mode                                | `P2PRoom({ privateMode })`                 | `participation.test.mjs`, browser E2E step 19             | Verified (unit + E2E)            |
| Reconnect after transport loss                       | backoff + rejoin in `runtime.js`           | `runtime.test.mjs` (backoff, silent transport)            | Verified (unit)                  |

## Tools

| Feature                                           | Code                                                      | Evidence                                                                         | Status                     |
| ------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------- |
| Page tools: catalog, request, response, cancel    | `packages/p2p/webmcp.js`, `embed.js`                      | `webmcp-contract.test.mjs`, `in-page-agent.test.mjs`, `tool-addressing.test.mjs` | Verified (unit + E2E)      |
| Human approval for each page tool call            | `mountAIAuthInPageAgent({ authorize })`                   | `in-page-agent.test.mjs`, browser E2E step 10                                    | Verified (unit + E2E)      |
| Authorization failure cannot run a page tool      | membership/execution grants                               | `participation.test.mjs`, browser E2E steps 6/11                                 | Verified (unit + E2E)      |
| Page tools require the page open                  | catalog expiry + absent-site pruning                      | scenario D2; `webmcp-contract.test.mjs`                                          | Verified (scenario)        |
| Agent-provided tools with no browser              | `packages/agent/tool-provider.js`, `runtime.provideTools` | `tool-provider.test.mjs` (7 tests), scenarios D/F                                | Verified (unit + scenario) |
| Tool calls are authorized by the provider's owner | `createToolProvider({ authorize })`                       | `tool-provider.test.mjs` (denied call never runs the handler)                    | Verified (unit)            |
| Bounded tools: size, count, timeout, concurrency  | `packages/agent/tool-provider.js`                         | `tool-provider.test.mjs` (oversized result, failure)                             | Verified (unit)            |
| MCP exposure of participant tools                 | `packages/mcp/bridge.js` (`listTools`, `invoke`)          | `bridge.test.mjs`, scenarios D/F                                                 | Verified (unit + scenario) |
| MCP built-in room tools (`--provide room`)        | `packages/mcp/bridge.js`, `cli.js`, `cli-args.js`         | `bridge.test.mjs`, `cli.test.mjs`                                                | Verified (unit)            |

## Connection-bound presence and WebMCP

| Feature                                                          | Code                                                         | Evidence                                                                                           | Status                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------- |
| Strict `connected` requires live authenticated transport         | `packages/p2p/connection-state.js`, `packages/mcp/bridge.js` | `connection-lifecycle.test.mjs` 1; `connection-state.test.mjs`; `cli.test.mjs`                     | Verified (unit)            |
| Heartbeat lease + implicit offline on silence                    | `packages/p2p/p2p.js`, `presence.js`, `runtime.js`           | `connection-lifecycle.test.mjs` 5; `presence.test.mjs`                                             | Verified (unit)            |
| Immediate invalidation on channel/ICE failure                    | `P2PRoom.invalidateSource`, `NostrWebRTC.handleChannelLost`  | `connection-state.test.mjs` (peer-connect-failed → reconnecting)                                   | Verified (unit)            |
| Reconnect with new generation, same identity                     | `runtime.js` (`join`, `setGeneration`)                       | `connection-lifecycle.test.mjs` 7; `agent-scenarios` E                                             | Verified (unit + scenario) |
| Expired/revoked authorization blocks reconnect                   | `runtime.js` (`authorization`, `setAuthorization`)           | `connection-lifecycle.test.mjs` 8; `session-lifetime`/`revocation` tests                           | Verified (unit)            |
| One live runtime per identity in a process                       | `runtime.js` (`liveIdentities`)                              | `connection-lifecycle.test.mjs` 12                                                                 | Verified (unit)            |
| Page WebMCP catalog is connection-bound                          | `webmcp.js`, `embed.js`                                      | `connection-lifecycle.test.mjs` 9; `agent-client-presence.test.mjs`                                | Verified (unit)            |
| Schema validation and stable tool error codes                    | `webmcp.js`, `tool-provider.js`, `bridge.js`                 | `connection-lifecycle.test.mjs` 3/9; `webmcp-contract.test.mjs`                                    | Verified (unit)            |
| Browser connected/disconnected/tool-withdrawn evidence           | `scripts/test-browser-e2e.mjs`                               | `generic-site-connected.png`, `generic-site-disconnected.png`, `generic-agent-tools-withdrawn.png` | Verified (browser E2E)     |
| Code Mode (worker-thread script over checked APIs, kill timeout) | `packages/mcp/bridge.js` (`--code-mode`)                     | `bridge.test.mjs`, `code-mode-timeout.test.mjs`                                                    | Verified (unit)            |

## Integration and user experience

| Feature                                            | Code                               | Evidence                                                                                 | Status                               |
| -------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------ |
| Copyable connect instruction and connect panel     | `packages/p2p/agent-connect.js`    | `agent-connect.test.mjs`, scenario G, browser connect flow                               | Verified (unit + scenario + browser) |
| SDK works on a generic site with no example code   | public package exports             | scenario G (generic origin, no private imports)                                          | Verified (scenario)                  |
| Example site: identity, cursor, chat, wheel, tools | `examples/body4ai/site/*`          | browser E2E steps 1–20; site `e2e/visual/body4ai-visual.mjs`                             | Verified (browser E2E)               |
| MCP over stdio and HTTP                            | `packages/mcp/index.js`, `http.js` | `server.test.mjs`, `cli.test.mjs`                                                        | Verified (unit)                      |
| Claude Code as a harness                           | `packages/mcp` docs                | `docs/agents.md` 2026-11-15 record                                                       | Verified (manual)                    |
| Codex as a harness                                 | `packages/mcp` docs                | registration only; model call blocked by usage limit                                     | **Limitation**                       |
| OpenCode as a harness                              | `packages/mcp` docs                | connected and listed tools; no completed call                                            | **Limitation**                       |
| ChatGPT desktop plugin harness                     | `--http` MCP endpoint              | `docs/agents.md` harness notes; 2026-11-16 three-agent run (A/C active, B manual re-add) | Verified (manual)                    |

## Remaining limitations (real, not hidden)

1. **A connection lasts only while its runtime runs.** There is no hosted agent
   host, and none is required. When ChatGPT, Codex, Claude Code, OpenCode or a
   custom process stops (or loses networking), its connection ends. Identity
   stays in the wallet and the next connection reuses it. Non-expiring sessions
   do not keep a dead process alive.
2. **Page tools need a page.** Only the site's page can run them. With no page
   open they disappear from the catalog; callers get an explicit unavailable
   answer. Agent-provided tools (`provideTools`, `--provide room`) are the
   category that works without a page.
3. **No TURN.** Direct WebRTC fails on some NAT/firewall combinations. The
   runtime reports diagnostics and stays `waiting-for-peers`; it does not
   silently fall back.
4. **One identity, one live runtime.** Copies of a keystore are the same
   identity. A second live runtime with the same identity is now rejected within
   one process; cross-process lease coordination is still unsupported.
5. **Codex and OpenCode tool calls are not verified end to end.** Their servers
   were registered and tools discovered, but no model-initiated call completed
   in the recorded runs.
6. **ChatGPT plugin B needs one manual re-add.** Its HTTP endpoint is a
   credential printed by the CLI, and its public hostname changed when the
   process/quick tunnel restarted. ChatGPT keeps the stale URL, so the plugin
   must be removed and added again with the current URL. Agents A and C still
   work. The current URL is reported out of band; it is deliberately not
   committed because the secret path is the credential.
7. **Node scenario tests use an in-process transport.** They verify signing,
   routing, and lifecycle, not real relay/ICE behaviour. The browser E2E is the
   real-network evidence.
8. **No Playwright screenshot exists for `reconnecting`.** The state is exposed
   in `ai_auth_status` and asserted by unit tests, but the generic browser UI
   does not yet surface a distinct reconnecting badge. Screenshots cover
   connected, disconnected, and withdrawn-tool states.
9. **Cross-network/symmetric-NAT behavior is not proven.** The real-browser
   evidence uses one machine/network; there is no TURN.
