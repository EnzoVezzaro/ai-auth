# AI Auth — Agent identity onboarding, proof and UX audit

**Status:** Implementation handoff, code-reviewed proposal. **Date:** 2026-11-20.  
**Scope:** AI Auth itself: landing → Connect an Agent → agent runtime/MCP setup → wallet consent → identity proof → live verification → owner wallet/status/recovery. No Body4AI product features.  
**Baseline:** `main` tree `3bf919bab4f6807740500304f176392cd9b6118f`; inspected source and tests, not an interactive production browser session. Claims below distinguish confirmed code observations from acceptance tests still required.

## Executive decision

**Rebuild the experience around one job: attach an existing or newly generated agent identity to an agent, verify that the running agent controls that identity, and clearly show whether it is live and authorized for the intended site.**

Today the system has multiple sophisticated parts (signed keys, encrypted backups, instance bindings, descriptors, owner consent, live transport states and scoped tools), but the user is asked to assemble them manually. Worse, parts of the UI can declare success for an unrelated peer, confuse a grant with a connection, or display requested scopes as approved scopes.

Target default user experience:

1. **Choose an agent** — detect a supported local harness when permitted; otherwise select it from a short list or use a generic manual path.
2. **Connect identity** — reuse a local identity if present; otherwise generate and securely install one via an authorized local adapter. Explicitly ask permission before creating, replacing, exporting or linking any key. Allow recovery backup without requiring a manual JSON exchange in the happy path.
3. **Verify and connect** — issue a fresh challenge, have the target agent sign it from the installed key, verify exact identity/instance/session/origin/room, request scoped consent for the site, then establish a live authenticated transport. Show the distinction between identity verified and agent online.

**Never collapse `identity created`, `identity installed`, `key possession proved`, `session authorized` and `connected` into one checkmark.**

The default screen needs one primary CTA and a status card. Move all protocol, relay, capability-internal, DID, JSON, key-file and MCP configuration details behind an explicitly named **Advanced / Troubleshooting** area.

## Sources reviewed

- `index.html`, `landing.css`, `apps/connect-agent/index.html`, `apps/connect-agent/app.js`, `apps/connect-agent/style.css`.
- `apps/p2p/index.html`, `apps/p2p/app.js`, `packages/p2p/wallet-setup-copy.js`, `packages/p2p/agent-connect.js`, `packages/p2p/agent-identity.js`, `packages/p2p/connection-state.js`, `packages/p2p/session.js`, `packages/p2p/discovery.js`.
- `packages/agent/install.js`, `packages/mcp/connect-input.js`, `packages/mcp/cli.js`, `packages/mcp/cli-args.js`, `packages/mcp/approval.js`.
- `scripts/build-p2p-static.mjs`, `scripts/test-connect-agent-page.mjs`, `tests/agent-identity.test.mjs` and existing lifecycle, quickstart, agents, discovery and E2E acceptance documentation.
- Prior architectural RFCs and the existing generic agent acceptance plan should be preserved; this audit is an experience and proof-of-possession handoff, **not** a new identity protocol.

**Evidence constraint:** Source review is not proof a deployed site currently behaves identically. The Director must reproduce each high-priority claim with browser tests and screenshots before shipping. The production GitHub Pages UI was not visually verified in a live browser during this audit.

## Findings: severity, precise evidence and required correction

### P0-01 — An unrelated peer can make onboarding say "Connected"

**Evidence:** `apps/connect-agent/app.js` subscribes to transport connection state and calls `setPhase("connected")` on any `direct-peer-connected`. Separately, receipt of any inbound `peer/hello` or `presence/heartbeat` with issuer different from the page's local wallet overwrites `state.id` and `state.name`, then calls `setPhase("connected")`. Neither path requires matching the identity created in the current setup flow, a fresh one-use installation challenge, nor an expected instance id. The listener is installed before the user submits the identity form.

**Impact:** The green success state does not prove the specifically requested agent has received or controls its newly generated identity. It may be triggered by another peer in the same public room.

**Fix:** Maintain an immutable `expectedWalletId` + `expectedInstanceId` for each pairing attempt, bind them to a fresh challenge and intended site context. Require a verified agent-signed response from that key and a live authenticated peer matching it. Ignore unrelated peer arrivals, including before setup. Display unrelated peers only in advanced diagnostics.

