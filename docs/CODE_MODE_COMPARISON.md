# Code Mode options and security review — AI Auth

**Date:** 2026-11-19  
**Status:** Design/research only; **not a new executable backend**  
**Decision:** Preserve direct tool calls as the default. The existing --code-mode and ai_auth_code route remain optional. Evaluate safe extension to MCP / WebMCP / UTCP *after* provider authorization and sandbox gates.

## Three approaches are related but not equivalent

| Concern | Cloudflare (initial + later Code Mode) | Pi coding agent (0.99+ built-in Code Mode) | AI Auth current code |
| --- | --- | --- | --- |
| Role | Programmatically orchestrates MCP/API calls; can sit behind a Code Mode MCP server | Optional local codemode tool for calling registered tools through JavaScript | Optional ai_auth_code exposed by MCP server when --code-mode |
| Execution environment | Cloudflare Dynamic Workers / V8 isolate; no arbitrary internet or filesystem by default in described profile | QuickJS WASM sandbox inside a worker, per public release docs | Node worker_threads + node:vm with codeGeneration disabled |
| Discovery | Types and progressive search/describe in newer docs | tool_search plus tool namespaces and configured inline budget | aiAuth.listTools() shows joined room catalogs (WebMCP and participant tools) |
| Authorization | Host-side dispatch approvals remain mandatory | Tool invocations mediated by Pi harness | Code Mode calls the same AI Auth host bridge invoke path; site provider still approves |
| Existing APIs | MCP tools can be converted into typed SDK; Cloudflare later runs behind MCP | Any registered tool and optional MCP support | status, listTools, events, send, move, invoke only |
| Default behavior | Depends on app configuration | Explicitly selectable in tools/config | Off unless --code-mode and tools.invoke granted |
| Adversarial isolation | Isolated Worker model; still subject to workerd security vulnerabilities | QuickJS adds guest isolation; security must be verified for current release | vm is **NOT a hard security sandbox**; runs with host process privileges |
| Bounded operation | Per execution and sandbox budget according to platform | Tool/script limits and output controls via config | 8,000-character script, ~2s host timer, 50 logs, bounded exposed event list |
| Best reuse for AI Auth | API/progressive discovery concepts and per-call host checks | Opt-in UX, tool namespaces, result filtering, QuickJS comparison | Reuse current flag/tool/dispatch; no parallel second engine |

This matrix is based on public docs and inspected AI Auth code, **not a security audit or interoperability benchmark**.

## Code Mode is not authorization

Model-written code is untrusted, even in a local coding harness.

For every script-originated invocation, the trusted host must check:

1. which agent/key/session is invoking;
2. exact target provider, origin and resource;
3. token/issuer audience and native transport authorization;
4. owner-approved scope and per-tool site policy;
5. whether new consent is required for mutating/high-risk actions;
6. session/catalog freshness and revocation;
7. call budgets, deadlines and cancellation;
8. audit metadata and truthful side-effect status.

**A successful sandbox result does not imply the operation was authorized.** The host dispatcher is the policy enforcement point; the guest cannot be allowed to assert approval.

Do not grant a script ambient network/fetch, process, filesystem, arbitrary imports, API keys, OAuth tokens, payment credentials, or the ability to alter the tool registry.

## AI Auth implementation-specific observations

Inspected:
- packages/mcp/cli.js — --code-mode parsed.
- packages/mcp/bridge.js — buildAgentActions hides ai_auth_code unless codeMode true and relevant scope approved; runCode starts worker.
- packages/mcp/code-mode-worker.js — guest-realm wrappers and JSON bridge; node:vm codeGeneration disabled.
- packages/mcp/test/code-mode-timeout.test.mjs — verifies runaway async loop termination and cancellation signal for active tool invocation.
- docs/mcp.md — user-facing opt-in and limitations.

**Positive:**
- Non-replacing opt-in design already matches the user's requirement.
- Host's api.invoke goes through connection, catalog lookup and remote provider rules.
- Each code execution receives a new worker and host timeout, not just Promise.race.
- Existing direct MCP actions remain present.
- Guest doesn't get join, leave or act through the script API.

