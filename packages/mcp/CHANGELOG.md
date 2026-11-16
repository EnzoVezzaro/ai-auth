# Changelog

## Unreleased

## 0.3.0 - 2026-11-16

- Add `ai_auth_move` (move the agent's cursor on the shared page) and `ai_auth_act` (publish a signed activity status everyone on the page sees).
- Add `--http PORT`: serve MCP over Streamable HTTP on loopback at a secret path, for clients that connect to a URL such as ChatGPT's custom MCP servers. One agent runtime serves every client session.
- Verified with ChatGPT desktop: three chats with three agent wallets shared one site room, used the site's tools, and talked with each other and with the human visitor.

## 0.2.2 - 2026-11-16

- Fix the published dependencies. 0.2.0 and 0.2.1 shipped `file:../agent` and `file:../..` links in the registry manifest, which do not resolve after install. The package now depends on `@enzovezzaro/ai-auth-agent` `^0.1.2`, and the release publishes from the packed tarball so the manifest matches it. Use 0.2.2; 0.2.0 and 0.2.1 are deprecated.

## 0.2.1 - 2026-11-16

- Superseded by 0.2.2: the tarball had the pinned dependencies, but the registry manifest still carried the `file:` links.

## 0.2.0 - 2026-11-15

- Add the `ai-auth-mcp` command: `init`, `whoami`, `preview`, `serve` and `unlink`. Connect input can be an instruction, JSON, a site URL, or a provisional `/.well-known/ai-auth.json` manifest.
- Consent is required before any scope is granted: an interactive terminal shows a preview and prompts; a non-interactive run refuses unless `--approve` lists exact scopes, and never escalates beyond what the site requested.
- Add `ai_auth_status`, `ai_auth_join`, `ai_auth_leave`, `ai_auth_send`, `ai_auth_events`, `ai_auth_list_tools` and `ai_auth_invoke`, backed by the headless agent runtime (`@enzovezzaro/ai-auth-agent`).
- Claude Code was verified end to end. Codex and OpenCode registration is documented, but their tool calls are not yet verified.
- Replace authenticated service sessions with locally approved wallet actions.
- Sign action lifecycle events and allow the host to forward them through a locally chosen transport.
- Remove AI Auth backend and tenant API dependencies.
- Return generic MCP errors when an action or host event transport fails, so host secrets are not exposed to the client.

## 0.1.0 - 2026-11-15

- Release the local stdio adapter for explicitly approved, wallet-signed actions.

## 0.1.0-beta.0

- Initial local stdio MCP adapter preview with host-supplied wallet approval.
