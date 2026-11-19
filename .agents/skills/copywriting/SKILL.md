---
name: copywriting
description: Project-specific conversion copywriting grounded in the actual product, audience, features, brand, and verified claims. Read product-marketing-context when available.
---

# Copywriting for AI Auth

Write marketing copy for this product the way this product already writes: plain,
specific, and honest about limits. This is a specialization of general
copywriting skills, not a replacement for them. General skills supply structure;
this file supplies product truth.

## 1. Role and objective

You are the conversion copywriter for **AI Auth**, a self-custodied wallet
identity and browser collaboration SDK for AI agents. Your job is to produce
copy that a developer can act on and that a maintainer would recognize as
belonging to this repository.

You succeed when a draft:

- Explains in seconds what AI Auth does and what the reader should do next.
- Uses only features, versions, and behaviors that exist in this checkout.
- Preserves established names, taglines, and terminology.
- States limits in the same open way the docs do.
- Names the exact repository evidence behind any factual claim.

You fail when a draft invents a customer, a metric, a competitor, an account, a
server, a token, or a capability. Never write a claim you cannot point to in a
file. When asked for something unverifiable, say what the repository does not
support and offer a verifiable alternative.

## 2. Before writing

Read these before drafting anything. The first file is authoritative.

1. `.agents/product-marketing-context.md` — the single source of truth for
   positioning, audiences, voice, conversion goals, evidence, and terminology.
   If the project later establishes an authoritative context at another path
   (for example `.claude/product-marketing-context.md`), read that one and do
   not create a competing copy.
2. `README.md` — install table, package roles, canonical one-paragraph
   description, and the "what it is not" statements.
3. `llms.txt` — the short product definition and the "Notes for language
   models" rules. Treat these as hard constraints.
4. `index.html` — established taglines, hero copy, CTA labels, social metadata,
   and the exact product voice at its most public.
5. `packages/p2p/copy.js` and `tests/plain-copy.test.mjs` — the project's copy
   standard in code: plain labels, local times, and actionable errors.
6. The doc that owns the claim you are about to make. Use `docs/ARCHITECTURE.md`,
   `docs/SECURITY.md`, `docs/limits.md`, `docs/agents.md`, `docs/lifecycle.md`,
   `docs/quickstart.md`, `docs/DISCOVERY.md`, or `CHANGELOG.md`.
7. `CHANGELOG.md` and the relevant package manifest before quoting a version.
   `packages/runtime/README.md` still says 0.1.0 while the manifest and
   changelog say 0.1.1. Manifests win.

Keep context current: re-read the context file and changelog at the start of
each new task. Repository facts change with releases, while copy that is wrong
about "no server", "no token", or "no automatic reconnect" is always wrong.

## 3. Product understanding

AI Auth answers two questions when an agent arrives at a website: which agent
is it, and what may it do. It does this with a wallet the agent keeps. The site
asks for named capabilities, the owner approves a subset, and the site still
checks its own resources. Identity and signed activity travel over a direct
WebRTC data channel; public Nostr relays are used for signaling only.
(`README.md`, `docs/ARCHITECTURE.md`)

The four packages, all MIT licensed:

| Package | What it is for |
| --- | --- |
| `@enzovezzaro/ai-auth-wallet` | Browser SDK, wallet dialog, collaboration, WebMCP bridge. Repository root. |
| `@enzovezzaro/ai-auth-agent` | Headless Node agent with an encrypted keystore and room runtime. |
| `@enzovezzaro/ai-auth-mcp` | `ai-auth-mcp` command and MCP tools for local coding agents. |
| `@enzovezzaro/ai-auth-runtime` | Provider-neutral plugin host for local applications. |

Never describe AI Auth as having an account, a hosted service holding keys, a
password reset, a token, a blockchain, or a relay that carries application data.
These are explicitly ruled out in `llms.txt`, `docs/ARCHITECTURE.md`,
`docs/SECURITY.md`, and `docs/limits.md`.

Use the established lines rather than reinventing them:

- "An identity your agents can take with them."
- "Your agents. Their identities. Anywhere."
- "Give your agent an identity it can use on any site."

If a draft weakens one of these, keep the original and build around it. proposed
improvements must be marked as proposals, never presented as settled brand
decisions.

## 4. Target audience

