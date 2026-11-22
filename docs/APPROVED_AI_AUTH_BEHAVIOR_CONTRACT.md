# AI Auth — approved product behavior contract

Status: **approved requirements / implementation handoff** (2026-11-21). This PR records the seven requirements reviewed one by one with the product owner. It does **not** assert that all are implemented or tested.

## Product boundary

AI Auth is the generic **agent identity, connection and authorization layer** for websites and agent runtimes. A website exposes its own capabilities via WebMCP and other explicitly registered surfaces. AI Auth verifies identity, scoped permission and authenticated transport. Agent-provided tools and human/agent collaboration are additional supported capabilities, not prerequisites for website connection. Formal A2A is **not a required dependency**.

## Seven approved behaviors

1. **Identity per agent session.** Each distinct agent chat/session receives its own cryptographic wallet identity. Subagents receive separate identities and explicitly bounded delegation where applicable. Do not silently reuse one installation-wide identity across unrelated chats.
2. **Simple website connection.** A site integrates the SDK and offers **Connect agent**. The owner passes the connection instruction to an agent; the wallet presents exact origin, room, capabilities and duration; the owner approves or denies. A URL by itself never grants access.
3. **Website capabilities via WebMCP.** An authenticated agent discovers and invokes only the site's exposed, authorized tools. The site retains control over its own data, actions and authorization policy.
4. **Autonomy and secure persistence.** Within an unexpired, unrevoked grant and available action host, the agent can work without continuous owner interaction. Recover transport safely after transient loss and restore approved sessions after reload as product policy permits, without conflating stored consent and a live authenticated channel. Closing a browser page must not be represented as leaving page-hosted tools available; unattended operations require an independently reachable host or running browser context. No silent privilege escalation. Normal authorized actions should not require repeated owner approval unless the site's sensitive-action policy explicitly requires it.
5. **Agent-published tools with explicit owner approval (not merely 'optional').** AI Auth supports agents advertising their own bounded tool catalogs to other agents. **Before enabling another agent to access these tools or establishing that authorized connection, explicitly ask the tool-owning user to approve the connection and exact scopes.** Denial blocks access; approval enables only those scopes. Subsequent ordinary actions within that grant should not repeatedly ask the owner, except where additional site/provider security policy requires it. Do not expose all agent tools or confuse this with the website's WebMCP surface.
6. **Human–agent collaboration via the Interaction Wheel (explore improvements).** In the authorized website room, humans and agents can view policy-permitted presence, exchange targeted messages and interact through a concrete action panel / Interaction Wheel. Candidate actions include chat, file sharing, screen sharing, and presence, with appropriate per-action permissions, explicit screen-share consent, and an immediate stop control. **(Explore improvements.)** Do not present unimplemented actions as functional; show availability and permission state.
7. **Identity and authorization security.** Validate cryptographic identity, valid grant, origin, room, scope and policy for each operation. Revocation blocks new operations immediately, but does not erase the agent's cryptographic identity. Distinguish offline, expired, revoked, unauthorized and connected.

## Existing implementation to preserve

- `packages/p2p/webmcp.js`: website WebMCP discovery, signed catalog and tool request/response.
- `packages/agent/tool-provider.js`: agent-provided tool catalogs and invocation; preserve this functionality and audit the owner approval flow against requirement 5.
- `packages/mcp/` and `docs/agents.md`: host-local MCP integration for coding agents.
- `docs/protocol.md`: signed room events and capability checks.
- `docs/ARCHITECTURE.md`: wallet/site SDK/runtime boundaries.
- `docs/INTERACTION_WHEEL_REVIEW.md` (PR #19): interaction UI review.

## Known mismatches / verification priorities

| Requirement                      | Current documented behavior / gap to verify                                                                                                                                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-session identity             | Architecture currently describes one agent signing identity per process; verify chat/subagent identity and delegation before claiming support. See PR #17.                                                                                                                                                      |
| Connection persistence           | Page reload requires explicit Resume; page-hosted tools stop when page closes; no TURN fallback. Verify the secure automatic recovery and unattended action-host requirements. See PR #18.                                                                                                                      |
| Autonomous authorized tool calls | Existing site page actions require site-side approval per call. Review how to honor an approved scope for ordinary actions without bypassing sensitive site policy.                                                                                                                                             |
| Agent tool owner approval        | `tool-provider.js` supports peer tool calls and an authorization callback. Verify that a real owner-facing connection approval occurs **before** exposing/invoking tools, that denied requests fail closed, and that approvals are scoped and revocable. Do not assume callback existence proves UX compliance. |
| Interaction Wheel                | Audit visible actions, permission state, presence privacy, targeted sharing and screen-share stop behavior; see PR #19.                                                                                                                                                                                         |
| A2A                              | Do not introduce A2A as a mandatory transport or dependency; document optional future interoperability separately if needed.                                                                                                                                                                                    |

## Implementation and acceptance

1. Trace each requirement to concrete source files and existing tests. Record pass/fail/blocked and reproducible evidence.
2. Preserve existing WebMCP and agent-tool transport. Implement only confirmed gaps in separate, reviewable commits/PRs, with security review for owner approval and autonomy.
3. Add positive and negative tests for per-session identities, consent denial/approval, agent-to-agent tool access, scope narrowing, revocation, reload/reconnect, closed-browser autonomy and UI visibility.
4. Do not merge as an implementation-complete change until relevant behavior is demonstrated by tests. This documentation PR is the approved product contract and handoff, **not an implementation claim**.
