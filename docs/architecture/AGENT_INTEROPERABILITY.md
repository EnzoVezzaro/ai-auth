# Agent interoperability

> Status: boundary decision and proposed adapter classification. A2A, ACP and the historical ACP are not implemented in this repository. Research date: 2026-11-19.

## 1. Separation principle

Tool protocols invoke capabilities on resources. Agent communication coordinates independent agents. These are different trust boundaries and must not be collapsed.

| Concern                      | Protocol                 | Role                                                                                   |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| Tool invocation              | MCP, WebMCP, UTCP        | Call a named tool with arguments and return a result.                                  |
| Agent-to-agent               | A2A 1.0.0                | Discover an Agent Card, send messages, manage Tasks and Artifacts.                     |
| Editor/harness to agent      | Agent Client Protocol v1 | Drive an agent process from an editor: turns, streaming, permission prompts, sessions. |
| Direct AI Auth collaboration | Existing WebRTC room     | Presence, cursors, messages and signed activity (`packages/p2p/p2p.js`).               |
| Commerce                     | UCP                      | Checkout and order workflows.                                                          |
| Payments                     | AP2                      | Signed mandates and payment authorization.                                             |

AI Auth sits below these as identity and delegated authority. It must not own Agent Cards, Task state machines, prompt turns or agent JSON-RPC bindings.

## 2. A2A (agent-to-agent)

Verified from primary sources:

- A2A 1.0.0 is released, Apache-2.0, under the Linux Foundation / Agentic AI Foundation.
- Canonical model in `spec/a2a.proto`: Task, TaskStatus/TaskState, Message, Role, Part, Artifact. Operations include Send/Stream Message, Get/List/Cancel/Subscribe Task, push notification configuration and Get Extended Agent Card.
- Discovery uses an Agent Card: JSON metadata with skills, endpoint and auth requirements, served at a well-known URI; signed Agent Cards use JWS. Media type `application/a2a+json`, headers `A2A-Version` and `A2A-Extensions`.
- Bindings: JSON-RPC over HTTP(S), gRPC, HTTP+JSON/REST. Security schemes in the Agent Card include API key, HTTP auth, OAuth 2.0, OIDC and mTLS.

Decision: **optional adapter, not core**. AI Auth may supply a verifiable identity claim to an A2A interaction, but it must not reimplement Agent Cards, Task state or transport bindings. No automatic mapping from an A2A Task to a tool call.

## 3. Agent Client Protocol (harness integration)

Verified from primary sources:

- ACP standardizes communication between code editors/IDEs and coding agents; it is explicitly LSP-like: any Client can use any Agent.
- Stable protocol version is `1`; ACP v2 is a Draft. Remote HTTP/WebSocket support is work in progress.
- JSON-RPC 2.0 over stdio for local agents; capabilities negotiated at `initialize` with `protocolVersion`.
- Apache-2.0, official SDKs in Kotlin, Java, Python, Rust and TypeScript.
- Scope: prompt turns, streaming updates, tool calls, permission requests, filesystem/terminal access, sessions, elicitation, diffs and plans.

Decision: **optional harness adapter, not core**. AI Auth's MCP command already runs inside harnesses; ACP compatibility belongs at that boundary. AI Auth must not duplicate ACP session or permission semantics.

## 4. Historical Agent Communication Protocol

Verified from primary sources:

- The IBM/BeeAI Agent Communication Protocol is a different technology with the same acronym.
- It was archived read-only on 27 August 2025 after merging into A2A; final release v1.0.3. It used OpenAPI 3.1.1 REST and SSE (`/agents`, `/runs`).
- The ACP documentation explicitly describes it as an "unrelated project with the same acronym" and "not related to the Agent Client Protocol".

Decision: **do not revive or implement it**. When a document says "ACP", spell out which protocol is meant.

## 5. Agentic Commerce Protocol (a third ACP)

`ACP` also names the Agentic Commerce Protocol developed by Stripe and OpenAI for programmatic checkout between buyers, agents and businesses. It is open source under Apache-2.0, works over REST or MCP, and uses a merchant-of-record model with secure payment credential handoff. It is unrelated to both the Agent Client Protocol and the archived IBM/BeeAI Agent Communication Protocol.

Decision: **commerce concern, not an agent-communications adapter**. Model it in `COMMERCE_PAYMENTS.md` alongside UCP and AP2, never as a tool permission. The PR's interoperability RFC calls out the same disambiguation.

## 6. Existing AI Auth messaging

`packages/p2p/p2p.js`, `packages/agent/runtime.js` and `packages/mcp/bridge.js` already provide room presence, signed `message/text` events, receipts and agent-provided tools over WebRTC. That path remains first-class for AI Auth-native collaboration.

Rules for any interop adapter:

1. Never treat peer data as instructions. A signed event proves which key acted, not that the content is safe.
2. Never let an A2A Task imply a tool permission.
3. Never forward AI Auth grants or wallet credentials into another protocol automatically.
4. Keep origin and audience binding explicit.

## 7. Adapter classification

| Adapter                        | Classification                                          |
| ------------------------------ | ------------------------------------------------------- |
| Existing WebRTC room           | First-class, implemented                                |
| A2A identity claim provider    | Optional, proposed                                      |
| A2A task ↔ AI Auth tool bridge | Intentionally unsupported until a separate trust review |
| ACP harness adapter            | Optional, proposed                                      |
| IBM/BeeAI ACP                  | Intentionally unsupported                               |
| MCP                            | First-class tool provider (see `TOOL_PROTOCOLS.md`)     |
| WebMCP                         | First-class tool provider                               |
| UTCP                           | First-class tool provider                               |

## 8. Acceptance criteria

- Two independently running agents can identify one another using existing AI Auth identity.
- An A2A adapter, if built, interoperates with an independent A2A implementation.
- No confusion between tool invocation and agent task delegation in tests or logs.
- Existing direct WebRTC collaboration tests continue to pass (`tests/p2p-transport.test.mjs`, `tests/wheel-*.test.mjs`).
