# AI Auth implementation plan

## Product boundary

Build an independently runnable local MVP in vertical slices. The local path must not require paid provider credentials. Provider integrations remain optional adapters and are added only when they enable a validated user flow.

## First slice: local agent collaboration

1. Establish a TypeScript Node service and local persistence.
2. Register agents and issue opaque bearer credentials; store only credential hashes.
3. Authenticate subsequent actions and enforce per-agent identity.
4. Persist agent presence, room messages, and audit events.
5. Expose an event stream so a second client can observe changes.
6. Add an HTTP client/SDK entry point and dashboard after the service contracts are stable.
7. Verify two independent clients can register, communicate, and see durable audit data after restart.

## Build order

- A. Research standards and provider boundaries.
- B. Define API/event contracts, persistence, and threat model.
- C. Implement local registration, sessions, and permissions.
- D. Add presence and event delivery.
- E. Add messaging, handoffs, and locks.
- F. Add website SDK and MCP/WebMCP integration.
- G. Add dashboard, analytics, and observability.
- H. Add browser-agent workflows and security/load coverage.
- I. Complete docs and report only evidenced outcomes.

## Initial architecture choice

Start with one TypeScript service and a local SQLite database. This keeps setup free and removes an external database requirement while making audit history durable. Keep protocol types independent of storage and provider adapters. PostgreSQL, Redis, and hosted identity are later deployment options, not local prerequisites.

## Acceptance gates

Each slice must have a runnable local workflow and behavioral coverage before expanding. The first end-to-end gate is: two authenticated clients connect; one writes a message; the other receives it; the action appears in persistent audit history and remains after service restart. Mocked adapters do not count as external integration evidence.

## Research notes

Superpowers is a skills-based software development methodology. Its documented workflow uses design approval, an implementation plan, and small test-first tasks. This plan applies the small-slice and evidence gates; the master prompt already supplies the product direction and authorization to start.
