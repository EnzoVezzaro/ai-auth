# Reference review

Research snapshot: 2026-11-14. This is an implementation choice record; the project does not copy reference implementations.

## Standards and sources

- **auth.md:** the [WorkOS auth.md repository](https://github.com/workos/auth.md) was reviewed for registration and claim flows. Its guide separates identity assertion at `/agent/identity` from OAuth token exchange, describes ID-JAG/JWKS checks and anonymous/user claim ceremonies, and extends OAuth authorization-server metadata with an `agent_auth` block. The local service does not implement these endpoints or assert compatibility. The repository is open source under MIT; the protocol is evolving rather than a universal finalized standard.
- **MCP:** the [official specification](https://modelcontextprotocol.io/specification/2026-07-28) defines the JSON-RPC capabilities. The official [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) v2 was checked on npm at `2.4.0`, Apache-2.0, Node `>=20`. That SDK line implements the 2026-07-28 MCP version. The implementation uses its stdio server/client packages; MCP is not used as presence transport.
- **OAuth/OIDC:** use a maintained standards library for a future adapter. The local random token is a development credential only; it is not OAuth/OIDC, PKCE, JWT, DCR, a delegated provider credential, or an identity assertion.
- **WebMCP:** the [current Web Machine Learning Community Group document](https://webmachinelearning.github.io/webmcp/) is a draft, not a W3C standard. [Chrome's developer guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/webmcp/webmcp) calls it an early preview and documents a Chromium testing flag. The SDK feature-detects `document.modelContext`; the local demo's tool is explicitly authored and its real page state was changed in the browser. [Chrome Labs utilities](https://github.com/GoogleChromeLabs/webmcp-tools) are Apache-2.0 and were reviewed as developer references, not vendored.
- **Browser references:** [Ego Lite](https://github.com/citrolabs/ego-lite) is MIT-licensed and was used for the local demo's real browser verification. [OpenMausBot](https://github.com/milind-soni/OpenMausBot) is Apache-2.0 and was reviewed for browser/computer-use inspiration; no code was copied. [Webpage MCP](https://github.com/mcpland/webpage-mcp) is MIT-licensed and describes a Chrome extension/native-messaging bridge with broad browser permissions; it is a reference, not a dependency, and was not installed or tested.

## Dependency decisions

The existing repository was already TypeScript + Fastify + SQLite + `ws` + Zod. `npm ci` installed the locked graph with zero reported vulnerabilities. We retained this local stack to minimize setup requirements and added the official MCP SDK v2.4.0 (Apache-2.0); the matching MCP client is a development dependency. Prettier is used for formatting. ESLint was not added because the available `typescript-eslint` package declares a TypeScript peer range below the repository's existing TypeScript 7.0.2; forcing the peer conflict would not be a verified toolchain. Package licenses and runtime engines were read from npm metadata. No Redis, PostgreSQL, paid provider, or collaboration SaaS is required for the tested local flow.

## Deliberate limits

There is no vendor adapter, ID-JAG validation, OAuth server metadata, OIDC discovery, OpenAPI import, or remote MCP OAuth. The only native browser tool is an explicitly declared demo page-note action; AI Auth does not infer website capabilities. Browser support changes quickly; verify the target browser and preview flags before relying on WebMCP in a deployment.
