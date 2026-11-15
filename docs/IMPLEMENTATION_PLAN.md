# AI Auth wallet migration plan

> **Scope note:** This document records the first, static wallet MVP and its original acceptance gate. It does not define the current vNext target. The expanded plugin, shared-state service, SDK/MCP, dashboard, observability, security and release requirements are tracked in [VNEXT-ROADMAP.md](VNEXT-ROADMAP.md). Steps below marked complete describe that earlier MVP only; they do not imply vNext completion.

## Direction

AI Auth becomes a static browser wallet with locally held agent keys, explicit signed consent, signed delegation records, and direct peer sessions. No AI Auth API server, database service, Docker container, crypto token, blockchain, or gas layer is part of this design. Static hosting is separate from identity and peer data.

The browser's IndexedDB stores a non-exportable Web Crypto private key. Signed records use ECDSA P-256 / SHA-256 and deterministic JSON based on RFC 8785. Peer signaling is manual SDP copy/paste; WebRTC traffic is peer-to-peer when the network permits. A public STUN service may be used for address discovery and sees connection metadata. No TURN relay is configured.

## Tracked work

| Step | Work                                                                                                   | Status      | Acceptance evidence                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Preserve the previous checkout and active work                                                         | Done        | Local Git stash `pre-wallet-rebuild-checkpoint-2026-11-14`; superseded experiment separately stashed                                                                     |
| 2    | Inspect the existing P2P migration PR and use it as the baseline                                       | Done        | [PR #1](https://github.com/EnzoVezzaro/ai-auth/pull/1), branch `feat/serverless-p2p-wallet`                                                                              |
| 3    | Remove the local API server, MCP service, Docker/Compose, Fly config, and server-specific dependencies | Done        | Server, MCP, server SDK, identity provider and old app source removed; local Fly app destroyed; Docker/Fly configs and server-only dependencies absent                   |
| 4    | Make the wallet SDK a clean, typed npm package                                                         | Done        | Published `@enzovezzaro/ai-auth-wallet@0.1.1`; package has no runtime dependencies and includes the popup request verifier export                                        |
| 5    | Build a responsive browser wallet for identity, permissions, P2P connect and activity                  | In progress | Local browser verified key persistence after reload, signed consent, signed delegation, same-origin signed message; private-mode UI and WebRTC pairing need verification |
| 6    | Document protocol, threat boundaries, key recovery, and migration                                      | Done        | Architecture, security boundaries, wire format, recovery and this implementation tracker document the current protocol and limitations                                   |
| 7    | Verify build, tests, accessibility and static output                                                   | In progress | 10 Node tests pass; build and formatting pass; Body4AI browser suite is 14/14; production `BUILD_INFO.json` reports `0.1.1` and zero server functions                    |
| 8    | Deploy preview, verify the deployed static wallet, then deploy production                              | Done        | Production `https://ai-auth-delta.vercel.app` is READY at `dpl_BnuEpCSnEQzWDWRXzjE3MoQdnYv3`; `BUILD_INFO.json` reports `0.1.1` and `serverFunctions: 0`                 |
| 9    | Publish `@enzovezzaro/ai-auth-wallet` and verify an isolated npm install                               | Done        | `0.1.1` is published; an isolated consumer installed it from npm and verified the popup verifier and permission-request exports                                          |
| 10   | Test the production wallet with the running Body4AI app                                                | Done        | Production wallet approval/rejection passed on `http://localhost:4173/`; live Body4AI approval, identity display, disconnect, and read-only MCP also passed              |

## Security boundaries

- A signature proves control of a key, not a human identity, a site's approval, or permission to execute a protected action.
- The website remains the authority for its own resources and must verify each grant, audience, scope, expiry, and revocation state before acting.
- Browser storage is origin-scoped and can be cleared. The encrypted recovery file is the wallet recovery path; losing both the browser data and backup loses the identity.
- Same-origin BroadcastChannel discovery is limited to open tabs on one origin. Manual WebRTC pairing does not supply global peer discovery.
- STUN can expose network metadata. Direct connectivity is not guaranteed; relay-only networks need a separately reviewed TURN provider.
- Clerk, DID methods, WebMCP execution, broad delegation policy, revocation distribution, encrypted peer payloads beyond WebRTC transport, and multi-agent scale are outside this first acceptance gate.
