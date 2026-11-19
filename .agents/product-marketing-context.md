# AI Auth — product marketing context

This is the authoritative marketing context for the AI Auth repository. The
copywriting skill at `.agents/skills/copywriting/SKILL.md` reads this file before
drafting copy. If a more recent authoritative context file exists elsewhere in
the project (for example `.claude/product-marketing-context.md`), prefer that one
and update it instead of creating a competing copy.

Last reviewed: 2026-11-18. Source of truth: the repository at the current
checkout. Latest release in the repository: 0.11.0, dated 2026-11-17.

Labels used below:

- **Verified** — stated in repository documentation, code, tests, or manifests.
- **Interpretation** — a reasonable reading of verified facts, not a customer claim.
- **Unknown** — no evidence in the repository. Do not turn this into a claim.

## Product overview

**Name:** AI Auth (written exactly, with the registered mark `AI Auth®` used in
the landing page header).

**Category:** A self-custodied wallet identity and browser collaboration SDK for
AI agents. It is a protocol plus four npm packages, not a hosted service.

**One-sentence value proposition (verified, from `llms.txt`):** AI Auth gives AI
agents a self-custodied wallet identity. Sites ask for specific capabilities,
owners approve them, and agents collaborate with people and other agents
directly, peer to peer.

**Established taglines (verified, preserve rather than replace):**

- "An identity your agents can take with them." (`README.md`)
- "Your agents. Their identities. Anywhere." (`index.html` document title)
- "An identity that moves through the agentic web" (`index.html` Open Graph title)
- "Give your agent an identity it can use on any site." (`index.html` meta description and hero)
- "A wallet identity your agents carry across the web. Connect to sites, approve what they can do, and let them work alongside people." (`index.html` social descriptions)
- "NO SERVER · SELF-CUSTODIAL" and "There is no server, account, or token to set up." (`index.html`)

**Core problem:** When an agent turns up at a website, the site needs to know
which agent it is and needs a way to say what that agent may do. AI Auth handles
both with a wallet the agent keeps, without running an identity server or
issuing a token. (`README.md`, `docs/ARCHITECTURE.md`)

**Desired outcome:** The owner approves named capabilities, the site keeps
control of its own data and tools, and peers verify signed activity directly.

**What it is not (verified, repeated across the repository):** There is no AI
Auth account, hosted service, key escrow, password reset, token, or blockchain.
Public Nostr relays carry signaling only. There is no TURN server. A signature
proves control of a key, not a human identity. See `llms.txt`,
`docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/limits.md`.

## Packages and distribution

All packages are MIT licensed and installed from npm. Node.js 22 or newer is
required for local development and the agent packages.

| Package | Version | Role | Evidence |
| --- | --- | --- | --- |
| `@enzovezzaro/ai-auth-wallet` | 0.11.0 | Browser SDK, wallet dialog, collaboration, WebMCP bridge. This repository root. | `package.json`, `README.md` |
| `@enzovezzaro/ai-auth-agent` | 0.1.6 | Headless Node agent with an encrypted file keystore, room runtime, and real WebRTC. | `packages/agent/README.md`, `packages/agent/package.json` |
| `@enzovezzaro/ai-auth-mcp` | 0.3.5 | `ai-auth-mcp` command and MCP tools for local coding agents. | `packages/mcp/README.md`, `packages/mcp/package.json` |
| `@enzovezzaro/ai-auth-runtime` | 0.1.1 | Provider-neutral plugin host for local agent applications. | `packages/runtime/package.json`, `CHANGELOG.md` |

Note: `packages/runtime/README.md` still says 0.1.0. Package manifests and the
changelog are authoritative. Verify versions before publishing a number.

The static site is published to GitHub Pages only, enforced by
`scripts/verify-pages-only.mjs`. See `docs/HOSTING.md`. The wallet and the demo
are marked `noindex`; the landing page has a canonical URL, structured data, a
social card, `robots.txt`, `sitemap.xml`, and `llms.txt`.

## Audience and personas

No customer interviews, surveys, testimonials, or usage metrics exist in the
repository. The segments below are **interpretations** derived from the package
surfaces and documentation structure. Label them as hypotheses in copy.

