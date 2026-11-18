# Connect a site and an agent

This connects one site and one agent to the same room. You need Node.js 22 or newer.

## 1. Install the browser SDK

```sh
npm install @enzovezzaro/ai-auth-wallet
```

## 2. Connect the site

Import the SDK and call `connectAIAuthModal` from a click or another user gesture so the wallet dialog is expected. The SDK does not check for a gesture.

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
```

The wallet opens as a dialog on the page. It shows the requested permissions and the lifetime choices. The visitor allows the permissions they want. If the site sets no lifetime, the wallet treats it as Never and shows the choice. Never has no fixed end. The site still enforces its own access rules. A room only puts peers in the same place.

`room` defaults to `default`. Peers find each other by the exact site origin plus the room name.

## 3. Resume after a refresh

A refresh or a closed tab ends the live connection. The site record is in that origin's `localStorage`, and the wallet keeps approved grants in IndexedDB. Show a Resume button. When the visitor clicks it, list the saved records and resume one:

```js
import {
  createSessionStore,
  listResumableSessions,
  resumeAIAuthSession,
} from "@enzovezzaro/ai-auth-wallet";

const store = createSessionStore();
const records = await listResumableSessions(store);
// After the visitor clicks Resume on a chosen record:
const resumed = await resumeAIAuthSession({
  walletUrl: "https://wallet.example/wallet/",
  capabilities: ["presence.read", "messages.send"],
  record: records[0],
});
```

The wallet rechecks the signed consent before it resumes. A session the site or wallet ended cannot be revived. Resume reuses the original grant without widening it.

Automatic reconnect on load is not available. Do not rely on stored records being checked when the page opens.

## 4. Bring in an agent

Publish a copyable connect instruction so any agent can join the same room. Mount the connect panel to show the handshake state:

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
  room: "project-room",
});
mountAIAuthConnectPanel({
  target: document.getElementById("agent-connect"),
  instruction,
});
```

For a local coding agent, the MCP command exposes the same wallet over stdio:

```sh
npx -y @enzovezzaro/ai-auth-mcp serve \
  --connect https://workspace.example \
  --room project-room \
  --caps presence.read,tools.invoke
```

## Connect from a chat app

To let a person ask an agent in plain language, install the portable [ai-auth-connect skill](https://github.com/EnzoVezzaro/ai-auth/blob/main/.agents/skills/ai-auth-connect/SKILL.md). The one-sentence instruction it handles is: "connect to this site using ai auth". It covers discovering the site's connect instruction or `/.well-known/ai-auth.json`, getting the owner's approval, starting the local MCP server, verifying with `ai_auth_status`, using site tools with approval, and reconnecting with `--resume`.

In a desktop chat app this is a manual flow: the user must bring the app window forward and approve in the wallet prompt. An offscreen or minimized app may not surface that prompt on its own.

## Next

Read the [site integration guide](site-integration.md) for the full option list, cursors, presence, and WebMCP tools. See [agents and MCP](agents.md) for connecting specific coding tools.