**Acceptance:** Peer B arriving before, during or after a pairing with peer A **never** completes pairing A; mismatched wallet/instance/nonce/origin/room/signature fails closed.

### P0-02 — The UI fabricates "approved capabilities"

**Evidence:** `apps/connect-agent/app.js` renders the hardcoded `CAPABILITIES` array in `#capabilities` when a hello/heartbeat is received, not a verified consent/authorization for that exact agent and site. `scripts/test-connect-agent-page.mjs` currently asserts precisely three chips, entrenching this presentation.

**Fix:** Render granted scopes from verified, active authorization bound to the expected session, not the defaults or requested set. Before approval say **"Permissions requested"** or **"Not yet authorized"**; after approval say **"Approved for this site"** and identify the approving key/context. If scopes cannot be determined, render **"Permissions not verified"**, never all requested scopes.

**Acceptance:** Approve a strict subset of scopes; the UI lists exactly that subset. Reject, revoke or expire the grant; UI and tool access change accordingly.

### P0-03 — "Connected" remains green after a disconnect in the onboarding view

**Evidence:** The onboarding page only reacts to positive `direct-peer-connected` snapshots and to inbound hello/heartbeat. It does not use subsequent lifecycle snapshots to move to waiting, reconnecting, degraded, revoked or disconnected. The disconnect button only closes the locally held transport. Meanwhile the SDK already has a typed lifecycle in `packages/p2p/connection-state.js`.

**Fix:** Derive the UI from a single verified session/connection state and subscribe to both positive and negative transitions. Reset connected immediately upon transport loss, scope expiry or revocation; preserve identity verification and installation as separate historical facts.

**Acceptance:** Terminate target process, close data channel, expire authorization or revoke it; "Online" disappears promptly. Reconnect requires reauthentication and only returns online for the expected peer.

### P0-04 — The promoted copy/paste command cannot reliably bootstrap the promised identity

**Evidence:** `apps/connect-agent/index.html` first makes the user download two files and run `installAgentIdentity` with the agent SDK. Its "ONE PASTE FOR YOUR AGENT" command, however, calls `ai-auth-mcp serve --http 0 --connect "<page URL>" --open-wallet --auto-join` without passing the generated install package or its keystore path. `packages/mcp/cli.js` runs `keystore.unlock()` before serving; the CLI does not provision the newly generated browser identity from this command. `packages/mcp/cli-args.js` has a separate `init` action. Both pathways can be valid independently, but the UI incorrectly presents them as one continuous workflow.

**Fix:** Choose one canonical, tested path per supported harness. First detect/reuse an installed keystore, then explicitly initialize or import identity if needed, and only then launch the MCP bridge. If automated local install is unavailable, show a clearly scoped manual alternative (one copyable installer command plus the minimum necessary human action) and do not assert one-click success.

**Acceptance:** On a clean device, a supported harness completes without a hidden prerequisite `init`. On an existing keystore, no replacement or identity duplication happens without approval. On unsupported harnesses, the UI admits the limitation.

### P0-05 — Site URL discovery is inconsistent with GitHub Pages subpath hosting

**Evidence:** `apps/connect-agent/app.js` generates a `--connect` URL under `/ai-auth/connect-agent/?room=...`. `parseConnectInput` in `packages/mcp/connect-input.js` reduces a URL to its origin and discards the page path/query; `fetchSiteManifest` then calls `fetchDiscovery` with that exact origin. `scripts/build-p2p-static.mjs` publishes the manifest inside the GitHub Pages `/ai-auth/` project subpath. `docs/DISCOVERY.md` explicitly acknowledges the origin-root `/.well-known/ai-auth.json` problem. A copied text instruction with explicit origin/room/scopes is different and should remain usable.

**Fix:** Do not use the onboarding page URL as a magic pairing token. Prioritize a schema-versioned, public connect descriptor containing the exact origin, room, site wallet URL and requested scopes; parse it as data. Make project-subpath discovery explicit and safe instead of guessing from arbitrary URLs. Preserve exact-origin validation, redirects disabled and no credentials. Add a deployed Pages path fixture.

**Acceptance:** The displayed primary action works from a clean environment on GitHub Pages and on a root-domain site. If only a URL is provided and discovery is absent, show an honest recoverable error rather than claiming it is sufficient.

### P0-06 — Proof of installed identity is not the same as issuing an install package

