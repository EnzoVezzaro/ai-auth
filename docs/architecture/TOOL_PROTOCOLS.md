# Tool protocols

> Status: proposed adapter contracts plus verified as-is behavior. Nothing in the adapter design is implemented by this document. Source files cited here exist at `v0.11.1`.

## 1. Shared model

The registry holds a protocol-neutral descriptor (see `REFERENCE_ARCHITECTURE.md` §6). Each descriptor keeps the original native definition in `native`. Translation is additive: a missing native field stays missing rather than being filled with a weaker default.

Tool IDs are namespaced: `mcp:<server>:<tool>`, `webmcp:<origin>:<tool>`, `utcp:<manual>:<tool>`. Flat names remain valid inside a provider but are never unique across providers.

## 2. MCP adapter

### As-is

- Server factory `createAIAuthMcpServer` in `packages/mcp/index.js` registers only actions covered by both the site request and owner approval. Names match `/^[a-z][a-z0-9._-]{0,63}$/`.
- `packages/mcp/bridge.js` exposes `ai_auth_status`, `ai_auth_join`, `ai_auth_leave`, `ai_auth_move`, `ai_auth_events`, `ai_auth_send`, `ai_auth_act`, `ai_auth_list_tools`, `ai_auth_invoke`, `ai_auth_code`; each maps to `presence.read`, `messages.send` or `tools.invoke`.
- Transports: stdio (`StdioServerTransport`) and Streamable HTTP bound to `127.0.0.1` at `/mcp/<secret>` (`packages/mcp/http.js`). The URL is the credential, stored mode `0600` and reused across restarts.
- There is no OAuth flow, no bearer token, no PKCE and no server capability negotiation beyond local scope strings.
- `packages/mcp/package.json` depends on `@modelcontextprotocol/sdk ^1.32.2`, which targets an MCP revision before 2026-07-28.

### Native behavior to preserve

- stdio: newline-delimited JSON-RPC; stderr for logs; cancellation via `notifications/cancelled`; shutdown by closing stdin.
- Streamable HTTP: one endpoint, POST per message, request-scoped SSE responses, `subscriptions/listen` for notifications in the 2026-07-28 revision; server MUST validate `Origin` to prevent DNS rebinding.
- Tools: `tools/list` with pagination and `ttlMs` caching; `tools/call` with `name` and `arguments`; `annotations` are hints only and MUST be treated as untrusted from untrusted servers.
- Errors: protocol errors as JSON-RPC errors; tool failures as `isError: true` in the result. Both must remain distinguishable in the normalized result.
- Authorization: when the official HTTP framework applies, OAuth 2.1 bearer tokens are normative. AI Auth signatures must not be sent in place of them. Custom bilateral auth is allowed by the base spec but will not interoperate with standard clients.

### Proposed adapter rules

1. Wrap the official SDK. Do not implement JSON-RPC framing manually.
2. Pass native auth material through untouched. AI Auth scopes decide which local actions are registered, not what credential the MCP server accepts.
3. Keep native tool names and schemas verbatim in `native`.
4. Map `isError`, JSON-RPC codes and cancellation to normalized fields with `nativeCode` preserved.
5. Do not advertise `subscribe` or `cancel` unless the transport actually supports them.
6. Treat MCP 2026-07-28 migration as a separate compatibility decision; it removes sessions and changes discovery, so it is not a drop-in upgrade.

## 3. WebMCP adapter

### As-is

`packages/p2p/webmcp.js` already implements the current draft shape:

- `modelContext = globalThis.document?.modelContext`; `registerTool`, `getTools`, `executeTool`, `toolchange`.
- `registerAIAuthPageActions({ actions, connection, modelContext, signal, authorize, publishAction, policy, onToolsChange })` requires a human `authorize` function and a verified active connection.
- Discovery caps at 32 tools and re-discovers on `toolchange`.
- Bounded descriptors: 8 KB results, 4 KB schemas, 240-char descriptions, 120-char titles.
- Signed catalog published over the room, refreshed every 45 s and expired after 120 s.
- `protectedGate()` requires membership plus a short execution grant for remote callers; annotations `consequentialHint` and `untrustedContentHint` are advisory.
- `close()` and bridge `shutdown()` withdraw the catalog.

### Draft semantics that constrain the adapter

