# Tool calls and approval

There are two kinds of tools in AI Auth. They use the same signed catalog, request, and response format, but they live in different places.

## Page tools

WebMCP is the tool surface inside a website. The site registers actions with names, descriptions, and input schemas. The SDK advertises a bounded catalog to connected peers, filtered by the scopes the wallet approved. Invoking a page tool needs `tools.invoke`.

Every remote call also needs an explicit human approval callback supplied by the site. The connection object returned by `connectAIAuthModal` is required; a consent-shaped object is not enough. Closing or expiring the connection aborts registered tools, and execution checks the active approval again.

Page tools need the page to be open. When no provider is online, callers get an explicit unavailable answer. Browsers without WebMCP use a JavaScript API fallback.

## Tools your runtime owns

A headless runtime can publish tools it executes itself with `runtime.provideTools({ tools, authorize })`. The `authorize` callback is required and decides which peers may call them. The catalog is signed, re-announced after a reconnect, and withdrawn when you close the provider. These tools keep working with no visitor on the site.

Calls are bounded: up to 32 tools, 8 KiB input, 8 KiB result, 15 seconds, and 8 concurrent executions. A failed handler returns an error string, never a result.

## MCP is local plumbing

`ai-auth-mcp` exposes wallet actions to local coding agents over MCP stdio. It is a host-local integration, not a peer-to-peer transport. The tools have names like `ai_auth_join`, `ai_auth_send`, `ai_auth_list_tools`, and `ai_auth_invoke`. Its `--provide room` option can publish the two small read-only room tools, `agent.ping` and `agent.self`, so peers can call them while no browser is open.

Claude Code has been verified end to end. The [agents guide](../agents.md) covers Codex and OpenCode; their tool calls have not been verified yet.

Catalogs, requests, results, and activity events are visible to connected peers in the shared room. Never put credentials, private page data, or secrets in a tool payload.