**Evidence:** `packages/agent/install.js` checks the signed instance binding and imports the encrypted backup, which is useful local installation verification. `packages/p2p/agent-identity.js` already implements signed agent descriptors, verifier-supplied expected origin/room/nonce and instance IDs. The onboarding page does not invoke that verifier and does not correlate a challenge response to the newly installed identity before declaring success.

**Fix:** Reuse existing identity primitives for a challenge-response pairing proof. Verify key possession by the running process, expected wallet id, expected instance id, fresh single-use nonce, exact origin and room, signing key/alg and timestamp. The challenge must be created by the verifier and consumed once. Only then label **"Identity verified on this connection"**.

**Truthfulness:** Cryptographic key possession proves control of the key in the responding process; it does **not** independently attest the machine, model name, vendor, physical device or absence of key cloning. Runtime/provider/model claims stay explicitly **self-reported** unless backed by a separately reviewed attestation mechanism. Do not claim hardware attestation.

**Acceptance:** Replay, copied descriptor, wrong-key response, cloned instance, mismatched origin/room and identity swap do not pass. A successful local install alone does not mark a remote connection verified.

### P1-07 — Five separate mental models before the first success

**Evidence:** Landing `index.html` has both "Open wallet" and "Connect an agent"; `apps/p2p/index.html` has six sidebar destinations (Overview, Owner identity, Site requests, Grants, Shared room, Activity); `apps/connect-agent/index.html` has Create/Backup/Install/Connected, code blocks, config, link and instruction. The wallet's owner identity is different from the agent's own identity, but naming and navigation mix them.

**Fix:** Present one main `Agents` destination with an empty-state CTA: **Connect an agent**. The owner wallet is a contextual approval surface, not a prerequisite dashboard. A compact agent detail view should answer identity, verification and connectivity. Place diagnostics and administrative grant editing under Advanced.

**Acceptance:** A first-time visitor can identify the correct CTA without visiting the wallet console. The wallet and connect page never ambiguously describe the same key as both owner and agent.

### P1-08 — A two-file recovery ritual is the default, not a fallback

**Evidence:** `apps/connect-agent/app.js` forces two separate browser downloads for one encrypted backup (the standalone recovery file and an installation package containing the backup), followed by copying a file into an agent repo and writing code. The passphrase must be handled by the user again.

**Fix:** On supported local companions, install securely through an approved local channel and offer one encrypted backup export (plus explicit backup-confirmation feedback). Avoid copying key material into a shareable site link. On manual flow, tell the user exactly which files contain encrypted secret material and where to store/delete them. Never auto-upload backups to external servers.

**Acceptance:** Happy path does not require opening JSON or moving key files manually. Backup export can be skipped only if explicit durable recovery choices and risk wording are provided; deletion/replacement never occurs silently.

### P1-09 — The page calls a navigation URL a "connect link"

**Evidence:** The readonly `#site-link` is the public onboarding page itself; `#instruction` contains origin/room/capability hints. Neither is a one-time signed pairing grant or a verified identity link.

**Fix:** Rename according to actual function: **"Open setup"**, **"Copy site connection details"**, or **"Connect this agent to [site]"** only when a real pairing descriptor is present. Keep private bearer MCP URLs and recovery material out of shared links.

**Acceptance:** A user can explain whether they copied a public instruction, a private local endpoint or an authorization proof. No copy CTA conflates those three.

### P1-10 — Wallet dashboard equates active grants with live sites

**Evidence:** `walletView()` in `apps/p2p/app.js` iterates stored grants and labels every card `ACTIVE`, calls their count "connected sites", and renders `grant.audience` and `grant.room`. A grant can outlive a real transport connection, and may be expired/revoked by the time the view is shown. `docs/lifecycle.md` expressly separates identity, session and connection.

**Fix:** Separate **"Authorized"** (validated, unexpired stored grant) from **"Online"** (authenticated live peer). Offer **"Not connected"**, **"Expired"**, **"Revoked"**, **"Unknown"** as appropriate. Use actual verification instead of cached grants or local DOM labels as live proof.

**Acceptance:** A granted site with no active transport is not displayed as online. Expiry/revocation changes status with no misleading green state.

### P1-11 — Manual authorization editor is too prominent and hard to understand

**Evidence:** The wallet's `permissionsView()` asks for an agent ID, arbitrary resource, comma-separated scopes and expiry hours; the UI itself says "Cancelling a grant is not supported yet". This is a developer/admin operation but currently top-level navigation.

