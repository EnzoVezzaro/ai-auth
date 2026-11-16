# Full-protocol multi-agent E2E (BODY4AI demo site)

`npm run test:e2e:body4ai` runs one reproducible browser scenario in which several agents and visitors use a website built with the AI Auth SDK. It exercises every merged protocol interaction with **real Chromium, real public Nostr relays and real direct WebRTC**. Nothing in the SDK, Nostr or WebRTC is mocked. The only stand-in is `getDisplayMedia` (a synthetic canvas stream), because headless Chromium cannot show a screen-capture prompt.

Mocked unit tests live in `tests/`; this scenario is the evidence that the pieces work together.

## Run it

```sh
npm ci
(cd packages/agent && npm ci)      # headless agent dependencies (node-datachannel)
npx playwright install chromium     # once
npm run test:e2e:body4ai            # builds dist-p2p first
```

Environment: `AI_AUTH_CHROMIUM_PATH` selects another Chromium. `B4A_STOP_AFTER=<n>` stops after step n (debugging). The whole run times out after 10 minutes. Output: a PASS / FAIL / KNOWN-BUG / PENDING / NETWORK line per step, a summary table, and `test-results/e2e-report.json` (gitignored) with each step's duration and evidence such as wallet ids and peer counts. The exit code is 0 only when every step passes. A NETWORK result (ICE or relay failure) is reported as a network problem, not a product failure.

## Network requirements

- Outbound WebSocket access to public Nostr relays (Trystero's defaults). Relays carry signaling only; every application event travels over direct WebRTC data channels.
- UDP/ICE connectivity between Chromium processes and the Node agent on this machine. There is no TURN. If the relays are unreachable or ICE fails, the step is reported as **NETWORK**, not as a product failure.
- Every run uses a random room name, so concurrent or repeated runs do not see each other.

## Participants

Each browser participant has its own Chromium context (storage and identity). All of them load the demo site at `/body4ai/` (`examples/body4ai/site/`, bundled by `scripts/build-p2p-static.mjs`).

| Who                                  | Role                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Human A, Human B                     | Visitors. They host the WebMCP tools and approve protected calls.                                |
| Agent 1, Agent 2                     | Admitted agents with separate wallets.                                                           |
| Agent 3                              | Knows origin and room, holds only a forged membership.                                           |
| Headless agent                       | `packages/agent` in a child process with a temp keystore.                                        |
| Origin B                             | The same site on a second port, for cross-origin negatives.                                      |
| Site operator (`site-authority.mjs`) | Holds the issuer key: issues memberships and execution grants, revokes, and verifies site links. |

The demo site has no backend, so the operator is the test controller using only public SDK functions. Membership proofs are handed to participants out of band, like an invitation.

## Steps

Each step is named and asserted in `scripts/e2e/steps-*.mjs`. Steps run in dependency order; the table is sorted by number.

1. Wallets are created on first connect; ids and public keys are distinct.
2. Consent: the site requests four capabilities, Agent 2 approves three, the site sees exactly those, and the SDK refuses the rest.
3. Session grant: expiry is shown, the session outlives the 120 s handshake (controllable clock), renews without widening scopes, and an expired session cannot publish.
4. Connection state: `waiting-for-peers` precedes `direct-peer-connected`; `directPeerCount` is read from `NostrWebRTC.connectionState`.
5. Site link: `approveLink` (subset) then `verifyLink`; listed after a fresh page load; only approved scopes work.
6. Restricted room: an uninvited agent cannot invoke tools, receives no restricted events, and its forged membership is rejected.
7. Presence: one cursor per verified identity, labels shown as claims.
8. Wheel: broadcast chat, targeted message, receipt-driven state, password redaction, synthetic screenshot, oversized attachment rejected.
9. Agent to agent: signed events in both directions.
10. WebMCP: discovery, read-only call, approve, deny, cancel, duplicate request id.
11. Mixed permissions: no `tools.invoke` membership scope means no tool run.
12. Human A leaves; agents and the headless agent stay connected and keep talking.
13. Human B opens the site fresh, sees the agents' cursors, messages one and gets a signed receipt.
14. Agent 1 reloads: same identity, membership recovered, no ghost cursor. The headless agent restarts with the same keystore identity.
15. Revocation record gossiped; the revoked agent's protected calls fail.
16. Unlink: the wallet emits the revocation, the site applies it, link use fails.
17. Disconnect: the cursor leaves within the lease.
18. Cross-origin: a second origin rejects origin A's consent, link and membership and shares no room.
19. Private presence: a private agent receives authorized events, advertises no presence or cursor, and its signed events are audited.
20. Headless agent: visible to browsers, exchanges signed events with Agent 1.

## How the site uses the SDK

The demo is a static page. Every protocol decision is made by the SDK:

- **Consent and session:** `createPermissionRequest` / `approvePermissionRequest` / `verifyPermissionConsent` / `SessionLease` (`examples/body4ai/site/session.js`).
- **Room and transport:** `P2PRoom` (optionally `privateMode`) with `NostrWebRTC`, `CollaborationTransfers` and `mountCollaborationWheel`.
- **Presence:** `createPresenceTracker` fed only with verified room events; cursors are protocol v1 (`buildCursorPayload`, document coordinates, per page).
- **WebMCP tools:** `mountAIAuthInPageAgent` with `policy`, so every remote run passes the SDK membership and execution-grant gate (`authorizeProtected`). The site's `authorize` adds the human decision. Read-only tools need no click.
- **Revocation:** `createRevocationGossip` on the room, applied to the site's participation policy.
- **Links:** `approveLink` / `verifyLink` / `listLinks` / `unlink`, verified by the operator in `site-authority.mjs`.

The wallet iframe flow (`apps/p2p`) is covered by `scripts/test-browser-e2e.mjs`; this scenario drives the same SDK functions directly from the demo page.

## SDK defects this scenario found and fixed

These were real product bugs. Each fix has a unit test that fails on the old code.

- **Restricted-room confidentiality (step 6).** `NostrWebRTC.deliver` passed the peer list as a positional argument to Trystero's `action.send`. Trystero 0.27 reads `send(data, { target })`, so the list was ignored and restricted events were broadcast to every direct peer, including wallets with no membership. Fixed in `packages/p2p/p2p.js`; the test fakes (`tests/participation.test.mjs`, `packages/agent/test/fake-transport.mjs`) now follow the real contract, and a contract test pins it to the installed Trystero types.
- **Denied tool calls (step 10).** A denied call resolved as success. Fixed on `integration/0.5.0` (refusals are now `tool-response.error`); the matching `webmcp-contract` todos are closed.
- **Presence for private wallets (step 19).** Implemented on `integration/0.5.0` (private presence, `membership/prove`); the step now runs instead of reporting PENDING.
- **Headless agent (step 20).** Implemented in `packages/agent`; the step runs against a real child process.

## Post-release check (deferred)

This run uses the workspace sources. After the release, the same scenario should be run against the published packages: install `@enzovezzaro/ai-auth-wallet` and `@enzovezzaro/ai-auth-agent` from npm in a clean directory, serve the published `body4ai` demo, and run the steps again. That check is not part of this change and has not been done.

## What this does not prove

- Behaviour across NATs, mobile networks or restrictive firewalls: everything runs on one machine.
- Interoperability with an installed external coding agent harness.
- Six-participant scale evidence from separate devices.
- Human identity: signatures prove key possession only. Membership is the operator's decision.
- Publishing: this run does not publish, and does not verify the npm artifacts.
