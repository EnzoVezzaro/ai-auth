![AI Auth, identity for AI agents](https://raw.githubusercontent.com/EnzoVezzaro/ai-auth/main/docs/assets/ai-auth-banner.jpg)

<div align="center">

# AI Auth

A self-custodied identity wallet and collaboration SDK for AI agents.

[Website](https://enzovezzaro.github.io/ai-auth/) · [Wallet](https://enzovezzaro.github.io/ai-auth/wallet/) · [Architecture](https://enzovezzaro.github.io/ai-auth/docs/ARCHITECTURE.md) · [npm](https://www.npmjs.com/package/@enzovezzaro/ai-auth-wallet)

[![npm version](https://img.shields.io/npm/v/@enzovezzaro/ai-auth-wallet.svg)](https://www.npmjs.com/package/@enzovezzaro/ai-auth-wallet)
[![CI](https://github.com/EnzoVezzaro/ai-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/EnzoVezzaro/ai-auth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-231F20.svg)](LICENSE)

</div>

Your agents carry their identity with them. A website asks for named capabilities, the wallet owner approves a subset, and the agent works inside that grant. The key stays with the agent. AI Auth runs no authentication server, database, or collaboration backend.

Browser wallets keep signing keys in origin-scoped storage. Headless agents keep identities in encrypted local keystores. The wallet holds the identity; the agent's runtime holds the connection. Public Nostr relays handle discovery and WebRTC signaling, while signed collaboration events travel directly between peers. No blockchain or cryptocurrency is involved.

## Contents

- [Why AI Auth](#why-ai-auth)
- [Packages](#packages)
- [Quick start](#quick-start)
- [Connect a site](#connect-a-site)
- [Connect instructions](#connect-instructions)
- [Local agent runtimes](#local-agent-runtimes)
- [How it fits together](#how-it-fits-together)
- [Documentation](#documentation)
- [Development checks](#development-checks)
- [Contributing](#contributing)
- [License](#license)

## Why AI Auth

- The wallet key is generated and kept locally, either in origin-scoped browser storage or in an encrypted keystore file.
- A request names exact capabilities for one origin. The wallet signs only the scopes the owner accepts.
- Approved agents on the same website join its shared public space. There is no AI Auth hub to deploy or trust.
- Relays carry signaling. Messages, cursors, and tool results move over WebRTC data channels as signed events.
- A verified identity proves control of a key. Each site checks that proof and enforces access to its own resources.

`@enzovezzaro/ai-auth-server` is retired. Use the wallet package instead. AI Auth is published on [GitHub Pages](https://enzovezzaro.github.io/ai-auth/) only; see the [hosting policy](docs/HOSTING.md).

## Packages

| Package                        | Use it for                                                                               | Version |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------- |
| `@enzovezzaro/ai-auth-wallet`  | Browser SDK, wallet modal, collaboration, WebMCP bridge (this repository's root package) | 0.6.2   |
| `@enzovezzaro/ai-auth-agent`   | Headless Node agents: encrypted per-instance keystore, room runtime, real WebRTC         | 0.1.5   |
| `@enzovezzaro/ai-auth-mcp`     | `ai-auth-mcp` command and MCP tools for local agent runtimes such as Claude Code         | 0.3.4   |
| `@enzovezzaro/ai-auth-runtime` | Provider-neutral plugin host for local agent applications                                | 0.1.0   |

Every package works without an AI Auth-operated service. Install them from npm:

```sh
npm install @enzovezzaro/ai-auth-wallet
npm install @enzovezzaro/ai-auth-agent
npm install @enzovezzaro/ai-auth-mcp
```

## Quick start

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm run dev
```

Open the site root for the landing page, `/wallet/` for the local wallet, and `/docs/ARCHITECTURE.md` for architecture. The command builds and serves static files only. The wallet starts in private mode; enable public collaboration when you want to join the current page's shared space.

## Connect a site

The browser bundle is generated at `dist-p2p/ai-auth.js`. Bundle the SDK as an ES module, or load that browser bundle from your static wallet host.

```js
import {
  connectAIAuthModal,
  mountAIAuthCollaboration,
  mountAIAuthInPageAgent,
} from "@enzovezzaro/ai-auth-wallet";

// Call from a user gesture. The wallet is shown in an in-page modal.
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
  // Every requested action needs a human approval step.
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
  // Check the event's site-specific effects before acting on it.
  console.log(event.body.type, event.body.payload);
});

// When the page is done:
pageAgent.close();
removeCursorOverlay();
connection.close();
```

The modal opens from a user gesture, shows the site's requested capabilities, and signs only the selected subset. Use HTTPS outside local development.

The default public space is keyed by the exact website origin and the `default` room name, so wallets on one site discover each other. A site can pass an explicit `room` key to group agents into another space. This space is a client-side coordination boundary, not an authorization boundary. Each site enforces access to its own resources.

Read the [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), [wire format](docs/WIRE_FORMAT.md), and [wallet recovery](docs/RECOVERY.md) for the details.

## Connect instructions

A site can publish a copyable connect instruction and a self-contained panel that shows the handshake state in its own UI.

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
  onStateChange: (state) => {
    document.body.toggleAttribute(
      "data-agent-connected",
      state.status === "connected",
    );
  },
});
```

The panel shows the instruction with a copy button, the handshake status (`idle` → `connecting` → `connected` → `disconnected`), the verified agent identity with approved capability chips, and a live expiry countdown. The host element mirrors that state as `data-status`, so page CSS and header badges can read it without reaching into the panel's closed shadow root. The instruction contains only public data: site origin, room name, wallet URL, and requested capabilities.

## Local agent runtimes

`@enzovezzaro/ai-auth-agent` lets an agent stay in a room without a browser tab. Each instance keeps its wallet in an encrypted keystore (`0600` file, passphrase from `AI_AUTH_PASSPHRASE` or a terminal prompt). A corrupted keystore fails closed. `createAgentRuntime` joins the room, sends heartbeat leases, reconnects with backoff, and `resume()` rejoins a saved room after a restart. It reports `direct-peer-connected` only after a real WebRTC data channel opens. See `packages/agent/examples/peer.mjs` and the [agent runtime notes](docs/AGENT_RUNTIME.md).

`ai-auth-mcp` exposes `ai_auth_*` tools over MCP stdio for local coding agents:

```sh
npx -y @enzovezzaro/ai-auth-mcp init
npx -y @enzovezzaro/ai-auth-mcp serve \
  --connect https://workspace.example \
  --room project-room \
  --caps presence.read,tools.invoke \
  --auto-join
```

Connecting asks the owner for consent. An interactive terminal shows a preview and prompts; a non-interactive run refuses unless `--approve` lists the exact scopes. Claude Code has been verified end to end. Codex and OpenCode registration is documented in the [adapter guide](docs/AGENT_ADAPTERS.md); their tool calls have not been verified yet.

WebMCP is the in-page tool surface. The SDK discovers tools on the connected page, advertises a bounded catalog, and accepts a call only after wallet scope checks and the page's explicit human approval. WebMCP handles tool invocation; direct WebRTC carries peer collaboration. These local integrations are optional for a website or hosted service. Never send secrets or private page data through the shared room.

<details>
<summary><strong>Sessions, participation, and revocation</strong></summary>

A connection grants a session. By default it never expires: a site that names no limit gets Never, and the session lasts until the owner ends it, the site ends it, or it is revoked. The wallet lets the owner choose 5, 15, 30, or 60 minutes or Never. A site can cap the session through `sessionTtlMs` and `idleTimeoutMs`; a numeric cap rules out Never. A numeric session without an idle choice ends after 10 minutes without authorized activity. `connection.renew()` asks the owner to approve again. Renewal can keep or narrow capabilities, never widen them. Expired, idle, or ended sessions stop authorized publishing, receiving, transfers, and WebMCP calls.

Rooms are `open` by default: anyone who knows the site origin and room name can join, and the SDK says so. A `restricted` room admits only peers with a site-issued `ai-auth-membership` proof. Use `createParticipationPolicy`, `issueMembership`, and `verifyMembership` on the site side. Membership can be short-lived, time-bound, long-lived, or valid until revoked. An until-revoked membership never runs a protected operation on its own; each protected operation also needs a short-lived execution grant (`issueExecutionGrant`, checked by `authorizeProtected`). Revoke a membership or link with a signed `ai-auth-revocation` record, shared with connected peers through `createRevocationGossip`.

Revocation is not instant and not global. A peer that was offline learns about it when it reconnects and catches up, and an execution grant limits the damage in the meantime. Private mode joins a room silently: the participant receives authorized events but advertises no presence or cursor, and its actions are still signed and audited. Private mode does not bypass site authorization or hide metadata from relays.

</details>

<details>
<summary><strong>Upgrading from 0.4.x</strong></summary>

- `registerAIAuthPageActions` now throws unless you pass `authorize`. Every page action needs a human approval step.
- Denied and failed WebMCP tool calls reject on the agent side instead of resolving as success.
- `privateMode` joins a room silently instead of being refused.
- Deploy the SDK and wallet together. Older SDKs cannot verify the version 2 consent that carries long sessions.

The full list is in the [changelog](CHANGELOG.md).

</details>

## How it fits together

```mermaid
flowchart LR
  A[Agent runtime] -->|signed identity| S[Website]
  S -->|capability request| W[Wallet owner]
  W -->|scoped grant| S
  A <-->|WebRTC data channel| B[Other agents]
  R[Nostr relays] -. signaling .-> A
  R -. signaling .-> B
```

Nostr relay operators can observe participation and timing metadata. The hashed room topic is not a secret or an authorization boundary. No TURN server is configured. Collaboration data travels directly between peers, so restrictive NATs or firewalls may block a connection.

The generic-site browser fixture in `scripts/test-browser-e2e.mjs` is an independent website, not Body4AI. It uses a real wallet handshake, peer discovery, and direct WebRTC to exercise signed events, cursor updates, site-authorized tool calls, and approval or cancellation. Successful CI runs save unmodified browser screenshots as the `ai-auth-playwright-screenshots` artifact. See the [generic integration review](docs/GENERIC_INTEGRATION_REVIEW.md). Body4AI is a separate consumer of the public SDK and owns its own catalog and tools.

## Documentation

| Topic                  | Source                                                                            |
| ---------------------- | --------------------------------------------------------------------------------- |
| Architecture           | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                      |
| Security boundaries    | [docs/SECURITY.md](docs/SECURITY.md)                                              |
| Protocol and wire data | [docs/PROTOCOL.md](docs/PROTOCOL.md) · [docs/WIRE_FORMAT.md](docs/WIRE_FORMAT.md) |
| Agent adapters         | [docs/AGENT_ADAPTERS.md](docs/AGENT_ADAPTERS.md)                                  |
| Agent runtime          | [docs/AGENT_RUNTIME.md](docs/AGENT_RUNTIME.md)                                    |
| Recovery               | [docs/RECOVERY.md](docs/RECOVERY.md)                                              |
| Hosting policy         | [docs/HOSTING.md](docs/HOSTING.md)                                                |
| Implementation plan    | [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)                        |

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

The browser E2E uses two isolated wallets and public relay and WebRTC connectivity. It needs network paths that allow direct ICE; peer discovery alone does not mean a collaboration session succeeded.

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm run test:all`, `npm run build`, and `npm run format:check`. Keep changes to one package or one concern, and describe the behavior you verified. For a security finding, follow [docs/SECURITY.md](docs/SECURITY.md) instead of opening a public issue.

## License

[MIT](LICENSE). The browser SDK, agent runtime, MCP tools, and landing page are open source.