**Fix:** For normal users expose **Review access**, **Change permissions** and **Disconnect/Revoke** on each agent/site relationship, with explicit effects and confirmation. Keep raw grant creation and resource expressions in Advanced until supported by a reversible end-to-end capability flow. Do not offer a fake "Revoke" action that only hides a row; wire it to real signed revocation and any site-specific policy.

**Acceptance:** Users can see who is authorized to do what, for which site and until when; when revocation propagation is incomplete, state that accurately. Every destructive action is confirmed.

### P1-12 — Success feedback is not actionable or verifiable

**Evidence:** The connected card shows a name, id, fixed chips and recent messages. No proof summary shows challenge verification, installed instance, site authorization, transport peer identity, age of result or last verification time.

**Fix:** One proof card with separate rows: **Agent identity: verified**, **Runtime key possession: verified**, **Site access: approved/not approved**, **Connection: online/offline**, with a concise timestamp and "View proof" advanced disclosure. Add a safe **Test connection** that performs a signed ping/challenge (not an arbitrary site tool with side effects), reports failure reasons and never broadens scopes.

**Acceptance:** Test connection fails if another peer is online but the target is not; browser refresh does not falsely keep an "Online" badge.

### P1-13 — Cross-harness capability must not be overpromised

**Evidence:** The repo differentiates MCP stdio, local HTTP, headless runtime and per-harness manual notes. `docs/agents.md` reports a successful Claude Code tool call but unverified past Codex/OpenCode tool calls; it also separates desktop apps from web apps. A static GitHub Pages page cannot install a local process by itself.

**Fix:** Create an adapter capability registry driven by tested support: automatic local install, skills, MCP stdio, MCP HTTP, manual setup, unsupported. UI chooses a known-supported path, asks for local permission, otherwise provides short copyable steps. Verification is mandatory whatever the adapter.

**Acceptance:** No "automatic install" unless a local trusted component actually performs and confirms it. Per-harness matrix includes OS/client/version/date/transport/result/evidence, and explicitly distinguishes desktop from browser.

### P1-14 — Error/recovery states are absent from the core flow

**Evidence:** `apps/connect-agent/app.js` has phases `setup`, `install`, `connected`, `disconnected`. The underlying state machine has approval pending, signaling, waiting, reconnecting, degraded, expired and revoked. There is no targeted diagnosis for unsupported harness, missing keystore, browser consent, NAT or offline page.

**Fix:** Map internal codes to user-safe states and a next action: "Approve in wallet", "Finish setup on this device", "Waiting for agent", "Agent offline", "Direct connection blocked", "Authorization expired", "Re-approve", "Try again". Raw WebRTC/relay diagnostics remain advanced. Never interpret stale presence as online.

**Acceptance:** Each failure path has a specific fix or truthful limitation; a retry cannot duplicate identities or widen grants.

### P1-15 — A default "Never" session is a risky first-use choice

**Evidence:** `apps/p2p/app.js` `defaultSessionTtl()` picks `null` ("Never") when the requesting site allows unlimited duration, and the external permission form exposes that choice. This is implemented policy, not a bug in signature verification.

**Fix:** Director + security reviewer decide if first-use consent should default to a bounded duration while retaining an explicit "Until I disconnect" option when policy allows it. Do not silently change semantics, compatibility or saved grants. Show privacy mode and persistence clearly.

**Acceptance:** First-time users know duration and can deny/narrow scopes; renewed grants never increase scopes without fresh consent.

### P2-16 — Marketing, wallet and package versions conflict

**Evidence:** `index.html` advertises `v0.11.0`, `apps/p2p/index.html` footer says `AI Auth Wallet v0.2.0` and root `package.json` is `0.12.0`. `README.md` also lists runtime package version `0.1.0` while `docs/agents.md` lists `0.1.1`.

**Fix:** Generate version metadata from a single release source at build time, or omit version from nontechnical UI. Show precise independent package versions only on an About/Developer screen.

**Acceptance:** Landing, wallet, published metadata and npm docs do not imply mismatched product versions.

### P2-17 — Developer examples leak into normal owner screens

**Evidence:** `connectView()` in the owner console includes an editable website origin, explicit challenge form and a JSON dump of signed consent; `walletView()` and `activityView()` expose algorithm labels, raw signatures, IDs and event payloads.

