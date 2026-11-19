# Implementation plan

> Status: proposed plan. No implementation work is authorized by this document. Each task is small, independently testable and subject to independent review before merge. The first breaking change is explicitly out of scope.

## 0. Gates

Before any task starts:

1. Council decision accepted (`COUNCIL_REPORT.md`).
2. Threat model reviewed by the Security Supervisor (`THREAT_MODEL.md`).
3. Conformance fixtures defined (`CONFORMANCE_PLAN.md`).
4. No task may change the identity format, consent version or wire protocol.

## 1. Task sequence

| #   | Task                            | Owner                     | Depends on | Deliverable                                         | Acceptance test                                                             |
| --- | ------------------------------- | ------------------------- | ---------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| T0  | Baseline and code inventory     | Worker (reviewer)         | —          | Test baseline report; flaky tests identified        | `npm run test:all` baseline recorded; no new test skipped                   |
| T1  | Unified tool descriptor         | Worker (engineering)      | T0         | `packages/p2p/tool-descriptor.js` + types           | Descriptor validation tests; no native field silently weakened              |
| T2  | Source-aware registry           | Worker (engineering)      | T1         | `packages/p2p/tool-registry.js`, `tool-audit.js`    | Namespaced IDs, duplicate isolation, bounded audit, no payloads             |
| T3  | WebMCP catalog through registry | Worker (engineering)      | T2         | Refactor of `packages/p2p/webmcp.js`                | Existing `tests/webmcp-contract.test.mjs` unchanged and passing             |
| T4  | MCP adapter                     | Worker (engineering)      | T2         | `packages/mcp/adapter.js`                           | Native errors preserved; no OAuth substitution; existing MCP tests pass     |
| T5  | UTCP adapter behind flag        | Worker (engineering)      | T2         | `packages/p2p/utcp-adapter.js`, optional dependency | Discovery and direct invocation with official SDK; destination policy tests |
| T6  | Cross-provider policy           | Worker (security)         | T3,T4,T5   | Policy module and deny-by-default rules             | Cross-origin, expiry, disconnect and high-risk tests                        |
| T7  | Additive identity adapters      | Worker (identity)         | T6         | Verifier for standardized proofs, additive only     | Offline verification; no change to `agent:` identity                        |
| T8  | Delegation experiments          | Worker (identity)         | T7         | Separate experimental package                       | Documented limitations; no core dependency                                  |
| T9  | A2A / ACP adapters              | Worker (interop)          | T6         | Optional adapters                                   | Independent implementation interop; task ≠ tool test                        |
| T10 | UCP / AP2 layer                 | Worker (commerce)         | T6         | Separate optional package, mocks only               | No `tools.invoke` path to spending; no real financial operations            |
| T11 | MCP revision migration          | Council decision required | T4         | New adapter revision                                | Separate compatibility plan; breaking change, not in this milestone         |

## 2. Ownership rules

- Workers must not edit overlapping files concurrently.
- Each task has one author and one independent reviewer.
- Security-sensitive tasks (T5, T6, T7, T10, T11) require Security Supervisor sign-off.
- The Engineering Supervisor resolves integration ordering, not design disputes.
- The Governor resolves disagreements after independent arguments are recorded.

## 3. Compatibility policy

| Change class                                 | Allowed now?                                    |
| -------------------------------------------- | ----------------------------------------------- |
| Additive exports behind new subpaths         | Yes, with `docs/BOUNDARIES.md` updated (DTC-06) |
| New optional dependency behind a flag        | Yes                                             |
| Refactor with identical wire behavior        | Yes                                             |
| Change to `agent:` identity derivation       | No                                              |
| Change to consent version or signed envelope | No                                              |
| Change to WebRTC wire events                 | No                                              |
| Removal of existing CTA or package export    | No                                              |
| MCP 2026-07-28 revision migration            | No, separate approval                           |
| Real payment or purchase operation           | No                                              |

## 4. Rollback

Each task is one focused commit. Rollback is `git revert` of that commit plus removal of any generated docs entries. Feature flags default off for new providers. The previous catalog path stays live until conformance passes.

## 5. Documentation updates required by implementation

- `docs/BOUNDARIES.md` export list must match live root exports exactly (DTC-06).
- `docs/TRACEABILITY.md` needs feature → code → test rows for each new provider.
- `STANDARDS_MATRIX.md` conformance rows move from "not implemented" to "implemented and tested" only after tests pass.
- `docs/README.md` may link to `architecture/*.md` only after those pages are added to the renderer's doc list and `verify:docs` passes.
- `CHANGELOG.md` records each shipped milestone with the actual test results.

## 6. Definition of done for the first milestone

The first milestone is T1–T6: a single API for listing and invoking tools from MCP, WebMCP and UTCP, preserving native auth and authorization. It is done when:

1. All three providers expose the same harmless test operation through the registry.
2. Duplicate names do not collide and protocol-specific errors remain distinguishable.
3. Cancellation, timeout, expiry and disconnect fail closed.
4. Unauthorized cross-origin invocation is denied.
5. Native MCP OAuth is not substituted or proxied.
6. UTCP calls respect the destination policy and credential isolation.
7. Independent review and Security Supervisor sign-off are recorded.
8. `npm run test:all`, `npm run build`, `npm run verify:docs`, `npm run format:check` and package verification pass.