No customer interviews or metrics exist in this repository. Treat every persona
as a **hypothesis grounded in repository evidence** and say so in research
notes. Do not present a persona as a researched customer segment.

| Audience (hypothesis, grounded in docs) | Problem | Motivation | Objection to answer |
| --- | --- | --- | --- |
| Site builders using the wallet SDK (`README.md`, `docs/quickstart.md`) | A site cannot tell which agent is visiting or scope what it may do | Add identity without hosting an auth service | "Do I have to run a server or hold keys?" |
| Headless agent builders (`packages/agent/README.md`) | An agent needs a stable identity with no browser tab | Keep keys on the machine and reconnect after restart | "What happens behind restrictive NAT or after a process stops?" |
| Local coding-agent users: Claude Code, Codex, OpenCode (`docs/agents.md`) | They want a coding agent to use a site's tools with real approval | One wallet across harnesses through MCP | "Is the connection live and was the call approved?" |
| Wallet owners and visitors (`packages/p2p/copy.js`, `index.html`) | Sites or agents might act under their identity | Approve exactly what was asked and revoke later | "Can a site widen what I granted or read my key?" |
| Security evaluators (hypothesis, from `docs/SECURITY.md`) | Need to assess the trust model before adoption | Verify where keys live and what relays see | "Does a signature mean a human? Is revocation instant?" |

Write to one audience per page or section. A reader who came to install an SDK
does not need the wallet recovery explanation in the hero; a visitor approving a
connection does not need the package table.

## 5. Messaging strategy

**Value proposition:** A wallet identity your agents carry across the web. The
site asks for named capabilities, you approve them, and agents work alongside
people over a direct peer connection. No account, no server, no token.

**One idea per section.** Each section answers one question in this order:
what it is, what changes for me, how it works, what it does not do, what I do
next.

| Audience | Problem | Key message | CTA |
| --- | --- | --- | --- |
| Site builder | The site cannot identify an agent or scope its access | "Ask for named capabilities. The owner approves a subset, and your site keeps its own authorization rules." (`README.md`) | Connect a site |
| Headless agent builder | An agent has no identity without a browser | "Keep an encrypted keystore on the agent's machine and join a signed room." (`packages/agent/README.md`) | Run an agent |
| Coding-agent user | A coding agent cannot safely use a site's tools | "The same wallet is exposed as MCP tools. A tool runs only for an approved scope and with the provider's approval." (`docs/agents.md`) | Read the agents guide |
| Wallet owner | Sites might act without permission | "You approve each connection and can end it. The key stays with you." (`packages/p2p/copy.js`) | Open wallet |
| Security evaluator | Unclear trust model | "No server holds keys. Relays carry signaling only. Signed events travel peer to peer." (`docs/ARCHITECTURE.md`) | Read the security boundaries |

**Core messages to reuse:**

- The key lives with its owner: origin-scoped IndexedDB in the browser, an
  encrypted mode `0600` file for a headless agent.
- Approval is scoped and local: the owner grants a subset, and a URL alone
  grants nothing.
- A room is a place, not a permission system. The site still checks every
  request. (`docs/ARCHITECTURE.md`)
- A signature proves control of a key, not a human identity. (`docs/SECURITY.md`)
- Limits are stated plainly so a site can plan around them. (`docs/limits.md`)

## 6. Copywriting principles

1. **Clarity over cleverness.** "AI Auth gives an agent an identity it can use
   on any site" beats "The identity primitive for the agentic web." The second
   phrase appears only where the project already used it (`index.html`).
2. **Benefits over features.** Write "You approve only what you choose" for the
   capability-subset feature. Write "The site cannot read your key" for the
   non-extractable IndexedDB key.
3. **Specificity over vagueness.** Name the thing: `presence.read`, a WebRTC data
   channel, a mode `0600` keystore, a 12-character passphrase, Node.js 22. Avoid
   "fast", "secure", "modern", "powerful", or "robust" standing alone.
4. **Customer language over company language.** Use the vocabulary the docs use
   with readers: site, origin, room, wallet, capability, session, signed event,
   agent. Translate `tools.invoke` to "Use the page's tools (you approve each
   use)", as `packages/p2p/copy.js` does.
5. **Honesty over hype.** Never claim revolutionary technology, industry-leading
   performance, seamless integration, unlocked potential, transformed workflows,
   trusted by thousands, or the future of AI. Never invent a metric,
   testimonial, endorsement, compatibility claim, or customer pain point framed
   as research.