**Fix:** Keep production user flows contextual and task based. Put protocol playground and raw verifier examples into a clearly marked Developer Lab, not a primary owner action. Default to human-friendly labels and masked IDs, with copy/reveal controls.

**Acceptance:** Normal onboarding never displays raw JSON, public key material, protocol versions, room hashes or internal event types unless the user expands diagnostics.

### P2-18 — Mobile/accessibility need proof, not only responsive CSS

**Evidence:** CSS contains responsive and 44px tap-target rules and the wallet uses status-live regions, but onboarding uses small monospace text, long preformatted commands, asynchronous downloads and separate copy buttons. No current screenshot-based or assistive-technology validation of the new complete journey was verified in this audit.

**Fix:** Test keyboard-only focus, screen reader status announcements, visible errors tied to fields, one primary action, compact mobile status/proof card, robust code wrap/scroll in Advanced and reduced-motion layouts. No color-only distinction; do not move focus unexpectedly during status changes.

**Acceptance:** Full path at 320px width, keyboard-only, screen reader smoke test, desktop, reduced motion and no-WebGL fallback.

## Product model: what exactly is being proven?

Use five independent concepts, never one overloaded `connected` boolean:

- **Identity** — persistent public agent wallet ID; agent controls a key. Creating a key alone proves nothing about a remote process.
- **Installation / instance** — intended runtime instance ID and locally verified install receipt. Local import signature validates the package; a remote verifier still needs a fresh proof.
- **Proof of possession** — response to verifier-issued nonce signed by the active instance key, with exact expected wallet ID, instance ID, origin, room, request/session context, expiry and anti-replay.
- **Authorization** — explicit owner-approved capabilities for a specific site/session with duration, refusal, narrowing and revocation. Approval is not transport liveness.
- **Connection** — an authenticated live peer WebRTC data channel for the expected identity and current generation. MCP server reachability, discovery and room membership alone are insufficient.

The UI may say **"Identity verified"** after the cryptographic challenge, even if the peer then disconnects. It may only say **"Connected now"** while the correctly identified peer and authorization are live. Browser page-to-agent and agent-to-site sessions must not be conflated.

### Trust/claim levels

1. `Public claim`: name, provider, model, runtime type — self-reported.
2. `Key verified`: valid signature over current verifier challenge by expected key.
3. `Instance matched`: expected instance binding and challenge context match.
4. `Authorized`: signed site grant valid for current origin, room, scopes and lifetime.
5. `Online`: authenticated data channel for that identity is open now.

No level here proves that a vendor's model software or a particular physical machine is genuine. A separately scoped hardware/runtime attestation may be considered later.

## Proposed information architecture

**Public landing**

- Primary: **Connect an agent**.
- Secondary: **How AI Auth works** and **For developers**.
- "Open owner wallet" moves to access management / existing-user secondary navigation.
- One sentence: "Give an AI agent a portable identity. Verify it controls that identity. Choose what each site can access."

**Agents home** (empty and populated)

- Empty state: "No agents connected" / "Connect your first agent".
- Populated: a simple list of agent name, short verified ID, identity status, online status, latest verification and site permissions. One CTA: **Connect another agent**.
- Agent detail: **Identity**, **Where it's connected**, **Access**, **Recovery**, **Advanced**. Contextual safe actions: Verify again, Connect to a site, Disconnect, Revoke access.

**Owner approval sheet**

- Displays site name and exact origin, agent name/short ID if verified, requested actions in human language, optional advanced scopes, duration, privacy/disclosure, Allow/Decline.
- Does not make users visit a full dashboard to approve the active request.
- Never labels an unsupported or unauthenticated agent as "verified".

**Advanced (collapsed by default)**

- Public DID and instance ID, full signed challenge/proof and verification timestamp, room/origin, SDK version, MCP transport setup, backup export, relay/ICE diagnostics, raw grants, event logs and protocol playground.

## Default flow: low-friction but security truthful

`START → Choose agent → Reuse or create identity → Approve local setup → Agent signs fresh challenge → Verify identity/instance → Approve site access if required → Establish authenticated peer → Confirm online / run safe verification ping → DONE`.

**Fast path (trusted installed local integration):**

