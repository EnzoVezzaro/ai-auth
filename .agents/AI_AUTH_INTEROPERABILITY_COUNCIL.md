# AI Auth Architecture Council — Worker Execution Prompt

> Copy this entire prompt into Codex, OpenCode, Pi, Claude Code, or a compatible multi-agent harness. If the harness cannot spawn independent agents, declare that limitation and run isolated sequential reviews with separate reports; never manufacture independent votes.
>
> Mission repo: https://github.com/EnzoVezzaro/ai-auth  
> Governing technical brief: docs/INTEROPERABILITY_CODE_MODE_RFC.md  
> Work product: evidence-based architecture decision + small gated implementation plan.

## Goal

Convene an adversarial expert council to decide a future-proof, standards-aligned, secure and self-custodied AI agent identity/authorization architecture. Build on existing code and standards without duplicating solved problems.

The required **tools layer is MCP / WebMCP / UTCP**. Code Mode is an **OPTIONAL programmatic orchestration mode** over approved tools, not a replacement for direct tool calls or the three tool standards. A2A and the different ACP protocols are external agent/harness interfaces. UCP commerce and AP2 payment mandates are separately governed interfaces, never ordinary tool authority.

The council must research Cloudflare Code Mode, the latest Cloudflare programmatic MCP interfaces, Pi's QuickJS-based opt-in Code Mode and dynamic tool search, and any documented sandbox vulnerabilities. Evaluate what is reusable, but do not assume AI Auth should adopt Cloudflare's infrastructure.

**Repository discovery matters:** Main already contains docs/DID.md and packages/p2p/did.js plus Code Mode in packages/mcp/bridge.js, code-mode-worker.js and --code-mode CLI. Investigate what is already built and tested before proposing new work. Do not replace these implementations merely for novelty.

## Operating rules

- Governor + Architecture Supervisor + Engineering Supervisor + Security Supervisor.
- Up to FOUR concurrent specialist workers at a time, or fewer if harness limits demand it.
- Specialist assignments can run in waves: research first, design second, independent red team third, implementation only after approval gates.
- Workers cannot concurrently edit the same files; research agents should use read-only access.
- Every claim must cite source file/line or normative standard/version; separate observed, tested, inferred, and unknown.
- No code, live payment, secret changes, authorization policy changes or irreversible operations during council deliberation.
- Do not weaken site consent, MCP OAuth, WebMCP origin enforcement or UTCP native endpoint authentication.
- Prefer reusable OSS libraries to new parsers and signing algorithms, subject to verified licensing and compatibility.
- Do not add a mandatory hosted identity, OAuth, TURN, Cloudflare, credential registry or blockchain service to self-custody.
- Permission to use a tool does not grant permission to call payment APIs or issue an AP2 mandate.

## Specialist workers

### W1 — Identity and cryptography
Inspect existing P-256 keys, agent: IDs, DID aliases, sign/verify, canonicalization, keystore and recovery. Compare W3C DID Core, did:key, did:jwk, JOSE/JWS, VC 2.0, WebAuthn, hardware custody and algorithm agility. Evaluate key rotation, stable principal vs running instance, privacy/pairwise IDs and offline independent verification.

Output: identity trust diagram, interoperability vector list, migration risks, recommended minimum identity kernel.

### W2 — Authorization and policy
Audit signed capabilities, membership grants, execution grants, revocation gossip and per-call approval. Compare UCAN, Biscuit, OAuth token exchange, DPoP, SPIFFE for workloads. Specify recipient binding, exact origin/audience, resource scopes, expiry, revocation freshness, delegation attenuation and no privilege escalation.

Output: capability model, negative tests, proof chain designs, decision gates (UCAN vs Biscuit vs retain existing).

### W3 — MCP protocol
Review latest MCP normative rules, Node SDKs, stdio/Streamable HTTP, discovery, registration, native OAuth/protected resource semantics and per-server trust. Audit packages/mcp against current SDK/version. Do not assume an AI Auth key replaces OAuth.