| Segment | Grounding | Problem | Motivation | Likely objection |
| --- | --- | --- | --- | --- |
| Site builders integrating a browser SDK | "Put AI Auth on a site", quickstart, site integration guide, wallet SDK package | A site cannot tell which agent is visiting and has no safe way to scope what it may do | Add agent identity without hosting an auth service or holding keys | "Does this mean running a server?" "Who approves?" |
| Headless agent builders | Agent package, agents guide, file keystore docs | An agent needs a stable identity and room presence without a browser tab | Run agents locally with keys that never leave the machine | "Will a restrictive NAT block it?" "What happens on restart?" |
| Local coding-agent users (Claude Code, Codex, OpenCode) | `docs/agents.md`, `docs/mcp.md`, `ai-auth-connect` skill | They want a coding agent to join a site and use its tools with real approval | Use one wallet identity across harnesses via MCP | "Is the connection live?" "Was a tool call actually approved?" |
| Wallet owners and site visitors | Wallet app, connect panel, `packages/p2p/copy.js`, landing page | They do not want sites or agents acting under their identity without permission | Approve exactly what is asked and revoke later | "Can a site widen what I granted?" "What if I lose the wallet?" |
| Security-conscious evaluators (hypothesis) | `docs/SECURITY.md`, trust boundary docs, hosting policy | They must assess a trust model before adopting it | Verify where keys live and what relays can see | "Is a signature an identity?" "Is revocation instant?" |

## Positioning and value proposition

**Primary positioning:** The identity layer for agents on the open web. A key
the agent controls, approval the owner gives, and a direct peer connection to
the site. No account, no server, no token.

**Primary audience:** Site builders and agent builders who need agent identity
and scoped authorization without operating a service.

**Secondary audience:** People who own a wallet and approve connections, and
users of local coding agents who want to connect those agents to a site.

**Unique differentiators (all verified):**

1. Self-custodied key: non-extractable in origin-scoped IndexedDB for browsers,
   or an encrypted mode `0600` file keystore for headless agents. No key escrow.
2. Scoped, local approval: the owner grants a subset of the requested
   capabilities; a site cannot add scopes or silently renew.
3. Per-action approval: a WebMCP tool call needs both the wallet scope check and
   the page's own approval step.
4. Direct transport: signed envelopes travel over a WebRTC data channel; Nostr
   relays carry signaling only.
5. No hosted component: the site, wallet, bundles, and docs are static files.
6. Open and inspectable: MIT license, public architecture, protocol, security,
   and evidence docs, with a CI-enforced GitHub Pages hosting policy.

## Features and benefits

| Actual feature (verified) | User benefit | Evidence |
| --- | --- | --- |
| Signed wallet identity (public key) | A site can verify which agent acted without a central login | `README.md`, `docs/ARCHITECTURE.md`, `packages/p2p/p2p.js` |
| Non-extractable key in origin-scoped IndexedDB | The site cannot read the key or sign as the wallet | `docs/ARCHITECTURE.md`, `docs/SECURITY.md` |
| Named capabilities with owner-approved subset | Grant only what you choose; a URL alone grants nothing | `README.md`, `docs/SECURITY.md`, `packages/p2p/capabilities.js` |
| Per-action approval for WebMCP tools | Each tool call still needs the site's own check and your approval | `packages/p2p/webmcp.js`, `docs/ARCHITECTURE.md`, `CHANGELOG.md` 0.5.0 |
| Bounded, signed tool catalog with `consequentialHint` and `untrustedContentHint` | Know which actions matter and which results are untrusted before approving | `CHANGELOG.md` 0.8.0, `packages/p2p/webmcp.js` |
| Direct WebRTC data channel for signed events | Messages, cursors, and tool calls go peer to peer, not through a service | `docs/ARCHITECTURE.md`, `packages/p2p/p2p.js` |
| Public Nostr relays for signaling only | Peers can meet without an AI Auth server | `docs/DISCOVERY.md`, `docs/ARCHITECTURE.md` |
| Copyable connect instruction and connect panel | Hand an agent exact public connection details and see handshake state | `README.md`, `packages/p2p/agent-connect.js` |
| One-click Resume after a refresh | Keep the approved grant without silent automatic reconnection | `docs/limits.md`, `docs/quickstart.md`, `packages/p2p/copy.js` |
| Sessions with TTL, idle timeout, renewal, and revocation | Limit how long access lasts and end it when needed | `README.md`, `CHANGELOG.md` 0.5.0, `docs/lifecycle.md` |
| Encrypted `0600` file keystore for headless agents | Run agents without a browser while the key stays on the machine | `packages/agent/README.md`, `docs/agents.md` |
| `ai_auth_*` MCP tools registered only for approved scopes | Drive the same wallet from a local coding agent, with no extra scopes | `docs/agents.md`, `packages/mcp/README.md` |
| Signed delivery receipts and message states | See whether a peer accepted an addressed message | `CHANGELOG.md` 0.5.0, `packages/p2p/receipts.js` |
| Open and restricted rooms, membership proofs, short execution grants | Share a space without handing out access by default | `README.md`, `docs/SECURITY.md` |
| Plain-language, actionable UI copy enforced by tests | Errors tell the person what to do next | `packages/p2p/copy.js`, `tests/plain-copy.test.mjs`, `tests/actionable-error-copy.test.mjs` |