- Detect supported agent/harness **only through an authorized local adapter** (no browser scanning or secret scraping).
- If identity exists, display truncated public ID and let user reuse it. If none, offer Generate identity; install securely in agent-local encrypted keystore and show recovery options.
- The application sends a one-time pairing challenge through the trusted local channel. Agent signs using the installed identity, never exports the private key.
- User approves requested site capabilities. UI shows verified proof and current online state separately.
- Future connections reuse identity; site authorization stays scoped and may need fresh consent.

**Manual fallback (plain browser / unsupported harness):**

- Display one tested command/config for the selected harness, not every possible transport at once. Explicitly state prerequisites.
- Installation can require a local terminal or a manual package transfer; this cannot be magically automated by a static website.
- Provide a deterministic "Verify my agent" flow and remediation when the target process is absent.
- Existing identities must be imported/linked rather than silently replaced.

**Separation of responsibilities:** AI Auth provides identity proof, consent, scoped authority and connection semantics. The site owns application permissions/data. The agent adapter owns local installation. Do not add a mandatory AI Auth-hosted server, blockchain, custody service or opaque magic link.

## Text-first wireframes

### Empty state

> **Connect an AI agent**  
> Give your agent an identity you control and verify it is really using it.  
> [Connect an agent]  
> Existing identity? [Use my current identity]  
> Small link: How it works

### Selected agent setup

> **Connect Claude Code** _(example; only if supported and tested)_  
> Identity: [Reuse existing] [Create new]  
> Local setup: Needs approval on this device  
> [Continue]  
> Advanced: Manual setup, recovery, technical details

### Pairing

> **Verify this agent**  
> Identity installed ✓  
> Waiting for signed proof…  
> [Try again] [Cancel]  
> Advanced: challenge and transport details

### Verified, offline

> **Research agent**  
> Identity verified ✓ · Agent offline  
> Last verified: [time]  
> [Reconnect] [View access]  
> Do not show a global green "Connected".

### Verified and online

> **Research agent**  
> Identity verified ✓ · Connected now ✓  
> On: [site] · Allowed: [human-friendly capability summary]  
> [Test connection] [Manage access] [Disconnect]  
> Advanced: exact proof, instance, grant and transport

### Approval

> **Allow Research agent on example.com?**  
> It can: [read presence] [send messages] [request tools]  
> Duration: [short time] [longer] [until I disconnect, if allowed]  
> [Allow] [Not now]  
> Technical scopes hidden until expanded

## System API recommendation (reuse, do not fork protocols)

Introduce a thin application-facing **pairing coordinator** rather than creating another cryptography stack. Its externally observable snapshot should have typed, independent fields:

- `identity`: expected wallet ID; self-asserted name; existence/installation receipt.
- `pairing`: expected instance id, challenge id/nonce and TTL, nonce consumed flag, proof verification result and timestamp.
- `authorization`: exact site origin, room, effective scopes, approver/issuer reference, expiry, revoked/unknown.
- `transport`: lifecycle status, authenticated peer ID, generation, last seen and safe diagnostic category.
- `ui`: derived title, next step, retryability, human message and available actions.

Read-only snapshot for views; mutations through named commands `startPairing`, `approveInstall`, `verifyProof`, `approveAccess`, `connect`, `disconnect`, `revoke`, `retry`. All commands use explicit permission checks and idempotency guards. Existing `verifyAgentDescriptor`, `verifyInstanceBinding` and connection state machinery remain canonical; verify origin/room/nonce/identity/instance/generation before approving a UI transition.

Do not put private material, passphrases, callback bearer secrets or signed permissions in the clipboard by default. Any public pairing descriptor has an expiry, exact origin and single use where it acts as a pairing token; public site discovery hints are never authorization.

## Director implementation workstreams

**Workstream A — Security and state correctness (mandatory first, P0):**

- Fix the unrelated-peer false positive, hardcoded approved scopes and stale green status.
- Implement expected-identity/instance correlation and fresh signed challenge-response verification using existing primitives; define privacy boundary and audit messages.
- Fix clean-install bootstrap and Github Pages connect-input/discovery parity, with strict origin handling and explicit fallback.
- Add regression tests **before** shipping a visual redesign; no bypasses, auto-approvals or fake responses.

**Workstream B — One-flow product UX (P1):**

- Replace overloaded screen with unified Agents onboarding / detail / approval and consistent labels.
- Clear distinction between public instruction, private local MCP endpoint, wallet approval, key backup and actual pairing.
- Contextual owner wallet, simple advanced accordion, secure recovery, working disconnect/revoke actions.
- Error-action mapping and no misleading online/authorized badges.

