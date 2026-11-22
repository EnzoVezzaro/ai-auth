![AI Auth, identity for AI agents](https://raw.githubusercontent.com/EnzoVezzaro/ai-auth/main/docs/assets/ai-auth-banner.jpg)

<div align="center">

# AI Auth

An identity your agents can take with them.

[Live site](https://enzovezzaro.github.io/ai-auth/) · [Wallet](https://enzovezzaro.github.io/ai-auth/wallet/) · [Architecture](https://enzovezzaro.github.io/ai-auth/docs/ARCHITECTURE.md) · [npm](https://www.npmjs.com/package/@enzovezzaro/ai-auth-wallet)

[![npm version](https://img.shields.io/npm/v/@enzovezzaro/ai-auth-wallet.svg)](https://www.npmjs.com/package/@enzovezzaro/ai-auth-wallet)
[![CI](https://github.com/EnzoVezzaro/ai-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/EnzoVezzaro/ai-auth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-231F20.svg)](LICENSE)

</div>

An agent turns up at a website. The site needs to know which agent it is, and it needs a way to say what that agent may do. AI Auth handles both with a wallet the agent keeps. You approve the capabilities, and the site stays in charge of its own data and tools.

There is no AI Auth account and no server holding your keys. A browser wallet keeps its key in origin-scoped storage. A headless agent keeps its key in an encrypted file on its machine. Public Nostr relays help peers find each other; after that, messages and signed events go straight over WebRTC. There is no blockchain or token.

AI Auth is generic. Body4AI is one example consumer under `examples/body4ai/`; its product catalog and commands are not part of AI Auth. Generic integration tests use an independent site with `demo.echo` and `demo.increment`. See [session and connection lifecycle](docs/lifecycle.md).

AI Auth is published on **GitHub Pages only**. See the [hosting policy](docs/HOSTING.md) for the CI guard and removal of the legacy Vercel GitHub App.

## Install

Pick the package for the side you are building.

| Package                        | What it does                                                                           | Version |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------- |
| `@enzovezzaro/ai-auth-wallet`  | Browser SDK, wallet dialog, collaboration, WebMCP bridge. This is the repository root. | 0.12.2  |
| `@enzovezzaro/ai-auth-agent`   | Headless Node agent with an encrypted keystore, room runtime, and real WebRTC          | 0.2.0   |
| `@enzovezzaro/ai-auth-mcp`     | `ai-auth-mcp` command and MCP tools for local coding agents                            | 0.3.9   |
| `@enzovezzaro/ai-auth-runtime` | Plugin host for local agent applications, independent of any provider                  | 0.1.3   |

None of them needs an AI Auth service to run.

**Version source of truth:** each version above mirrors that package's own `package.json`; the root `package.json` is the single source for the product release label. Version strings shown in UI surfaces are generated from that source at build time or omitted from nontechnical UI. Do not maintain a separate hardcoded product version in page markup ([release note](CHANGELOG.md#unreleased)).

```sh
npm install @enzovezzaro/ai-auth-wallet
npm install @enzovezzaro/ai-auth-agent
npm install @enzovezzaro/ai-auth-mcp
```

The static site is hosted on [GitHub Pages](https://enzovezzaro.github.io/ai-auth/), while the npm packages above are published to npm by [`.github/workflows/release.yml`](https://github.com/EnzoVezzaro/ai-auth/blob/main/.github/workflows/release.yml). The [hosting policy](docs/HOSTING.md) explains why the site is hosted on GitHub Pages only.

## Run it locally

You need Node.js 22 or newer and npm.

```sh
npm ci
npm run dev
```

The site root is the landing page. `/wallet/` is the local wallet, and `/docs/ARCHITECTURE.md` is the architecture document. The dev command only builds and serves static files. The wallet starts in private mode. Switch on public collaboration when you want to join the current page's shared space.

## Connect agents to a site

The site never opens or picks a wallet. The agent carries its own, on the machine where it runs. The site adds a **Connect** button:

```js
import {
  createAIAuthAgentLink,
  mountAIAuthAgentConnect,
} from "@enzovezzaro/ai-auth-wallet";

const link = createAIAuthAgentLink({
  siteName: "Example Workspace",
  capabilities: ["presence.read", "messages.send", "tools.invoke"],
  room: "agents",
});
mountAIAuthAgentConnect({
  controller: link,
  button: document.getElementById("connect"),
});
```

Pressing Connect opens a popup that checks for an agent this browser connected before. If one is in the room, it answers a fresh signed challenge and is connected. If not, the popup shows a one-time link. Give that link to your agent, on this computer or another one:

```sh
npx -y @enzovezzaro/ai-auth-mcp init --new-identity   # once: the agent creates its identity on its own machine
npx -y @enzovezzaro/ai-auth-mcp serve --connect "<link>"
```

The agent's owner approves the scopes in the agent's terminal. The site shows the agent as connected, and the agent's `ai_auth_status` names the site it is connected to. Next time, `ai-auth-mcp serve` reconnects on its own, with no new link. Site tools published with `mountAIAuthInPageAgent({ connection: link.toolConnection(), ... })` answer only connected agents. Details: [Connect agents](docs/site-integration.md#connect-agents-recommended) and the [agent connect example](https://enzovezzaro.github.io/ai-auth/agent-link/).

## Show a person's browser wallet on a site

This is a separate, optional flow for a person (not an agent) who brings a browser wallet for presence and cursors. Agents use connect links above.

The build writes the browser bundle to `dist-p2p/ai-auth.js`. You can bundle the SDK as an ES module or load that file from your wallet host.

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

Call the modal from a click or another user gesture; the SDK does not enforce a gesture check, so this is a convention for the calling site rather than a guarantee. It shows the site's request and signs only the scopes you select. Use HTTPS once you leave local development.

The default room name is the literal `default`. The site's exact origin still matters: the shared topic hash is `createSharedRoomTopic(origin, room)`, so agents on the same origin and room name find one another. Pass a `room` key if you want a separate space. A room puts peers in the same place. It does not hand out access, so the site still checks every request.

The details are in the [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), [wire protocol](docs/protocol.md), and [wallet recovery](docs/RECOVERY.md) documents.

## Hand an agent a connect instruction

For new sites, prefer the [connect link](#connect-agents-to-a-site) above: it needs no wallet on the site and reconnects on its own. The instruction below is the older, copyable form.

You can publish a connect instruction that an agent can copy, along with a panel that shows what happens during the handshake.

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

The panel shows the instruction with a copy button, then the handshake state (`idle` → `connecting` → `connected` → `disconnected`), the verified identity and its approved scopes, and the time left on the session. It also mirrors that state as `data-status` on the host element, so your CSS and header badges can read it without touching the shadow root. The instruction itself only carries public details: origin, room, wallet URL, and requested capabilities.

## Headless agents

An agent does not need an open browser tab. `@enzovezzaro/ai-auth-agent` keeps its wallet in an encrypted `0600` keystore file. The passphrase comes from `AI_AUTH_PASSPHRASE` or a terminal prompt. A broken keystore fails closed; it never quietly creates a new identity.

`createAgentRuntime` joins the room, sends heartbeat leases, and reconnects after a drop. `resume()` picks up a saved room after a restart. You will not see `direct-peer-connected` until a real WebRTC data channel is open. There is a worked example in `packages/agent/examples/peer.mjs`. The [agents and MCP guide](docs/agents.md) covers the runtime, its keystore, and the local coding agents.

For local coding agents, `ai-auth-mcp` exposes the same wallet through MCP stdio:

```sh
npx -y @enzovezzaro/ai-auth-mcp init
npx -y @enzovezzaro/ai-auth-mcp serve \
  --connect https://workspace.example \
  --room project-room \
  --caps presence.read,tools.invoke \
  --auto-join
```

The terminal shows a preview when an agent asks to connect. With nobody there to approve it, the command stops unless `--approve` lists the exact scopes. The [agents and MCP guide](docs/agents.md) records verification on 2026-11-15: a Claude Code tool call reached a peer over WebRTC, but Codex and OpenCode tool calls remain unverified (those runs stopped before a tool call).

WebMCP is the tool surface inside the page. The SDK finds the page's tools, advertises a bounded catalog, and only runs a call after the wallet scope check and the page's own approval step. These local integrations are optional for a website. Never put secrets or private page data in the shared room.

<details>
<summary>Sessions, rooms, and revocation</summary>

A session starts when a wallet approves a connection. A site that sets no limit gets Never, which lasts until you end it, the site ends it, or someone revokes it. The wallet also offers 5, 15, 30, and 60 minute choices. A site can set its own ceiling with `sessionTtlMs` and `idleTimeoutMs`. A numeric ceiling rules out Never. A numeric session with no idle setting ends after 10 minutes of no authorized activity.

`connection.renew()` takes the request back to the owner. It can keep or narrow the scopes, but it cannot add capabilities. After a session expires, goes idle, or ends, publishing, receiving, transfers, and WebMCP calls stop.

Rooms start as `open`. The SDK does not emit a join notice; it exposes the open-room disclosure text as `OPEN_ROOM_DISCLOSURE` (`policy.disclosure` / `room.disclosure`), which the site should display. Anyone with the origin and room name can get in. A `restricted` room only admits peers with a site-issued `ai-auth-membership` proof. The site creates and checks those with `createParticipationPolicy`, `issueMembership`, and `verifyMembership`. Membership can expire or last until revoked. Even a valid membership cannot run a protected operation by itself. Each of those needs a short-lived execution grant (`issueExecutionGrant`, checked by `authorizeProtected`). Revoke with a signed `ai-auth-revocation` record, shared through `createRevocationGossip`.

A peer that was offline learns about a revocation when it reconnects through gossip catch-up. There is no single on/off switch for all authorization: revocations target one membership, link, or wallet id, while a room-wide epoch (`bumpEpoch()` or a signed `ai-auth-epoch` record) invalidates every proof and grant issued under an older epoch. Short-lived execution grants keep the exposure window small. Private mode joins without showing a cursor or presence. The participant still receives authorized events, and its actions are still signed and audited. Private mode does not bypass site authorization or hide metadata from relays.

</details>

<details>
<summary>Upgrading from 0.4.x</summary>

- `registerAIAuthPageActions` throws unless you pass `authorize`. Every page action needs a human approval step.
- A denied or failed WebMCP call now rejects on the agent side instead of reporting success.
- `privateMode` joins a room quietly instead of being refused.
- Ship the SDK and wallet together. Older SDKs cannot verify the version 2 consent that carries long sessions.

The [changelog](CHANGELOG.md) has the full list.

</details>

## Example

[`examples/body4ai/`](https://github.com/EnzoVezzaro/ai-auth/tree/main/examples/body4ai) is a demo website built with the public SDK. It brings its own catalog, tools, and authorization rules. It consumes AI Auth; none of that site-specific code ships in the SDK or wallet.

## How the pieces connect

```mermaid
flowchart LR
  A[Agent runtime] -->|signed identity| S[Website]
  S -->|capability request| W[Wallet owner]
  W -->|scoped grant| S
  A <-->|WebRTC data channel| B[Other agents]
  R[Nostr relays] -. signaling .-> A
  R -. signaling .-> B
```

Relay operators can see timing and participation metadata. The hashed room topic is not a secret, and it grants nothing. There is no TURN server. Collaboration goes peer to peer, so a restrictive NAT or firewall can stop a connection.

The generic-site fixture in `scripts/test-browser-e2e.mjs` is an independent test website. It runs a real wallet handshake and direct WebRTC session to check signed events, cursors, site-authorized tool calls, and approval or cancellation. CI saves the browser screenshots as the `ai-auth-playwright-screenshots` artifact. Read the [generic integration review](docs/GENERIC_INTEGRATION_REVIEW.md) for what that evidence does and does not cover.

## Docs

The [docs index](docs/README.md) is the table of contents. The docs are grouped by what they help you do.

| What you need                        | Start here                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Connect a site and an agent          | [Quickstart](docs/quickstart.md)                                            |
| Connect a site in depth              | [Site integration](docs/site-integration.md)                                |
| Understand the model                 | [Architecture](docs/ARCHITECTURE.md)                                        |
| Connect Claude Code, Codex, OpenCode | [Agents and MCP](docs/agents.md) · [MCP command](docs/mcp.md)               |
| Check harness support and evidence   | [Agent harness support](docs/AGENT_HARNESS_SUPPORT.md)                      |
| Follow sessions, refresh, and resume | [Session lifecycle](docs/lifecycle.md) · [Limits](docs/limits.md)           |
| Recover or back up a wallet          | [Wallet recovery](docs/RECOVERY.md)                                         |
| Serve the static site                | [Hosting policy](docs/HOSTING.md)                                           |
| Look up a wire contract              | [Wire protocol](docs/protocol.md) · [Security boundaries](docs/SECURITY.md) |
| Check a trust boundary or discovery  | [Boundaries](docs/BOUNDARIES.md) · [Site discovery](docs/DISCOVERY.md)      |
| Read test records                    | [Evidence index](docs/evidence.md) · [E2E guide](docs/E2E.md)               |
| Read dated snapshots                 | [Archive](https://github.com/EnzoVezzaro/ai-auth/tree/main/docs/archive)    |

The [architecture document](docs/ARCHITECTURE.md) explains how the pieces connect and what the system does not provide.

## Checks

```sh
npm test                 # wallet SDK suite
npm run test:all         # SDK, runtime, MCP and agent suites
npm run test:types       # strict type check of the public declarations
npm run build
npm run verify:packages  # pack all packages and import them from a clean install
npm run test:browser:e2e
npm run test:e2e:body4ai # multi-agent demo-site E2E (see docs/E2E.md)
```

The browser tests use two isolated wallets and public relay and WebRTC connectivity. They need network paths that allow direct ICE. Seeing a peer discovered is not the same as seeing a collaboration session work.

## Contributing

If something is broken or unclear, open an issue. For a pull request, keep the change focused and run `npm run test:all`, `npm run build`, and `npm run format:check` first. Tell me what you actually checked. For a security problem, follow [docs/SECURITY.md](docs/SECURITY.md) instead of filing a public issue.

## License

[MIT](LICENSE). The SDK, agent runtime, MCP tools, and landing page are all open source.
