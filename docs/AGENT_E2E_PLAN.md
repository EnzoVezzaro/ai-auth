# Decentralized agent connection E2E plan

## Goal

A person can tell a chat agent (for example ChatGPT desktop): "connect to this site using ai auth". The agent discovers the site's AI Auth connect details, connects with the owner's approval, and stays connected across restarts. The site knows which verified agents are present, and exposes only its own WebMCP actions to them. Agents collaborate with each other and with people over direct WebRTC, with Nostr used only for signaling. No AI Auth server is in the path.

## Acceptance criteria

1. **Natural connect.** A copyable connect instruction and a site discovery hint let an agent learn origin, room, wallet URL and capabilities without hard-coded setup.
2. **Stays connected.** Session survives page reload with an explicit Resume, agent restart reconnects with the saved room, idle and expiry end the session, revocation reaches peers.
3. **Site awareness.** The page lists connected agents with verified identity and granted scopes. The WebMCP catalog contains only the site's published tools, and the wallet denies calls outside the granted scopes.
4. **Peer collaboration.** Two or more independent agents in one room discover each other and exchange signed messages, cursors and tool calls over a direct data channel.
5. **Serverless invariant.** Application events never go to a hosted service; relays carry signaling only. Verified with a network capture.
6. **Local and remote.** Every scenario runs against the local static site and the deployed GitHub Pages site.

## Waves

### Wave 0 — independent research (no shared files)

- **W1 connection baseline.** Map the existing connect instruction, discovery hint, MCP flags, session save/resume, and wallet approval path. Report gaps with file and line evidence. No code changes.
- **W2 multi-agent e2e harness.** Design and add deterministic tests for: connect, stay connected, site roster, WebMCP catalog scoping, denial, revocation. Own `tests/agent-connection-e2e.*` and a helper module. No edits to existing tests.
- **W3 transport invariant evidence.** Capture a real session with Playwright/REA and prove Nostr carries signaling only and application data is direct WebRTC. Own `scripts/verify-decentralized.mjs` and a report under `docs/evidence/`. No SDK edits.

### Wave 1 — implementation from findings

- **W4** natural-language connect UX and ChatGPT-facing skill; **W5** site roster and catalog scoping; **W6** reconnect/revocation fixes. Each owns distinct source files.

### Wave 2 — human and desktop testing

- **W7** ego-lite browser script for the human visitor (approve, observe roster, invoke and revoke).
- **W8** ChatGPT desktop computer-use script for the natural-language instruction.

### Wave 3 — integration

Merge in order, run full local and remote suites, update harness notes and publish evidence.

## Tooling

- Orca workers: `--agent opencode --model opencode/hy4-flash-free`, one worktree per worker.
- Browser: ego-lite (`ego-browser skill`) for the human side.
- Desktop: computer use for the ChatGPT desktop app.
- Transport evidence: REA capture plus Playwright network logs.

## Non-goals

No hosted agent service, no app server, no token or account, no TURN fallback, no automatic reconnect without a visitor click.
