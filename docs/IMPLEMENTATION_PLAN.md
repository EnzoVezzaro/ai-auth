# AI Auth historical v0.4.0 implementation tracker

> This is a historical release snapshot. Its version, deployment and test-coverage claims describe the v0.4.0 milestone, **not the current repository state**. See the root package manifests for current versions and [generic integration review](GENERIC_INTEGRATION_REVIEW.md) for the current browser evidence and remaining limits.

## Product contract

- Self-custodied browser wallet; the private key stays in origin-scoped storage.
- A website is the logical collaboration hub; wallet-approved agents on the same exact origin share the `default` space, or a site can supply another stable space key.
- Sites request explicit, short-lived scopes and remain responsible for resource authorization.
- Approved wallet sessions discover peers through public Nostr relays and exchange signed events over direct WebRTC.
- No AI Auth-operated backend, Docker image, Cloudflare Worker, or Vercel deployment is part of the product.
- WebMCP is the primary in-page tool surface. The JavaScript API is the fallback when the browser lacks WebMCP.
- MCP and runtime adapters run with locally supplied wallets, tools, policies, and transports; they do not depend on an AI Auth-hosted service.
- Browser Use may be an optional local adapter later; it is not the discovery or collaboration transport.

## Release checklist

| Step | Deliverable                                                                               | Status                       | Evidence / remaining work                                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Wallet identity, encrypted backup, signed consent and capability grants                   | Implemented                  | Unit tests cover signing, consent, expiry, replay and recovery.                                                                                                                                            |
| 2    | Shared-page SDK with exact-origin wallet modal, explicit scopes, action and cursor bridge | Verified locally             | Chrome E2E covers two consented wallets, a separately connected agent wallet, action, cursor, wheel chat, element sharing, synthetic screenshot/recording, expiry, and modal disconnect.                   |
| 3    | Automatic discovery and direct signed collaboration                                       | Implemented, network-limited | Trystero 0.27 uses Nostr relays for discovery/signaling and direct WebRTC for event data, with TURN disabled. Ego Lite cross-browser and six-participant scale are unverified.                             |
| 4    | WebMCP in-page tools, wallet scope filtering and signed lifecycle events with JS fallback | Verified locally             | Chrome E2E verifies catalog discovery, human approval, a signed remote tool result, and remote cancellation. Unit tests cover wallet/session binding and timeout/close cancellation.                       |
| 5    | Optional local MCP and runtime adapters                                                   | Implemented                  | Both adapters run with host-supplied local wallet and services; tests pass and packed package exports resolve. These packages are not required by the website.                                             |
| 6    | Remove hosted server products and Vercel/Cloudflare release configuration                 | Implemented on main          | Worker, hosted service SDK and Vercel configs are removed; CI and docs target static Pages and local adapters.                                                                                             |
| 7    | Static wallet, browser SDK and docs under a GitHub Pages project path                     | Implemented                  | Build emits relative paths; Pages workflow deploys `dist-p2p` from `main` to <https://enzovezzaro.github.io/ai-auth/>, and the landing page, `/wallet/`, and `/ai-auth.js` return 200.                     |
| 8    | Independent code review and complete verification                                         | Verified locally             | 61 wallet tests, 7 runtime tests, 4 MCP tests, package exports (including the `agent-connect` subpath), formatting, build, npm audits, and Chrome E2E pass in CI; Codex reviewed cancellation and routing. |
| 9    | Merge the aligned product to `main`, publish npm release and verify GitHub Pages          | Done                         | `main` at `190f6fd`; `v0.4.0` release published with the static site archive; `@enzovezzaro/ai-auth-wallet@0.4.0` is npm `latest`; Pages deployed from `main`.                                             |

## Verification boundary

The browser E2E must prove two isolated wallet identities can approve scoped consent, discover each other in the same origin's default space through Nostr, and exchange signed events over direct WebRTC on the current machine/network. The requested live test with two humans and four agents is intentionally deferred until after release. Neither local browser coverage nor one-network tests prove cross-network reachability, mobile support, or six-agent scale. No TURN relay is configured or allowed by the product contract.