Output: MCP adapter spec, native authorization mapping, compatibility matrix and tests.

### W4 — WebMCP/browser security
Review the latest W3C Community Group WebMCP API and existing packages/p2p/webmcp.js. Test current document.modelContext semantics as applicable, feature detection, browser origin, page lifecycle, catalog trust and per-invocation approval. Prevent cross-site credential or private-page leaks.

Output: browser tool adapter spec and origin/lifecycle threat matrix.

### W5 — UTCP/native APIs
Evaluate official TypeScript UTCP client, UTCP discovery/manuals and bridges. Propose direct native API invocation without proxying everything through MCP. Evaluate authentication separation, target validation, SSRF/DNS rebinding, endpoint restrictions, TLS, schema trust, cancellations, deadlines and output sanitization.

Output: UTCP proof-of-concept design, endpoint-security tests, dependency/license analysis.

### W6 — Code Mode and sandboxing
Conduct deep research on Cloudflare:
- https://blog.cloudflare.com/code-mode
- https://blog.cloudflare.com/code-mode-mcp/
- https://developers.cloudflare.com/agents/tools/codemode/mcp/

And Pi:
- https://docs.pi.dev/latest/cli
- https://pi.dev/changelog/releases/0.99.0

And security research:
- https://research.checkpoint.com/2026/when-agentic-glue-melts/

Inspect existing packages/mcp/bridge.js, code-mode-worker.js, test/code-mode-timeout.test.mjs, docs/mcp.md. Evaluate use of Node vm/worker_threads, QuickJS, isolated subprocesses or Cloudflare Dynamic Workers; never claim vm is a security boundary. Compare code compilation, typed discover/describe/search, ephemeral scripts, output limits, tool-call budgets, concurrent calls, cancellation, deterministic approval, partial side effects, and clean opt-out.

Output: Code Mode options matrix, threat model, safe opt-in proposal, exact tests and benchmark plan. Prefer existing implementation hardening to a second engine.

### W7 — Agent protocols and harnesses
Investigate current A2A specification, signed Agent Cards, independent task auth, identity mapping, editor-side Agent Client Protocol and historical IBM/BeeAI Agent Communication Protocol. Explicitly distinguish Agentic Commerce Protocol (also abbreviated ACP).

Output: integration boundaries, minimum native adapter requirements, no-authority-leak test cases.

### W8 — Commerce/payment isolation
Compare UCP and AP2 in terms of product/checkout/order state versus payment mandates, authorization and issuer trust. Review any UCP AP2 extension; distinguish commerce-ACP. Require amount/currency/merchant/item/expiry and independent approval. No actual purchases, no real cards, no mandate signing with live credentials.

Output: comparison, sandbox-only integration profile, fraud/replay/wrong-audience tests, out-of-scope list.

### W9 — Networking and reliability
Review existing Nostr signaling/WebRTC room model, libp2p, QUIC, WebTransport, optional TURN, connection authorization, discovery trust, group privacy/MLS, dropouts, partitions, rate limits, instrumentation and reconnect. Identity should stay independent of transport.

Output: topology alternatives, reliability tradeoffs, cost/dependency matrix and failure modes.

### W10 — Independent security and standards verifier
Adversarially challenge W1–W9. Enumerate threats including VM escape, malicious tool catalogs, prompt injection, inconsistent scope checks, stolen proof, token forwarding, SSRF, redirected UTCP endpoints, cross-origin tool calls, stale sessions and partial side effects. Verify standards statuses: IETF RFC vs W3C Recommendation vs draft/community spec vs SDK behavior.

Output: red-team critique, standards conformance matrix with MUST/SHOULD/MAY, unresolved risks, evidence quality grades.

## Council rounds — MUST execute sequentially

### Round 1 — Baseline
Inspect main source, package versions, test suites, current DID and Code Mode. Run baseline tests if execution environment allows; otherwise explicitly state they were not executed. Identify code already solved in OSS. Produce one report per specialist, never premature convergence.

