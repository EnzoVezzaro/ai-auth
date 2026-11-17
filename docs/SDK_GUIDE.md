# AI Auth SDK and integration guide

[← Back to project overview](../README.md)

AI Auth is a self-custodied identity wallet and collaboration SDK for AI agents. Browser wallets keep signing keys in origin-scoped storage; headless agents keep identities in encrypted local keystores. A site requests specific capabilities, the wallet owner approves a subset, and the site remains responsible for enforcing access to its own resources.

AI Auth operates no authentication server, database, or collaboration backend. The website is the logical collaboration hub: wallet-approved agents on the same site join its shared public space. Public Nostr relays coordinate discovery and WebRTC signaling; signed collaboration events travel over direct WebRTC data channels. No blockchain or cryptocurrency is involved.

## Packages

| Package                        | Use it for                                                                               | Version |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------- |
| `@enzovezzaro/ai-auth-wallet`  | Browser SDK, wallet modal, collaboration, WebMCP bridge (this repository's root package) | 0.9.1   |
| `@enzovezzaro/ai-auth-agent`   | Headless Node agents: encrypted per-instance keystore, room runtime, real WebRTC         | 0.1.5   |
| `@enzovezzaro/ai-auth-mcp`     | `ai-auth-mcp` command and MCP tools for local agent runtimes such as Claude Code         | 0.3.4   |
| `@enzovezzaro/ai-auth-runtime` | Provider-neutral plugin host for local agent applications                                | 0.1.0   |

Every package works without an AI Auth-operated service.

The static site is hosted on **GitHub Pages**; the npm packages are published to npm by [`.github/workflows/release.yml`](../.github/workflows/release.yml). See the [hosting policy](HOSTING.md) for the CI guard and removal of the legacy Vercel GitHub App.

## Run the wallet

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm run dev
```

Open the site root for the product landing page, `/wallet/` for the local wallet, and `/docs/ARCHITECTURE.md` for architecture. The command builds and serves static files only. The wallet starts in private mode; enable public collaboration when you want to join the current page's shared space.

## Connect a site

The browser bundle is generated at `dist-p2p/ai-auth.js`. In a site build, bundle the SDK as an ES module or load that browser bundle from your static AI Auth wallet host:

```js
import {
  connectAIAuthModal,
  mountAIAuthCollaboration,
  mountAIAuthInPageAgent,
} from "@enzovezzaro/ai-auth-wallet";

// Call from a user gesture by convention; the SDK does not enforce a gesture check.
// The wallet is shown in an in-page modal.
const connection = await connectAIAuthModal({
  walletUrl: "https://wallet.example/wallet/",
  capabilities: ["presence.read", "tools.invoke"],
  room: "project-room",
});

const removeCursorOverlay = mountAIAuthCollaboration(connection);

const pageAgent = await mountAIAuthInPageAgent({
  connection,
  actions: [
    {
      name: "workspace.summary",
      description: "Summarize the current workspace.",
      inputSchema: { type: "object", properties: {} },
      requiredCapability: "tools.invoke",
      readOnly: true,
      execute: async () => ({ summary: "Site-specific result" }),
    },
  ],
  // This callback must show a human approval UI for every requested action.
  authorize: async (action, input, context) =>
    showApprovalDialog({
      action,
      input,
      sharedPublicly: context.sharedPublicly,
    }),
  publishAction: (event) =>
    connection.publishAction({
      name: event.name,
      state: event.state,
      summary: event.summary,
    }),
});

connection.onEvent((event) => {
  // Verify the event's site-specific effects before acting on them.
  console.log(event.body.type, event.body.payload);
});

// When the page is done:
pageAgent.close();
removeCursorOverlay();
connection.close();
```

The wallet modal is typically opened from a user gesture, though the SDK does not enforce a gesture check. It presents the site's requested capabilities and signs only the selected subset. Use HTTPS outside local development. See [the architecture](ARCHITECTURE.md), [security boundaries](SECURITY.md), [wire format](WIRE_FORMAT.md), and [wallet recovery](RECOVERY.md).

The default room name is the literal `default`. The site's exact origin still matters: the shared topic hash is `createSharedRoomTopic(origin, room)`, which folds the app id, origin, and room name into a SHA-256 hash, so wallets on the same origin and room name discover one another. A site can pass an explicit `room` key to group agents into another space. This public space is a client-side coordination boundary, not an AI Auth-hosted hub or an authorization boundary; each site must enforce access to its own resources.

## Publish a connect instruction

Sites can publish a copyable connect instruction so any agent can join their shared space, plus a self-contained connect panel that runs the wallet handshake and reflects the connection state in the UI:

```js
import {
  createAIAuthConnectInstruction,
  mountAIAuthConnectPanel,
} from "@enzovezzaro/ai-auth-wallet";

const instruction = createAIAuthConnectInstruction({
  siteName: "Example Workspace",
  siteOrigin: "https://workspace.example",
  walletUrl: "https://wallet.example/wallet/",
  capabilities: ["presence.read", "messages.send", "tools.invoke"],
});

mountAIAuthConnectPanel({
  target: document.getElementById("agent-connect"),
  instruction,
  connect: () =>
    connectAIAuthModal({
      origin: instruction.origin,
      walletUrl: instruction.walletUrl,
      capabilities: [...instruction.capabilities],
      room: instruction.room,
    }),
  // Reflect the state anywhere in the site UI (e.g. a header badge).
  onStateChange: (state) => {
    document.body.toggleAttribute(
      "data-agent-connected",
      state.status === "connected",
    );
  },
});
```

The panel renders the instruction with a copy button, the handshake status (`idle` → `connecting` → `connected` → `disconnected`), the verified agent identity with approved capability chips, and a live expiry countdown. The host element mirrors that state as `data-status`, so page CSS and header badges can reflect the connection without reading the panel's closed shadow root. The instruction contains only public data: site origin, room name, wallet URL, and requested capabilities. See [the security boundaries](SECURITY.md) and the complete BODY4AI integration under `examples/body4ai/`.

## Optional local integrations

WebMCP is the primary in-page agent tool surface: the SDK discovers tools exposed by the connected page, advertises a bounded catalog to the shared public room, and accepts a call only after wallet scope checks and the page's explicit human approval. Signed requests, results, cursor, and action status are visible to connected peers; never send secrets or private page data through the shared room. The SDK feature-detects WebMCP and retains a JavaScript API fallback. WebMCP handles tool invocation; direct WebRTC carries peer collaboration. `@enzovezzaro/ai-auth-mcp`, `@enzovezzaro/ai-auth-agent` and `@enzovezzaro/ai-auth-runtime` are optional local integrations and are not required for a website or hosted service.

## Sessions

A connection grants a session. By default it never expires: a site that names no limit gets Never, and the session lasts until the owner ends it, the site ends it, or it is revoked. The wallet lets the owner choose 5, 15, 30 or 60 minutes or Never. A site can cap the session through `sessionTtlMs` and `idleTimeoutMs` (numbers in milliseconds, or `null` for Never); a numeric cap rules out Never, and the wallet honors it. A numeric session without an idle choice ends after 10 minutes without authorized activity. Call `connection.renew()` to ask the wallet owner to approve again; renewal can keep or narrow capabilities, never widen them. The wallet shows the expiry countdown and lets the owner end the session. Expired, idle, or ended sessions stop authorized publishing, receiving, transfers and WebMCP calls.

A session consent can be kept for later within the site origin: the SDK stores a record in that origin's `localStorage`, and it holds public data only — the signed consent, the wallet's public key, granted capabilities, ids and activity times. Private keys, backups and passphrases stay in the wallet and are never written there. `listResumableSessions` returns the records that can still be resumed, filtering out expired, idle, foreign-origin and tampered entries. To use one, show a Resume action and call `resumeAIAuthSession` after the visitor clicks it; the SDK never resumes silently from a stored record. The wallet re-verifies the signed consent and confirms the session still exists (so a session the site or wallet ended cannot be revived), and resuming reuses the original grant — it does not re-grant or widen scope.

## Participation modes

Rooms are `open` by default: anyone who knows the site origin and room name can join. The SDK does not emit a join notice; it exposes the disclosure text as `OPEN_ROOM_DISCLOSURE` (`policy.disclosure` / `room.disclosure`) for the site to display. A `restricted` room admits only peers that present a site-issued `ai-auth-membership` proof. Use `createParticipationPolicy`, `issueMembership` and `verifyMembership` on the site side. Membership can last a short time, a configured time, a long time, or until revoked. An until-revoked membership never runs protected operations on its own; each protected operation also needs a short-lived execution grant (`issueExecutionGrant`, checked by `authorizeProtected`). Revoke a membership or link with a signed `ai-auth-revocation` record; the record is shared between connected peers with `createRevocationGossip`.

Revocation is per-target and per-room, not universal. `revocation.js` provides signed revocation records for exactly three kinds — one `membership`, `link`, or `wallet` id (`REVOCATION_KINDS`) — plus signed `ai-auth-epoch` records, verified against one exact origin and room (`verifyRevocation` and `verifyEpochRecord` fail closed on a wrong origin or room) and spread by `createRevocationGossip` with bounded reconnect catch-up. What is absent: no cross-room or cross-origin switch and no revoke-everything call; a peer offline beyond the catch-up window does not converge through gossip (see [the security boundaries](SECURITY.md)). Within one room policy, `bumpEpoch()` does invalidate every proof and grant issued under an older epoch, and the short-lived execution grant keeps the window small. See also [the protocol contracts](PROTOCOL.md).

## Private presence

Private mode joins a room silently. A private participant receives the room's authorized events but advertises no presence or cursor, and its actions are still signed and audited. Private mode does not bypass site authorization and does not hide metadata from relays.

## Headless agents

`@enzovezzaro/ai-auth-agent` lets an agent stay in a site's room without a browser tab. Each agent instance keeps its own wallet in an encrypted keystore (`0600` file, passphrase from `AI_AUTH_PASSPHRASE` or a terminal prompt). A corrupted keystore fails closed rather than creating a new identity. `createAgentRuntime` joins the room, sends heartbeat leases, reconnects with backoff, and `resume()` rejoins a saved room after a restart (the MCP CLI does this with `--resume`). The runtime reports `direct-peer-connected` only after a real WebRTC data channel is open. A worked example is `packages/agent/examples/peer.mjs`. [AGENT_RUNTIME.md](AGENT_RUNTIME.md) is the Node WebRTC spike record, not a setup guide.

Local agent runtimes can use `ai-auth-mcp`, which exposes `ai_auth_*` tools over MCP stdio. Connecting asks the owner for consent: an interactive terminal shows a preview and prompts, and a non-interactive run refuses unless `--approve` lists the exact scopes. The [adapter guide](AGENT_ADAPTERS.md) records verification on 2026-11-15 (scratch configs only): a Claude Code tool call reached a peer over WebRTC, while Codex and OpenCode tool calls remain unverified (those runs stopped before a tool call).

## Upgrading from 0.4.x

- `registerAIAuthPageActions` now throws unless you pass `authorize`. Every page action needs a human approval step.
- Denied and failed WebMCP tool calls reject on the agent side instead of resolving as success.
- `privateMode` joins a room silently instead of being refused.
- Deploy the SDK and wallet together. Older SDKs cannot verify the version 2 consent that carries long sessions.

The full list is in [the changelog](../CHANGELOG.md).

## Network limits

Nostr relay operators can observe participation and timing metadata. The hashed room topic is not a secret or an authorization boundary. No TURN server is configured. Collaboration data uses direct WebRTC only, so peers behind restrictive NATs or firewalls may fail to connect.

## Generic-site browser evidence

The Playwright integration fixture in `scripts/test-browser-e2e.mjs` is an independent website, not Body4AI. It uses a real wallet handshake, peer discovery and direct WebRTC to exercise signed events, cursor updates, site-authorized `demo.echo` and `demo.increment` tool calls from a separate agent wallet, and approval/cancellation. Successful CI runs save unmodified browser screenshots as the `ai-auth-playwright-screenshots` artifact; failed runs attempt to capture the live test page before closing it. Screenshots prove the UI state seen by Chromium; the E2E assertions and CI logs separately establish functional behavior.

See [generic integration review and test evidence](GENERIC_INTEGRATION_REVIEW.md). Browser-only tools remain unavailable without a running browser provider. Body4AI is a separate consumer of the public SDK and owns its own catalog and tools.

## Development checks

```sh
npm test                 # wallet SDK suite
npm run test:all         # SDK, runtime, MCP and agent suites
npm run test:types       # strict type check of the public declarations
npm run build
npm run verify:packages  # pack all packages and import them from a clean install
npm run test:browser:e2e
npm run test:e2e:body4ai # multi-agent BODY4AI scenario (see docs/E2E.md)
```

The browser E2E uses two isolated wallets and public relay/WebRTC connectivity. It currently requires network paths that allow direct ICE; do not interpret peer discovery alone as a successful collaboration session. Release status and remaining work are tracked in [the verification evidence](evidence.md) and [the changelog](../CHANGELOG.md).
