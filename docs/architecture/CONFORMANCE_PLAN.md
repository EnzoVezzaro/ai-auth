# Conformance plan

> Status: proposed test requirements. None of these tests exist yet unless a row cites an existing file. "Independent" means a worker who did not author the change.

## 1. Fixtures

| Fixture                       | Purpose                                                                                       | Notes                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Harmless echo tool            | One per provider: `mcp:fixture/echo`, `webmcp:fixture/echo`, `utcp:fixture/echo`              | Same input/output shape, no side effects           |
| Duplicate-name fixture        | Two providers register `echo`                                                                 | Must not collide                                   |
| Malicious description fixture | Description instructs the agent to ignore policy or call payments                             | Must be treated as data                            |
| Expired grant fixture         | Capability and execution grants past expiry                                                   | Must fail closed                                   |
| Cross-origin fixture          | Request from an unauthorized origin                                                           | Must be denied for WebMCP and UTCP                 |
| Disconnect fixture            | Provider closes mid-invocation                                                                | Must cancel and fail closed                        |
| Private-network fixture       | UTCP endpoint at `127.0.0.1`, `169.254.169.254`, RFC1918 and a hostname resolving to loopback | Must be denied unless explicitly allowed by policy |
| Redirect fixture              | Remote URL redirects to loopback                                                              | Must not follow                                    |
| OAuth fixture                 | MCP server requiring OAuth bearer token                                                       | Must use native OAuth, not an AI Auth signature    |
| Replay fixture                | Same signed request twice                                                                     | Second must fail                                   |
| Downgrade fixture             | Unsupported protocol version                                                                  | Must fail safely                                   |
| Payment fixture               | Wallet with `tools.invoke` attempts a purchase or mandate                                     | Must be denied                                     |

## 2. Identity acceptance tests

| Test                                                           | Evidence status                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Existing wallet signs and verifies                             | `tests/did.test.mjs`, `tests/webmcp-contract.test.mjs` (existing) |
| Existing identity remains recognizable after additive adapters | Proposed                                                          |
| Independent verifier can verify new standardized proofs        | Proposed                                                          |
| No private-key export in ordinary operations                   | Existing design; test proposed                                    |
| Identity gains no permissions after migration                  | Proposed                                                          |
| Key rotation and recovery documented and tested                | `docs/RECOVERY.md`, keystore tests (partial); gap noted           |

## 3. Tool acceptance tests

| Test                                                  | Evidence status                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| MCP tool discovery and invocation                     | `packages/mcp/test/bridge.test.mjs` (existing)                            |
| WebMCP browser tool discovery and invocation          | `tests/webmcp-contract.test.mjs` (existing)                               |
| UTCP native endpoint discovery and invocation         | Proposed                                                                  |
| Three providers expose equivalent harmless operations | Proposed                                                                  |
| Duplicate names do not collide                        | Proposed                                                                  |
| Protocol-specific errors remain distinguishable       | Proposed                                                                  |
| Cancellation and timeouts work                        | WebMCP: existing; UTCP: wrapper required                                  |
| Expired authorization fails closed                    | `tests/tool-expiry.test.mjs` (WebMCP); cross-provider proposed            |
| Unauthorized cross-origin invocation denied           | Proposed                                                                  |
| Tools unavailable after provider disconnect           | `tests/agent-client-presence.test.mjs` (partial); cross-provider proposed |
| Dangerous descriptions cannot override instructions   | Proposed                                                                  |
| Calls preserve origin and source identity             | Proposed                                                                  |

## 4. Agent communication acceptance tests

| Test                                                     | Evidence status                                        |
| -------------------------------------------------------- | ------------------------------------------------------ |
| Two independent agents identify one another              | Existing signed room tests (partial)                   |
| A2A interop with an independent implementation           | Proposed, optional adapter                             |
| No confusion between tool invocation and task delegation | Proposed                                               |
| ACP compatibility where supported                        | Proposed, optional adapter                             |
| Existing WebRTC collaboration remains functional         | `tests/p2p-transport.test.mjs`, wheel tests (existing) |

## 5. Security acceptance tests

| Test                                                   | Evidence status                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Stolen bearer credential cannot bypass policy          | Proposed                                                                                 |
| Forged identity claims fail                            | Existing envelope tests (partial)                                                        |
| Replayed requests fail                                 | Proposed cross-provider                                                                  |
| Unsupported protocol versions fail safely              | Proposed                                                                                 |
| Missing authorization gives no implicit approval       | Existing WebMCP tests; cross-provider proposed                                           |
| Untrusted UTCP endpoint cannot reach private networks  | Proposed                                                                                 |
| Secrets absent from logs and room messages             | `tests/approval.test.mjs`, `tests/revocation.test.mjs` (partial); adapter tests proposed |
| Browser tools unavailable after page context destroyed | `tests/tool-expiry.test.mjs` (partial)                                                   |
| High-risk operations require explicit authorization    | `tests/webmcp-contract.test.mjs` (protected tools); cross-provider proposed              |

## 6. Commerce acceptance tests

| Test                                             | Evidence status               |
| ------------------------------------------------ | ----------------------------- |
| UCP workflows separate from general tools        | Proposed, optional layer      |
| AP2 mandates verified per specification          | Proposed, mocks only          |
| Payment bound to transaction and constraints     | Proposed                      |
| `tools.invoke` cannot permit spending            | Proposed                      |
| Financial operations use mocks or sandboxes only | Mandatory; no real operations |

## 7. Infrastructure acceptance tests

| Test                                          | Evidence status                                     |
| --------------------------------------------- | --------------------------------------------------- |
| No hosted AI Auth account service             | `docs/ARCHITECTURE.md`, CI guard (existing)         |
| Independent identity verification offline     | `tests/did.test.mjs` (partial)                      |
| Network failures visible and recoverable      | `docs/limits.md`, runtime tests (existing)          |
| No mandatory blockchain or registry           | Existing design                                     |
| Browser and headless runtime still functional | `npm run test:all`, E2E (existing)                  |
| No website-specific logic in core SDK         | `tests/generic-*` and integration review (existing) |

## 8. Repeatability

Every proposed test must run under `npm run test:all` or a dedicated `npm run test:*` script added in the same commit. Tests must not require real payment accounts, real purchases, public relay connectivity for unit suites, or credentials in source. CI runs the same commands as the release workflow.

## 9. Evidence rule

A security claim is "verified" only if a named test file exists and has passed in CI. Otherwise it is "unverified" and must be labelled as such. Screenshots are UI evidence, not proof of peer delivery by themselves (`docs/GENERIC_INTEGRATION_REVIEW.md`). Dated harness notes are observations, not guarantees (`docs/agents.md`).