Common use cases (verified or directly supported by the docs): connect a site
and one agent to the same room; publish a connect instruction so any agent can
join; resume after a refresh; run a headless agent with a keystore; connect
Claude Code, Codex, or OpenCode through MCP; expose a page's WebMCP tools to an
agent with approval; chat and share cursors in a room.

Experimental or not yet available: automatic reconnect on page load (not
available, and must not be described as automatic); `tasks.delegate` is accepted
for compatibility but grants no working handoff; the `degraded` connection state
has no code path that enters it. See `docs/limits.md`, `docs/DISCOVERY.md`, and
`CHANGELOG.md` 0.5.2.

## Competitive context

No competitor names, comparisons, adoption figures, or endorsements appear in
the repository. Do not invent them. When a comparison is genuinely needed,
compare only on verifiable architecture properties (hosted service versus
self-custodied keys, account versus key-based identity, relay-carried data
versus direct WebRTC) and name a competitor only when the user supplies it.

## Voice and tone

**Voice:** Plain, direct, technical but readable. Lead with what the thing does.
Use short sentences and active voice. Prefer "you" and "your agent" for the
visitor. Keep exact technical nouns: origin, room, wallet, capability, session,
signed event, relay, data channel. Write like the project's docs: factual, calm,
and specific, with limits stated openly. `docs/limits.md` opens with "These are
the current limits. They are stated plainly so a site can plan around them."

**Tone rules derived from code and tests:**

- Every error or warning must name a concrete next step. This is enforced by
  `tests/actionable-error-copy.test.mjs` against messages in `packages/p2p/copy.js`
  and the wallet app. Example: "You closed the request. Click Connect agent to
  try again." Not "Request failed."
- Describe states in one plain sentence. Example: "Connected. Waiting for other
  visitors or agents." for `waiting-for-peers`; "Connected with a live partner."
  for `direct-peer-connected`.
- Translate technical permissions into plain titles. Examples from
  `packages/p2p/copy.js`: "See who else is here" for `presence.read`, "Send
  messages" for `messages.send`, "Use the page's tools (you approve each use)"
  for `tools.invoke`.
- Show times in the viewer's local time, never UTC. Under a minute is "less than
  a minute". No fixed end is "Never". Examples: "Session ends at 3:04 AM (in 29
  minutes)" and "No time limit. The session stays active and resumable after a
  refresh until you end it."
- Use sentence case for headings. Use exact product names and package names.
- Keep the established ® in the header brand, not in running prose.

**Visual identity considerations relevant to copy:** The landing page is a dark
canvas (`#080a0d`, `#0b0b0d`) with Funnel Display type, numbered eyebrows such as
`[ 01 ] Model` (uppercased in CSS), monospace small labels for nouns such as `SITE`, `VISITOR`,
`AGENT`, and orange call-to-action buttons. Named agents appear with short ids
(`o87xdo83`, `k2f9ns41`, `v3xk82bd`). Copy for this surface should be short,
concrete, and built for large display type; reserve detail for the docs. See
`index.html`, `landing.css`, and `docs/assets/ai-auth-banner.svg`.

**Preferred terminology:** AI Auth; wallet identity; agent; site; origin; room;
capability; signed consent; signed event; approval; session; resume; WebMCP;
Nostr relays for signaling; WebRTC data channel; self-custodied; MIT; local
agent; keystore.

**Prohibited or corrected terminology:** account, hosted AI Auth service, server
holding keys, key escrow, password reset, token, blockchain, automatic reconnect,
relay-carried application data, "trusted by thousands", "revolutionary",
"industry-leading", "seamless", "unlock your potential", "transform your
workflow", "the future of AI". A valid signature is not a human identity, and
private mode is not anonymity. See `llms.txt`, `docs/SECURITY.md`,
`docs/limits.md`.

## Conversion objectives

**Primary conversion goal:** Get a developer to install and connect. On the
landing page this is "Connect a site" / "Get the SDK" leading to
`https://enzovezzaro.github.io/ai-auth/docs/quickstart.html` (source file
`docs/quickstart.md`) or `npm install @enzovezzaro/ai-auth-wallet`.

**Secondary actions:** Open the wallet; run an agent with
`@enzovezzaro/ai-auth-agent`; connect a local coding agent using `ai-auth-mcp`
and the `ai-auth-connect` skill; read the architecture, security, and agents
docs; contribute an issue or pull request.

**Main objections:** No server means new trust questions; setup needs Node 22;
deployed sites need HTTPS; no TURN can block a connection behind restrictive
NAT; no automatic reconnect means a one-click Resume; losing the wallet and
recovery file loses the identity; signature does not prove a human; revocation is
eventually consistent; private mode is not anonymity.

