# Docs index

Start with the [quickstart](quickstart.md) or the [site integration guide](site-integration.md). The [root README](../README.md) is a short product page.

## Site builders

- [Connect a site and an agent](quickstart.md)
- [Site integration: connect, resume, presence, cursors, WebMCP tools](site-integration.md)

## Agent builders

- [Agents and MCP: Claude Code, Codex, OpenCode](agents.md)
- [Headless agent runtime notes](agents.md)
- [Agent package readme](../packages/agent/README.md) · [MCP command readme](../packages/mcp/README.md) · [Runtime package readme](../packages/runtime/README.md)

## Protocol and security

- [Architecture](ARCHITECTURE.md) · [Session lifecycle](lifecycle.md)
- [Wire protocol](protocol.md) · [Limits and not yet available](limits.md)
- [Security boundaries](SECURITY.md) · [Export and trust boundaries](BOUNDARIES.md)
- [Site discovery](DISCOVERY.md)
- [DID alias](DID.md) · [Identity standards RFC](IDENTITY_STANDARDS_RFC.md) · [Phase 0 review](IDENTITY_STANDARDS_REVIEW.md) · [DID verification evidence](evidence/did-key-verification.md)

## Proposed architecture

These documents record research and design decisions. Each file carries its own status banner. Rows marked "implemented and tested" in the standards matrix refer to shipped v0.12.0 subpaths; proposed adapters and protocol clients are not shipped. Implemented behavior for the core product remains in the sections above.

- [Council report](architecture/COUNCIL_REPORT.md) · [Reference architecture](architecture/REFERENCE_ARCHITECTURE.md) · [Standards matrix](architecture/STANDARDS_MATRIX.md)
- [Tool protocols](architecture/TOOL_PROTOCOLS.md) · [Agent interoperability](architecture/AGENT_INTEROPERABILITY.md) · [Commerce and payments](architecture/COMMERCE_PAYMENTS.md)
- [Threat model](architecture/THREAT_MODEL.md) · [Implementation plan](architecture/IMPLEMENTATION_PLAN.md) · [Conformance plan](architecture/CONFORMANCE_PLAN.md) · [Decisions](architecture/DECISIONS.md)
- [Interoperability and Code Mode RFC](INTEROPERABILITY_CODE_MODE_RFC.md) · [Cloudflare, Pi and AI Auth Code Mode comparison](CODE_MODE_COMPARISON.md)
- [Connect Agent end-to-end acceptance](CONNECT_AGENT_E2E_ACCEPTANCE.md) — user-first testing contract for the full journey.

The reusable worker-council prompt lives at `.agents/AI_AUTH_INTEROPERABILITY_COUNCIL.md` in the repository.

## Operations

- [Hosting policy](HOSTING.md) · [Wallet recovery](RECOVERY.md)
- [End-to-end tests](E2E.md) · [Generic integration review](GENERIC_INTEGRATION_REVIEW.md)
- [Traceability](TRACEABILITY.md) · [Verification evidence](evidence.md) · [Decentralization evidence plan](evidence/decentralized-plan.md)
- [Changelog](../CHANGELOG.md) · [Dated snapshots](https://github.com/EnzoVezzaro/ai-auth/tree/main/docs/archive)
