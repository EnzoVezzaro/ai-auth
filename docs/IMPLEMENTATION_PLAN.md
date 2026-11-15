# AI Auth 2.0 implementation tracker

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

| Step | Deliverable                                                                               | Status                                | Evidence / remaining work                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Wallet identity, encrypted backup, signed consent and capability grants                   | Implemented                           | Unit tests cover signing, consent, expiry, replay and recovery.                                                                                                                      |
| 2    | Shared-page SDK with exact-origin popup, explicit scopes, action and cursor bridge        | Implemented, local browser E2E passed | Two isolated Chrome contexts joined the same origin's default public space, approved scoped consent, and delivered signed action and cursor events at `/ai-auth/`.                   |
| 3    | Automatic discovery and direct signed collaboration                                       | Implemented, network-limited          | Trystero 0.27 uses Nostr relays for discovery/signaling and direct WebRTC for event data, with TURN disabled. Local Chrome and delegated Ego Lite↔Chrome checks passed.              |
| 4    | WebMCP in-page tools, wallet scope filtering and signed lifecycle events with JS fallback | Implemented                           | Native Ego Lite `registerTool/getTools/executeTool` passed; a separate Chrome peer received signed `started`/`completed` events. Unit tests cover forgery, scopes, expiry and close. |
| 5    | Optional local MCP and runtime adapters                                                   | Implemented                           | Both adapters run with host-supplied local wallet and services; tests pass and packed package exports resolve. These packages are not required by the website.                       |
| 6    | Remove hosted server products and Vercel/Cloudflare release configuration                 | Implemented on migration branch       | Worker, hosted service SDK and Vercel configs are removed; CI and docs now target static Pages and local adapters.                                                                   |
| 7    | Static wallet, browser SDK and docs under a GitHub Pages project path                     | Built and locally verified            | Build emits relative paths; browser E2E passed at `/ai-auth/`. GitHub Pages must still be enabled and deployed after merge.                                                          |
| 8    | Independent code review and complete verification                                         | In progress                           | Unit suites, package export checks, formatting, build and npm audits pass. Independent review and final release checks remain.                                                       |
| 9    | Merge the aligned product to `main`, publish npm release and verify GitHub Pages          | Not started                           | Do after the transport and review gates pass.                                                                                                                                        |

## Verification boundary

The browser E2E proves two isolated wallet identities can approve scoped consent, discover each other in the same origin's default space through Nostr, and exchange signed action and cursor events over direct WebRTC on the current machine/network. A separate delegated check reports signed bidirectional messages between Ego Lite and Chrome profiles on one local network. These results do not prove cross-network reachability, mobile support, or six-agent scale. No TURN relay is configured or allowed by the product contract.