**Gaps / security questions (tests required, not reported vulnerabilities):**
- node:vm is not a high-assurance boundary for hostile generated code; evaluate QuickJS/subprocess/isolate options and published workerd sandbox security research.
- The global script timeout cannot reverse committed side effects (especially send and non-idempotent invoke). Ensure partial effects are reported, no blind retries, and no misleading "rolled back" semantics.
- Current async send is not passed the shared abort controller; evaluate termination semantics and auditability.
- No evidence yet of per-script **tool call count**, max outstanding calls, or nested fan-out budget; add explicit host accounting before broadening provider reach.
- No proof yet of safe UTCP URL restrictions or credential isolation because UTCP is not part of the existing joined-room tool path.
- Guest logs are count-bounded, but verify per-item log lengths and JSON crossing behavior against memory/output DoS.
- The synchronous shared buffer should reject oversized replies with an explicit error rather than truncated JSON.
- A runtime escape may threaten the host MCP process's credentials; never advertise hostile multi-tenant isolation under the current design.

Do not assume Cloudflare's or Pi's sandbox proves the safety of AI Auth's own implementation. Likewise, do not assume a cited vulnerability affects a patched runtime version without reproduction or advisory matching.

## Suggested decision

- **Keep**: --code-mode, ai_auth_code, direct tools, existing connection/permission checks.
- **Harden first**: sandbox assurance, resource bounds, per-call approval, cancellation/partial success, output limits and audit.
- **Additive second step**: provider-aware discovery/description of MCP, WebMCP, UTCP with exact native authorization.
- **Optional third step**: isolated QuickJS or process backend after benchmark. No Cloudflare-hosted mandatory service.
- **Not yet**: cross-provider write operations, payment mandates, credential issuance, arbitrary JavaScript networking, or automatic code-mode enablement for all agents.

The UX should permit (a) normal direct calls, (b) opt-in code orchestration for trusted read-only or low-risk tasks, (c) off again without losing functionality.

## Required comparisons and measurable tests

| Scenario | Direct | Optional Code Mode | Pass condition |
| --- | --- | --- | --- |
| List 50 harmless tools | Listing native descriptors | Progressive search/describe via guest | Same authorized visibility, less/equal irrelevant context if claimed |
| Read 5 independent mock sources | 5 explicit calls | Script batches calls with bounded concurrency | Same results and auth, truthful per-call status |
| Provider denies tool | Denied | Code program attempts same tool | Same denial, no bypass |
| Ambiguous tool name across providers | Explicit selection | Namespaced selection | No wrong-target execution |
| Wrong origin, stale catalog | Denied | Script tries stale capability | Denied |
| Cancels during slow call | In-flight abort | Worker timeout/abort | Abort if possible, side effects reported honestly |
| Script attempts process/env/fetch | N/A | Guest code attempts escape | No access; test under isolated risk model |
| Script triggers destructive tool | Explicit high-risk approval | Programmatic call | Denied by default; no automatic consent |
| UTCP endpoint points to localhost/private IP | Endpoint validation | Script attempts direct call | Both blocked unless explicit policy |
| Expired payment mandate | No payment permission | Program attempts purchase | Never reaches payment execution |
| Large payload/log or infinite async loop | Bounded input | Host-enforced limits | No crash, no secret disclosure, clear outcome |

Record measurements for token input, tool schemas injected, runtime latency, startup, memory, total tool calls, and errors. Cloudflare's reported savings are **not** AI Auth measurements.

## Source links

- Cloudflare original: https://blog.cloudflare.com/code-mode
- Cloudflare code-mode MCP server: https://blog.cloudflare.com/code-mode-mcp/
- Cloudflare current agent docs: https://developers.cloudflare.com/agents/tools/codemode/mcp/
- Cloudflare isolation docs: https://developers.cloudflare.com/dynamic-workers/examples/codemode/
- Pi release notes: https://pi.dev/changelog/releases/0.99.0
- Pi CLI: https://docs.pi.dev/latest/cli
- MCP programmatic tool calling guidance: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/develop/clients/client-best-practices.mdx
- Check Point workerd sandbox research: https://research.checkpoint.com/2026/when-agentic-glue-melts/

## Independent reviewer assignment

1. Confirm exact package and runtime versions, then examine vm/Worker escape surface and outstanding execution accounting.
2. Produce tests for the noted limits and allowlist requirements.
3. Compare QuickJS/isolate/subprocess backend costs in Node and browser environments, considering no mandatory external service.
4. Determine whether the existing trusted MCP host dispatch can safely route separate WebMCP and UTCP adapters while preserving native auth.
5. Do not ship increased tool reach or a new sandbox backend until the review gate and tests pass.

The safe design is **one explicit execution-mode choice** above provider-specific tools, not an AI Auth-owned replacement for the tools themselves.