- Status: W3C Community Group draft, 13 November 2026, not a W3C standard.
- API: `document.modelContext` with `registerTool`, `getTools`, `executeTool`, `toolchange`, `toolactivated`, `toolcancel`. No `provideTools`, `unregisterTool` or `provideContext` in the current draft.
- Unregistration is by aborting the `AbortSignal` passed to `registerTool`.
- Schemas are JSON Schema (draft 2020-12), not Zod.
- Three independent cross-origin gates: embedder delegation (`allow="tools"`), provider `exposedTo`, consumer `fromOrigins`. Same-origin is always allowed.
- Browser lifecycle: navigation and unload abort executions; a destroyed page context must not leave tools invokable.
- Annotation set differs from MCP: `readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging`.

### Proposed adapter rules

1. Keep native `document.modelContext`. A compatibility adapter may translate older draft shapes, but must declare which draft it implements and must not claim browser-native privileges it lacks.
2. Feature detect; never polyfill `modelContext` into a fake browser API.
3. Preserve origin in the descriptor. A tool from a destroyed page is removed from the registry immediately on `toolchange`/unload signals where available, and fails closed otherwise.
4. Keep the existing human approval and `tools.invoke` scope checks.
5. Map WebMCP annotation names to the neutral `risk` fields without inventing `destructiveHint` or `openWorldHint`.

## 4. UTCP adapter

### As-is

No UTCP code exists in this repository.

### Native behavior to reuse

- Specification 1.1; manual JSON with `manual_version`, `utcp_version`, `tools[]`, each tool carrying a `tool_call_template`.
- Discovery by fetching a manual (`GET /utcp`) or converting an OpenAPI document.
- Official TypeScript SDK `@utcp/sdk` 1.2.0 (MPL-2.0), `@utcp/http` 1.1.14; `UtcpClient.create`, `registerManual`, `registerManuals`, `deregisterManual`, `callTool`, `callToolStreaming`, `searchTools`, `getTools`, `getTool`. There is no `reloadManual`.
- Calls go directly to native endpoints through protocol plugins (HTTP, SSE, streamable HTTP, CLI, MCP, text, file, direct-call). No wrapper server is required.
- Auth stays provider-native via `auth_type` and `${VAR}` substitution with namespace isolation.
- v1.1 defaults `allowed_communication_protocols` to own protocol only, which prevents an HTTP manual from registering CLI tools.
- SSRF defenses: HTTPS/WSS or literal loopback only, redirect containment, remote manual cannot declare loopback targets, fixes for CVE-2026-44661 and related advisories.
- Verified gaps: no cancellation API, no configurable HTTP host allowlist, no DNS-rebinding resolution pinning.

### Proposed adapter rules

1. Depend on the official SDK. Do not reimplement UTCP discovery or call templates.
2. Add an AI Auth destination policy above the SDK: explicit endpoint allowlist, resolve-and-check before call to cover DNS rebinding, block private/link-local ranges, cap redirects, and require HTTPS outside literal loopback.
3. Keep credentials namespace-isolated per manual; never forward AI Auth grants or signatures as provider credentials.
4. Add a cancellation wrapper with a deadline at the invocation layer, while recording that native cancellation is unsupported.
5. Preserve native auth, rate limits, billing and errors in `native`.
6. No wrapper server solely to make UTCP tools look like MCP tools. The UTCP–MCP bridge is reference code, not a dependency.

## 5. Bridging rules

| Bridge                             | Status                              | Rule                                                                                                                                                    |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UTCP → MCP                         | Reference only (`@utcp/mcp-bridge`) | A new trust boundary; define caller authority, credential handling, resource audience and error mapping before use. No automatic credential forwarding. |
| MCP → unified registry             | Proposed                            | Native descriptor in `native`; native errors preserved.                                                                                                 |
| WebMCP → unified registry          | Proposed change                     | Existing catalog path reused; wire shape unchanged.                                                                                                     |
| UTCP → unified registry            | Proposed                            | Destination policy enforced before registration and invocation.                                                                                         |
| AI Auth tools → external consumers | Reject for now                      | Would export authority beyond the owner's consent; needs a separate decision.                                                                           |
| A2A agents → tool invocation       | Defer                               | A2A tasks are not tools. An adapter must not translate a task into a tool call implicitly.                                                              |
