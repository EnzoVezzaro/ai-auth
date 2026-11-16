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

Environment: `AI_AUTH_CHROMIUM_PATH` selects another Chromium. `B4A_STOP_AFTER=<n>` stops after step n (debugging). The whole run times out after 10 minutes. Output: a PASS / FAIL / KNOWN-BUG / PENDING / NETWORK line per step, a summary table, and `test-results/e2e-report.json` (gitignored) with each step's duration and evidence such as wallet ids and peer counts. The exit code is 0 only when every non-PENDING step passes. KNOWN-BUG steps fail the run so they stay visible.

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
6. Restricted room: an uninvited agent cannot invoke tools or be admitted (see KNOWN-BUG below).
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
19. Private presence: **PENDING** until the feature merges (feature check on the P2P source).
20. Headless agent: visible to browsers, exchanges signed events with Agent 1.

## How the site uses the SDK

The site is a static page. Because the in-page `registerAIAuthPageActions`/`mountAIAuthInPageAgent` host only accepts connections created by the wallet modal, and the wallet modal's room cannot join restricted rooms, the demo hosts tools through an in-page adapter that registers itself with `markVerifiedPageConnection` from `packages/p2p/session.js`. The wallet iframe flow itself is covered by `scripts/test-browser-e2e.mjs` and is not repeated here.

## Findings (KNOWN-BUG steps)

A KNOWN-BUG step keeps its assertion and fails the run; the observed and expected behavior are in the step output and report JSON.

- **Step 6, confidentiality.** `NostrWebRTC.deliver` calls Trystero's `action.send(envelope, targets)` with an array, but `@trystero-p2p/nostr` 0.27 takes `send(data, { target })`. The array is ignored, so restricted-room events are broadcast to every direct peer, including a wallet with no membership. Receivers' policies still drop what they are not allowed to act on (the uninvited agent could not run a tool), but it receives restricted content.
- **Step 10, deny.** When the human denies a protected call the agent's `callTool` resolves with `{ error }` instead of rejecting (tracked in `tests/webmcp-contract.test.mjs` as a todo).

## What this does not prove

- Behaviour across NATs, mobile networks or restrictive firewalls: everything runs on one machine.
- Interoperability with an installed external coding agent harness.
- Six-participant scale evidence from separate devices.
- Human identity: signatures prove key possession only. Membership is the operator's decision.
- The wallet iframe (`apps/p2p`) joining restricted rooms: it cannot today.