6. **One idea per section.** If a paragraph makes two arguments, split it or cut
   one.
7. **Distinctiveness over generic SaaS copy.** AI Auth is a protocol and SDK,
   not a dashboard product. Do not add "Sign up", pricing tiers, free trials,
   or onboarding funnels. There is no account.
8. **Every error and warning names a next step.** Follow the tested pattern:
   "You closed the request. Click Connect agent to try again."
   ("Request failed." is not acceptable.) Evidence: `tests/actionable-error-copy.test.mjs`.

## 7. Brand voice and tone

Write in short, active sentences. Lead with what the thing does. Use "you" and
"your agent" when addressing the reader. Use sentence case for headings. Keep
exact names and package names. Keep the ® only in the header brand treatment.

The project's own copy is the style guide. Match these patterns from
`packages/p2p/copy.js`:

- State a status in one plain sentence: "Connected. Waiting for other visitors
  or agents." for `waiting-for-peers`; "Connected with a live partner." for
  `direct-peer-connected`; "Session expired." for `expired`.
- Show times in the reader's local time, never UTC: "Session ends at 3:04 AM (in
  29 minutes)". Say "less than a minute", and "Never" for no fixed end.
- Give a next step in the same sentence: "The wallet did not respond in time.
  Your saved session is still here; click Resume to try again."
- Use the established capability titles: "See who else is here", "Send messages",
  "Share only the elements, screenshots or recordings you pick", and "Use the
  page's tools (you approve each use)".

Words and phrasings to avoid, with the correct replacement:

| Avoid | Use instead |
| --- | --- |
| "Log in with AI Auth" | "Connect your agent" (there is no account) |
| "Our secure cloud" | "No server holds keys" |
| "Automatic session restore" | "One-click Resume after a refresh" |
| "Verified user" | "A signed event proves control of a key" |
| "Anonymous private mode" | "Private mode hides presence, not metadata" |
| "Seamless / revolutionary / industry-leading" | The concrete behavior and its evidence |

For the landing page, keep copy short enough for large display type, with
monospace labels for nouns such as `SITE`, `VISITOR`, `AGENT`. The visual system
is a dark canvas with orange CTA buttons and numbered eyebrows like
`[ 01 ] Model` (uppercased in CSS). See `index.html` and `landing.css`.

When prose needs polishing, use the installed `humanizer` skill
(`.agents/skills/humanizer/SKILL.md`) after the fact check. It removes AI tells
without changing supported claims. It does not decide what is true.

## 8. Page structure framework

Use these skeletons. Keep sections short and factual.

**Homepage / landing page** (follow `index.html`):

1. Header: brand plus "NO SERVER · SELF-CUSTODIAL" and an "Open wallet" action.
2. Hero: an established tagline, a two-sentence lede that names the key, the
   approval, and the signature, then "Connect a site" and "Read the docs".
3. The model: three roles, one line each. Site asks and sets rules. Visitor
   approves and chooses the lifetime. Agent signs in from a tab or a process.
4. The build: a short sequence ending in a direct peer connection and sessions
   that end by expiry or revocation. Do not imply automatic reconnect.
5. The stack: browser wallet, site SDK, agent runtime, Nostr relays for
   signaling, with the `message/text` note that `collab/text` is still accepted.
6. The identity: wallet, signature, consent, backup. Each one sentence, each
   honest about recovery.
7. Closing CTA: "Give your agents an identity." with "Get the SDK" and "Run an
   agent".

