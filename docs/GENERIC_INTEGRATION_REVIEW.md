# AI Auth generic integration review and browser evidence

Review scope: the AI Auth browser SDK, its existing browser E2E harness, CI workflow and public documentation; plus the consumer boundary represented by an external website built on the wallet. This document is a **traceability and review record**, not a claim that all runtime/harness combinations or every public document has been exercised.

## Architectural separation

- **AI Auth** owns wallet identity, signed consent, permissions, room transport, peer presence, messaging, and generic WebMCP tool advertisement/invocation. It does **not** contain a product catalog.
- **An agent harness** owns the process that keeps a headless agent connection alive. An identity or a non-expiring grant alone is not a running connection.
- **The website** owns the implementation and authorization of the actions it exposes. A page-hosted tool is unavailable if its page is gone; this is not a failure of the remaining agent's identity or P2P presence.
- **An example consumer** bundles `@enzovezzaro/ai-auth-wallet@0.6.2` from its own entry file and registers site-specific tools through page actions. The catalog stays with that website.

The independent page built in `scripts/test-browser-e2e.mjs` is separate from that example consumer. Its arbitrary tools `demo.echo` and `demo.increment` demonstrate that the SDK transports tools whose names, schemas and behavior come entirely from a website.

## Feature → implementation → actual test

| Feature                                      | Implementation and owner                                                    | Verification path                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet creation and origin-bound consent     | AI Auth wallet/modal and session code                                       | `scripts/test-browser-e2e.mjs`: two isolated wallet approvals                                                                                                  |
| Direct agent/site room communication         | `packages/p2p/p2p.js`, wallet room transport                                | Playwright browser E2E: signed events, agent discovery and data-channel communication                                                                          |
| Generic tool advertisement                   | `packages/p2p/webmcp.js`, **site-provided** action definitions              | The separate agent sees `page.review`, `demo.echo` and `demo.increment` in the site's catalog                                                                  |
| Tool authorization and execution             | `mountAIAuthInPageAgent`; **site-provided** approval callback and executors | Separate agent calls `demo.echo` once and `demo.increment` twice; asserted results require browser approval                                                    |
| Cursor and visible signed-event log          | AI Auth room events and browser fixture                                     | Browser E2E asserts agent cursor and human cursor, and screenshots the receiving page after assertions                                                         |
| Screenshot evidence                          | Playwright `page.screenshot()`                                              | `test-results/screenshots/generic-site-verified-events.png` and `generic-agent-client-connected.png`; GitHub Actions artifact `ai-auth-playwright-screenshots` |
| Failure evidence                             | Browser E2E error handler                                                   | Attempts `test-results/screenshots/generic-site-failure.png`; original failure is re-thrown                                                                    |
| Headless runtime, human departure/return     | `packages/agent` + separate consumer tests                                  | **Not covered by this screenshot test**; see the dedicated multi-agent E2E and example-site keep-alive test                                                    |
| Production consumer deployment               | external website, not the AI Auth SDK                                       | **Not established by this PR**; requires a separate production deployment/review                                                                               |
| ChatGPT/Codex/Claude Code/OpenCode lifecycle | Host harness/MCP and optional AI Auth adapters                              | **Not fully established by browser E2E**; runtime may suspend or stop independently                                                                            |

## Reproduce the evidence

With Node.js 22+, Chromium/Playwright dependencies and a network allowing public Nostr signaling and direct ICE:

```sh
npm ci
npm run build
npx playwright install --with-deps --only-shell chromium
npm run test:browser:e2e
```

After the browser test passes, inspect the PNG files in `test-results/screenshots/`. On pull requests, GitHub Actions runs `npm run test:e2e` and uploads the screenshots as a workflow artifact, even if the run fails after a screenshot can be captured. **A screenshot is UI evidence, not proof of peer delivery by itself**; the assertions and logs are required.

## Observed documentation corrections in this PR

- The root README package version table was behind the checked-in package manifests. It is aligned to wallet 0.6.2, agent 0.1.3 and MCP 0.3.2.
- The generic connect-instruction example used a real site's name and address, making the public SDK look site-specific. It now uses an intentionally fictitious workspace origin.
- Browser and headless identity storage are described separately.
- The security documentation must distinguish _private presence_ from _not joining the room_; they are not equivalent.
- `docs/IMPLEMENTATION_PLAN.md` is an older release tracker, not an up-to-date account of the current release or verification evidence.

## Remaining limits and review gate

- No TURN is configured; one-machine Chromium tests do not prove communication across all NATs or firewalls.
- A tool served by an absent browser page cannot be invoked just because a headless agent remains connected.
- A valid wallet and signed identity do not establish that an idle ChatGPT conversation is still executing or that its MCP transport remains alive.
- Browser screenshots show actual browser rendering, not the state of a production deployment.
- Existing example-site scripts use Ego Lite for visual/agent-flow checks, but those tests depend on the Ego Lite runner and are outside this AI Auth repository's GitHub CI.
- No merge into `main` should occur until the PR workflow is green and the screenshot artifact has been inspected. Production deployment must be verified separately after a later authorized merge.