### Round 2 — Competing architectures
Propose at least four:
A. minimal compatibility/adapters;
B. DID-native/VC-oriented;
C. capability-native/P2P;
D. hybrid portable identity plus optional OAuth/SPIFFE;
E. optional alternative if research finds a clearly superior approach.

Every option must show three first-class tool providers (MCP/WebMCP/UTCP), direct and Code Mode invocation, A2A/ACP interface, UCP/AP2 segregation, trust roots, key lifecycle, authorization, network dependencies and cost.

### Round 3 — Cross-examination
Each design receives three concrete objections from other specialties. Red team must attack each. Require authors to produce a testable response, concede the weakness, or revise the proposal. Preserve minority opinions and unresolved issues.

### Round 4 — Scoring
Independently score 0–5; apply weights:
- 25% security and correctness;
- 25% standards and interoperability;
- 15% self-custody/portability/offline;
- 10% reliability;
- 10% developer experience;
- 10% maintainability;
- 5% performance.

Fail immediately for critical invariant violation regardless of weighted score. Governor publishes final ADR with evidence and dissent.

### Round 5 — Proofs
Before implementation recommendations are marked ready, define runnable independent tests:
- existing P-256 key ↔ DID aliases ↔ separate verifier;
- origin-bound, nonce-bound signature and recipient proof;
- local MCP stdio plus OAuth-protected remote MCP;
- browser WebMCP origin and navigation lifecycle;
- UTCP native API + SSRF/credential isolation;
- identity- and policy-constrained tool registry with colliding names;
- direct versus code-mode same allowed/denied outcomes;
- Code Mode runaway code, guest escape attempts, oversized logs and unawaited calls;
- per-call approval for all scripted operations, including parallel invocations;
- script timeout after already-committed side effect; truthful partial status;
- A2A independent implementation;
- rejected use of general tool grant for commerce/AP2 payment;
- offline revocation limits;
- backwards compatibility to existing signed events and CLI without --code-mode.

### Round 6 — ADR and phased implementation plan
Deliver a concise approved architecture, a file-level plan broken into independent, small PRs, failure/rollback plan and a typed protocol adapter proposal. Do not implement until council gate is accepted. Any follow-on write must be isolated to its own scoped change, with tests and reviewer.

## Required output documents

Write to docs/architecture/ or report paths suitable for the existing repo:

1. COUNCIL_REPORT.md — each worker's independent report, dissent and final verdict.
2. STANDARDS_MATRIX.md — real versions/statuses, source links and applicable normative requirements.
3. TRUST_AND_THREAT_MODEL.md — assets, threat actors, origins, scopes, sandbox, key lifecycle and residual risks.
4. TOOL_REGISTRY_CONTRACT.md — MCP/WebMCP/UTCP descriptor/dispatcher design, native auth and lifecycle.
5. CODE_MODE_DECISION.md — existing implementation audit, optional mode, sandbox options, metrics and gating tests.
6. AGENT_AND_COMMERCE.md — A2A/three ACP meanings/UCP versus AP2, hard separation of authority.
7. ROADMAP.md — implementation order, dependencies, acceptance criteria, backward compatibility and rollback.
8. CONFORMANCE_PLAN.md — independent cross-implementation and adversarial testing.

Mark every unexecuted test or unverified dependency compatibility claim as **UNVERIFIED**.

## Exit conditions

A successful council makes evidence-backed recommendations without treating Code Mode as a protocol or MCP/WebMCP/UTCP as equivalent authorization systems.

**Do not propose removal or replacement of Code Mode, MCP, WebMCP, P2P, DID aliases or existing direct tools just to simplify the architecture.** Propose additive, opt-in changes, with stronger isolation and security guarantees before expansion.

No real spending authority. No global automatic approvals. No silent scope widening. No fake consensus or test results.

**Start now: enumerate current code, delegate the first four independent research assignments, and bring the full council back for design debate before any implementation.**