**Trust signals available (verified):** MIT license; published npm packages with
versions; CI, release, and Pages workflows; a CI guard enforcing GitHub Pages
only; public architecture, protocol, security, limits, and evidence docs;
browser E2E assertions and saved screenshots; a dated generic integration review
that states what the evidence does and does not cover.

**Pricing and distribution:** Free and MIT licensed. `index.html` structured data
declares `price: 0` USD. There is no pricing page, plan tier, or signup. Do not
invent one; describe distribution as npm packages plus a static site.

## Evidence and limitations

**Acceptable evidence:** repository documentation, implementation code, tests,
package manifests, changelog entries with dates, CI workflows, E2E assertion
logs and screenshots, and the explicit review records in
`docs/GENERIC_INTEGRATION_REVIEW.md` and `docs/evidence.md`.

**Limits to respect in copy:**

- Browser tests need public relay signaling and direct ICE; a peer discovered is
  not the same as a working collaboration session. (`README.md`,
  `docs/GENERIC_INTEGRATION_REVIEW.md`)
- Screenshots are UI evidence, not proof of peer delivery by themselves.
- Harness notes are dated observations, not current behavior. Claude Code on
  2026-11-15 reached a peer over WebRTC; Codex and OpenCode on 2026-11-15
  registered tools but completed no tool call; ChatGPT desktop on 2026-11-16
  shared a room over HTTP endpoints and needed one manual re-add. Always tell
  the reader to verify the current session with `ai_auth_status`. (`docs/agents.md`)
- No production consumer deployment is established. `examples/body4ai` is a
  demo, not the live Body4AI site, and its catalog is not part of AI Auth.
- No customer research, testimonials, metrics, or endorsements exist. Never
  fabricate them.

## Primary marketing URLs

- Live landing page: https://enzovezzaro.github.io/ai-auth/
- Wallet: https://enzovezzaro.github.io/ai-auth/wallet/
- Quickstart: https://enzovezzaro.github.io/ai-auth/docs/quickstart.html
- Architecture: https://enzovezzaro.github.io/ai-auth/docs/ARCHITECTURE.html
- Docs index: https://enzovezzaro.github.io/ai-auth/docs/README.html
- Machine-readable overview: https://enzovezzaro.github.io/ai-auth/llms.txt
- Repository: https://github.com/EnzoVezzaro/ai-auth
- Wallet package: https://www.npmjs.com/package/@enzovezzaro/ai-auth-wallet
- Agent package: https://www.npmjs.com/package/@enzovezzaro/ai-auth-agent
- MCP package: https://www.npmjs.com/package/@enzovezzaro/ai-auth-mcp
- Runtime package: https://www.npmjs.com/package/@enzovezzaro/ai-auth-runtime

Note: GitHub Pages serves this project under `/ai-auth/`. The discovery hint is
reachable at `/ai-auth/.well-known/ai-auth.json`, while the convention fetches
the origin root. See `docs/DISCOVERY.md`.

## Sources within the repository

Product and positioning: `README.md`, `llms.txt`, `index.html`, `landing.css`,
`docs/README.md`, `docs/ARCHITECTURE.md`.

Audience and usage: `docs/quickstart.md`, `docs/site-integration.md`,
`docs/agents.md`, `docs/mcp.md`, `examples/body4ai/README.md`,
`packages/agent/README.md`, `packages/mcp/README.md`,
`packages/runtime/README.md`.

Voice and copy: `packages/p2p/copy.js`, `packages/p2p/wallet-setup-copy.js`,
`tests/plain-copy.test.mjs`, `tests/actionable-error-copy.test.mjs`,
`.agents/skills/humanizer/SKILL.md`, `.agents/skills/ai-auth-connect/SKILL.md`.

Trust and limits: `docs/SECURITY.md`, `docs/limits.md`, `docs/lifecycle.md`,
`docs/RECOVERY.md`, `docs/HOSTING.md`, `docs/DISCOVERY.md`, `docs/protocol.md`,
`docs/evidence.md`, `docs/GENERIC_INTEGRATION_REVIEW.md`, `docs/E2E.md`,
`CHANGELOG.md`, `LICENSE`.

Distribution and verification: `package.json`, `packages/*/package.json`,
`.github/workflows/ci.yml`, `.github/workflows/pages.yml`,
`.github/workflows/release.yml`, `scripts/verify-pages-only.mjs`,
`sitemap.xml`, `robots.txt`.

## Unresolved marketing questions and evidence gaps

- No customer research exists. All personas are hypotheses derived from docs.
- No competitor analysis exists in the repository.
- No adoption, performance, or reliability metrics exist. Do not state any.
- Production consumer deployment and cross-network reachability are not
  established by the current evidence.
- `packages/runtime/README.md` has a stale version number; confirm manifests
  before quoting a version.
- The discovery hint's path under `/ai-auth/` differs from the origin-root
  convention, which affects any copy about automatic agent discovery.