**Workstream C — Adapters and automation (P1):**

- Capability-check supported local coding harnesses and build one valid fast path each.
- Explicitly bound local adapter responsibilities; never silently install, modify keystores or request broader scopes.
- Graceful manual setup for browser-only/unsupported clients; maintain per-harness compatibility evidence.

**Workstream D — Visual polish and documentation (P2):**

- Align landing, connected card, wallet approval and agent list around one design system, mobile and accessibility.
- Centralize version strings and copy, update quickstart and owner/agent glossary.
- Preserve low-level developer access under Advanced; keep product-neutral demos and current tests.

## Required tests, not optional polish

**Identity correctness and adversarial pairing:**

- Any peer before identity creation does not complete pairing.
- Peer B online while target A offline does not mark A online.
- Wrong key, instance, room, origin, nonce, signature, expired proof, stale generation or replay is rejected.
- A locally imported backup without a live signed response is **installed**, not **online**.
- A valid descriptor's provider/runtime/model claims are labeled as self-asserted.
- Two concurrently running processes with duplicated key material receive explicit clone warning where detectable; do not claim perfect clone prevention.

**Authorization vs liveness:**

- Requested scope is not the granted scope; approved subset only.
- Deny and cancel perform no side effects; expired/revoked grant removes access.
- A valid grant with no direct peer displays "Authorized, offline", not "Connected".
- Transport close, ICE failure, reconnect, HTTP endpoint alive with no site peer and browser tab close show distinct truthful states.
- A signed ping/proof check cannot invoke destructive tools or silently widen permissions.

**Bootstrapping and interoperability:**

- Clean harness with no keystore; pre-existing keystore; wrong passphrase; corrupted keystore; interrupted setup; no local adapter; double-click/double-submit.
- GitHub Pages `/ai-auth/` + root-domain discovery; explicit descriptor, instruction text and URL-only inputs.
- Each advertised agent harness completes installation, key possession, consent, authenticated peer and status; unsupported listed separately.
- Manual fallback is reproducible without undocumented init/port/config steps. Never paste private local MCP endpoint into public site content.

**UX and accessibility:**

- First-time visitor can reach pairing from landing with only one obvious CTA.
- Screenshot tests: no-agent, installing, proof pending, verified/offline, authorized/online, rejected, expired, disconnected, revoke, unsupported.
- Test at desktop, 320px mobile, keyboard, screen reader (status announcements), reduced motion and no-WebGL.
- Confirm no secret appears in publicly copied text, logs, screenshots, URLs or test fixtures.
- Test recovery backup export/restoration, duplicate safe setup, and explicit destructive action confirmation.

## Definition of done / release gate

- **Correctness gate:** P0-01 through P0-06 automated negative and positive regression tests pass. No state labeled online without authenticated live connection to **the expected key**; no scope shown approved without valid grant.
- **User goal gate:** A supported harness can be connected, cryptographically verified and shown online through one understandable guided flow. A browser-only user sees honest setup requirements and still gets a proof step.
- **Evidence gate:** Fresh automated E2E screenshots plus one real local harness test; report OS, version, date, status and limitations for other harnesses. No invented screenshot or connectivity result.
- **Security gate:** Explicit approval, no private key leakage or automatic key replacement, origin/room binding, time limits, anti-replay, signed revocation semantics preserved; security reviewer signs off.
- **Accessibility gate:** Mobile and keyboard/screen reader walkthrough passes. Critical status never relies on color alone.
- **Architecture gate:** No central key service, no platform-specific product coupling, no unnecessary new protocol; existing MCP/WebMCP/UTCP and collaboration remain independent.
- **Documentation gate:** README, quickstart, landing copy, wallet wording, SDK/API docs and version labels match actual supported flows.

## Implementation instructions to the Director

Read `.agents/AI_AUTH_IDENTITY_UX_DIRECTOR.md`, use this report as the source-of-truth backlog and create scoped implementation PRs in dependency order. First reproduce P0 issues with executable tests. Before adding or changing any cryptographic surface, consult the existing identity and interoperability RFCs, implementation of signed descriptors, session/connection-state contracts, and current E2E acceptance document. Only mark a finding completed with a code diff, passing tests and evidence. **This review PR itself is documentation; it does not fix any runtime behavior.**