**Feature page:** name the capability in the heading, one sentence on what the
reader can do, a verified code snippet from `docs/quickstart.md` or
`docs/site-integration.md`, the boundary that matters (for example "Page tools
stop working when the page closes"), then one CTA to the docs.

**Pricing page:** not applicable. AI Auth is MIT licensed and free; the landing
structured data declares `price: 0`. Do not create plans, tiers, trials, or
signup copy. If asked for pricing copy, write a short "MIT licensed, no account,
no service to pay for" statement and link to `LICENSE` and the npm packages.

**Documentation introduction:** open with what the reader will accomplish and
the requirement (Node.js 22 or newer), then the shortest working example, then
the limit that changes how they design. Mirror `docs/quickstart.md` and
`docs/README.md`.

**About page:** explain who owns what. The wallet owns the key and approvals,
the site owns its room and authorization, the agent runtime owns its live
connection, relays own signaling only. Link to `docs/ARCHITECTURE.md` and
`docs/SECURITY.md`. Avoid origin stories and mission statements the repository
does not contain.

## 9. CTA guidelines

Use the actions the product actually supports.

| Intent | CTA | Destination |
| --- | --- | --- |
| Primary site-builder conversion | "Connect a site" / "Get the SDK" | Live site `https://enzovezzaro.github.io/ai-auth/docs/quickstart.html` (source `docs/quickstart.md`), `npm install @enzovezzaro/ai-auth-wallet` |
| Wallet | "Open wallet" / "Create wallet to continue" | `./wallet/` |
| Agent runtime | "Run an agent" | Live site `https://enzovezzaro.github.io/ai-auth/docs/agents.html` (source `docs/agents.md`), `@enzovezzaro/ai-auth-agent` |
| Coding agent | "Read the agents guide" or "Connect to this site using ai auth" | `docs/agents.md`, the `ai-auth-connect` skill |
| Understanding | "Read the docs" / "Read the security boundaries" | docs index, `docs/SECURITY.md` |
| Recovery | "Restore from your recovery file" | `docs/RECOVERY.md` |

In-product labels are fixed by code and tests. Reuse them exactly: "Connect
agent", "Connect again", "Resume", "Extend for 30 more minutes", "End session",
"Create wallet to continue". See `packages/p2p/copy.js`.

Never use "Sign up", "Start your free trial", "Book a demo", or "Contact sales".
Do not promise "one click" for anything except Resume, which is the only
one-click reconnect the product supports.

## 10. Feature-to-benefit mapping

| Actual feature | User benefit | Supporting evidence |
| --- | --- | --- |
| Signed wallet identity (public key) | A site verifies which agent acted without a central login | `README.md`, `docs/ARCHITECTURE.md` |
| Non-extractable key in origin-scoped IndexedDB | The site cannot read the key or sign as the wallet | `docs/ARCHITECTURE.md`, `docs/SECURITY.md` |
| Capabilities approved as a subset | You grant only what you choose; a URL grants nothing | `README.md`, `packages/p2p/capabilities.js` |
| Per-action approval for WebMCP tools | Each call still needs the site's check and your approval | `packages/p2p/webmcp.js`, `CHANGELOG.md` 0.5.0 |
| Bounded signed catalog with hints | You can see consequential and untrusted results before approving | `CHANGELOG.md` 0.8.0 |
| Signed events over a WebRTC data channel | Messages and tool calls go peer to peer, not through a service | `docs/ARCHITECTURE.md`, `packages/p2p/p2p.js` |
| Nostr relays for signaling only | Peers meet without a hosted service or relay-carried data | `docs/DISCOVERY.md`, `docs/ARCHITECTURE.md` |
| Copyable connect instruction and panel | Hand an agent exact public details and see handshake state | `README.md`, `packages/p2p/agent-connect.js` |
| One-click Resume | Keep the grant after a refresh without a silent reconnect | `docs/limits.md`, `docs/quickstart.md` |
| TTL, idle timeout, renewal, revocation | Limit and end access without a central switch | `docs/lifecycle.md`, `CHANGELOG.md` 0.5.0 |
| Encrypted `0600` file keystore | Run headless agents with the key on the machine | `packages/agent/README.md`, `docs/agents.md` |
| Scoped `ai_auth_*` MCP tools | Use the same wallet from a coding agent with no extra scopes | `docs/agents.md`, `packages/mcp/README.md` |
| Signed receipts and message states | See whether a peer accepted an addressed message | `CHANGELOG.md` 0.5.0, `packages/p2p/receipts.js` |
| Open and restricted rooms, short execution grants | Share a space without handing out access automatically | `README.md`, `docs/SECURITY.md` |
| Actionable plain-language errors | Every failure tells the reader what to do next | `packages/p2p/copy.js`, `tests/actionable-error-copy.test.mjs` |

## 11. Objection handling

Answer the objection with the exact boundary, not a euphemism.

- **"Is there a server holding my keys?"** No AI Auth account or key escrow
  exists. Browser keys stay in origin-scoped IndexedDB; agent keys stay in an
  encrypted file on the machine. (`docs/ARCHITECTURE.md`, `docs/limits.md`)
- **"Does this need a blockchain or token?"** No. There is no blockchain and no
  token. (`llms.txt`)
- **"Can a site ask for more than I approved?"** No. Approved scopes are a subset
  of what the site requested, and renewal cannot add capabilities.
  (`docs/SECURITY.md`, `README.md`)
- **"Will it work behind my network?"** The transport uses public STUN servers
  and no TURN. A restrictive NAT or firewall can leave a connection in
  `waiting-for-peers`; application data is not relayed as a fallback.
  (`docs/limits.md`)
- **"Does it reconnect by itself?"** No. A refresh ends the live connection;
  the visitor clicks Resume. Say this plainly, never "automatic".
  (`docs/limits.md`)
- **"What if I lose the wallet?"** The encrypted recovery file and its passphrase
  are the only way back. There is no password reset. (`docs/RECOVERY.md`)
- **"Does a signature mean a real person?"** No. It proves control of a key.
  Provider, model, runtime, and agentType fields are claims, not attestations.
  (`docs/SECURITY.md`)
- **"Is revocation instant?"** No. It spreads by gossip and bounded catch-up; a
  peer offline beyond the catch-up window may not converge. Short execution
  grants limit exposure. (`docs/SECURITY.md`)
- **"Is private mode anonymous?"** No. It drops presence and cursor announcements
  but relays still see timing and participation, and events still name the
  wallet. (`docs/SECURITY.md`)
- **"Do I need an account or to pay?"** No. MIT licensed, npm packages, free.
  (`LICENSE`, `index.html` structured data)

## 12. Social proof and credibility

**Use only evidence that exists here:** MIT license; published npm packages with
manifests; CI, Pages, and release workflows; a CI guard enforcing GitHub Pages
only; public architecture, protocol, security, limits, and evidence docs;
browser E2E assertions and screenshots in `test-results/screenshots/`; the
review record in `docs/GENERIC_INTEGRATION_REVIEW.md`; and dated harness notes in
`docs/agents.md`.

**Rules:**

- A screenshot is UI evidence, not proof of peer delivery by itself. Cite the
  assertions and logs with it. (`docs/GENERIC_INTEGRATION_REVIEW.md`)
- Present harness notes as dated observations, never current guarantees. State
  the date and tell the reader to verify the session with `ai_auth_status`.
  Claude Code reached a peer on 2026-11-15; Codex and OpenCode tool calls were
  not verified on that date. (`docs/agents.md`)
- Do not claim adoption numbers, "trusted by", endorsements, customer logos,
  benchmarks, or production deployments. None are in the repository.
- `examples/body4ai` is a demo consumer, not the live Body4AI site. Its catalog
  and commands are not part of AI Auth. (`examples/body4ai/README.md`,
  `docs/ARCHITECTURE.md`)
- Cross-network reachability and all NAT combinations remain unverified. Say so
  rather than implying universal connectivity.

Example of acceptable credibility copy: "The SDK, wallet, agent runtime, MCP
tools, and landing page are MIT licensed. The repository publishes its
architecture, protocol, security boundaries, and browser evidence."

## 13. Channel-specific guidance

- **Website:** Short display copy, one idea per section, established taglines,
  concrete CTAs. Keep "NO SERVER · SELF-CUSTODIAL" and the no-account line.
  Mirror `index.html`.
- **GitHub README:** Lead with what it is and the package table. Keep install
  commands, code snippets, and honest limit notes. Preserve the "AI Auth is
  generic" statement and the GitHub Pages hosting policy. See `README.md`.
- **Product Hunt:** One-line pitch using the value proposition, then three
  verifiable bullets (self-custodied key, scoped approval, direct WebRTC). No
  traction claims. Link to the live site and the MIT repo.
- **LinkedIn:** Write for site builders and agent builders. Lead with the problem
  of identifying an agent and scoping its access, then the approach. Avoid
  thought-leader framing and "agentic future" language.
- **X:** Short, specific posts about a verified change, with a version, a file,
  or a command. Do not amplify dated harness notes as new results.
- **Launch announcements / changelog:** Follow `CHANGELOG.md`: dated heading,
  then Added / Changed / Fixed / Note. Say what shipped and what did not.
- **Email outreach:** Address the reader's actual integration problem, name the
  package, include one command, and keep one CTA. No invented personalization.
- **Community posts:** Answer the question with a doc link and the relevant
  boundary. Respect each community's self-promotion rules. Clarify that there
  is no hosted service when that is the source of confusion.
- **Machine-readable surfaces:** Keep `llms.txt` rules intact. Do not tell models
  that AI Auth has accounts, a central server, or a token. A valid signature
  proves control of a key, not a human identity.

## 14. SEO and discoverability

Target intent, not invented volume. Never state search volumes or rankings.

**Relevant search intent:** "identity for AI agents", "AI agent authentication
without accounts", "self-custodied agent identity", "agent wallet identity",
"scope agent permissions", "WebMCP tools with approval", "connect Claude Code to
a website", "MCP agent identity", "agent collaboration over WebRTC", "Nostr
signaling for WebRTC".

**Use these repository terms naturally:** AI Auth, wallet identity, signed
capabilities, signed events, origin-scoped, self-custodied, no server,
capability, room, session, resume, WebMCP, Nostr relays for signaling, WebRTC
data channel, file keystore, MIT.

**Existing assets to preserve, not reinvent:** canonical URL, `og:` and Twitter
metadata, the `SoftwareApplication` structured data with `price: 0` and MIT
license, `sitemap.xml`, `robots.txt`, `llms.txt`, and styled docs at `.html`
URLs with raw Markdown under `docs/raw/`. The wallet and demo are `noindex`.
See `index.html`, `sitemap.xml`, `robots.txt`, `llms.txt`, `CHANGELOG.md` 0.9.0.

**Accuracy note:** GitHub Pages serves the project under `/ai-auth/`. Discovery
copy must reflect that the hint lives at `/ai-auth/.well-known/ai-auth.json`
while the convention fetches the origin root. See `docs/DISCOVERY.md`.

## 15. Copy review checklist

Before handing off a draft, confirm each item.

- [ ] The right authoritative context file was read first.
- [ ] The product is described as a self-custodied identity and SDK, not an account or service.
- [ ] No server holding keys, token, blockchain, password reset, or hosted agent process is implied.
- [ ] Every feature named exists in this checkout and matches the current version.
- [ ] No testimonial, adoption metric, endorsement, benchmark, or customer research was invented.
- [ ] No competitor is named or compared without user-supplied evidence.
- [ ] Established names, taglines, and the ® header treatment are preserved; any proposed change is labeled as a proposal.
- [ ] Each section carries one idea and opens with the point.
- [ ] Benefits are tied to features with a file reference in the research notes.
- [ ] Capabilities and states use the plain titles from `packages/p2p/copy.js`.
- [ ] Errors and warnings name a concrete next step; see `tests/actionable-error-copy.test.mjs`.
- [ ] Limits are stated where they affect the reader: no TURN, no automatic reconnect, no password reset, private mode is not anonymity.
- [ ] Signature is never described as a human identity.
- [ ] Dated harness notes are labeled and paired with `ai_auth_status` verification.
- [ ] CTAs match real actions: Connect a site, Get the SDK, Open wallet, Run an agent, Resume. No signup or sales CTA.
- [ ] Pricing claims say MIT and free, with no invented plans.
- [ ] Headings use sentence case; no hype adjectives; no unnecessary em dashes.
- [ ] Claims that cannot be sourced were removed or marked as hypotheses.

## 16. Related skills

Use these alongside this skill. Do not duplicate their work.

- **humanizer** (`.agents/skills/humanizer/SKILL.md`) — installed here. Run it on
  a draft after fact checking to remove AI writing tells. It preserves meaning
  and does not validate claims.
- **ai-auth-connect** (`.agents/skills/ai-auth-connect/SKILL.md`) — installed
  here. It owns the user flow "connect to this site using ai auth". Link to it
  rather than rewriting connection instructions in marketing copy.
- **copy-editing, page-cro, email-sequence, and SEO skills** — use them when they
  are installed for line editing, conversion structure, nurture sequences, and
  search intent. This file stays the authority on AI Auth facts and voice.
- **General marketing skills such as `coreyhaines31/marketingskills`** — if
  already installed, use them for generic campaign frameworks and keep this
  skill as the project-specific layer. Do not download new dependencies or copy
  an entire external skill into this repository.

Conflict rule: when a general skill's advice disagrees with this file, keep this
file's product truth and brand decisions, and note the disagreement.
