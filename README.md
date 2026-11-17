# AI Auth

AI Auth gives an AI agent a wallet identity it can carry between websites. A site asks for named capabilities. The wallet owner approves them. Agents then work with people and other agents over peer-to-peer connections. There is no AI Auth account and no server holding your keys.

## The three roles

- **Site**: a website that wants to know which agent is visiting. It requests capabilities and enforces its own access rules.
- **Visitor**: the person who owns the wallet. They see the request, allow the permissions they want, and choose how long the session lasts.
- **Agent**: software using a wallet identity. It can run in a browser tab or headless with the agent packages.

## Install

Pick the package for the side you are building.

| Package                        | What it does                                                | Version |
| ------------------------------ | ----------------------------------------------------------- | ------- |
| `@enzovezzaro/ai-auth-wallet`  | Browser SDK, wallet dialog, collaboration, WebMCP bridge    | 0.10.0  |
| `@enzovezzaro/ai-auth-agent`   | Headless Node agent with an encrypted keystore and WebRTC   | 0.1.5   |
| `@enzovezzaro/ai-auth-mcp`     | `ai-auth-mcp` command and MCP tools for local coding agents | 0.3.4   |
| `@enzovezzaro/ai-auth-runtime` | Plugin host for local agent applications                    | 0.1.0   |

```sh
npm install @enzovezzaro/ai-auth-wallet
npm install @enzovezzaro/ai-auth-agent
npm install @enzovezzaro/ai-auth-mcp
```

## Quick start

Call the connect function from a click or another user gesture. The wallet shows the request and signs only the permissions the visitor allows.

```js
import {
  connectAIAuthModal,
  mountAIAuthCollaboration,
} from "@enzovezzaro/ai-auth-wallet";

const connection = await connectAIAuthModal({
  walletUrl: "https://wallet.example/wallet/",
  capabilities: ["presence.read", "messages.send"],
  room: "project-room",
});
const stopCursors = mountAIAuthCollaboration(connection);
connection.onEvent((e) => console.log(e.body.type, e.body.payload));
// Later: stopCursors(); connection.close();
```

After a page refresh the connection ends. The visitor clicks Resume to bring it back; automatic reconnect on load is not available. See the [site integration guide](docs/site-integration.md).

## Limits

- No AI Auth server holds keys. The browser wallet keeps its key in origin-scoped storage, and a headless agent keeps its key in a local file.
- WebRTC needs a relay to signal. No TURN server is configured, so restrictive networks can block a direct connection.
- A refresh or a closed tab ends the live connection. Resume takes one click.
- Presence is shown only for participants connected to the same origin room.
- The site is hosted on [GitHub Pages](docs/HOSTING.md) only. This is enforced by CI.

## Links

- [Docs index](docs/README.md) and [connect a site in ten minutes](docs/quickstart.md)
- [Site integration](docs/site-integration.md), [agents](docs/agents.md) and [MCP command](docs/mcp.md)
- [Architecture](docs/ARCHITECTURE.md), [protocol](docs/PROTOCOL.md), [security](docs/SECURITY.md)
- [Wallet recovery](docs/RECOVERY.md), [hosting](docs/HOSTING.md), [changelog](CHANGELOG.md)
- [`examples/body4ai/`](examples/body4ai/) is a demo consumer, not the live site.

## Checks

```sh
npm test
npm run format:check
npm run test:all
```

[MIT](LICENSE).
