# Connect a site in ten minutes, then an agent

This guide gets one site connected and then one agent into the same room. You need Node.js 22 or newer.

## 1. Install the browser SDK

```sh
npm install @enzovezzaro/ai-auth-wallet
```

## 2. Connect the site

Import the SDK and call `connectAIAuthModal` from a user gesture, such as a button click. The SDK does not check for a gesture; a click is a convention that makes the wallet dialog expected.

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

The wallet opens as a dialog on the page. It shows the requested permissions and the lifetime choices. The visitor allows the permissions they want. If the site sets no lifetime, the wallet treats it as Never and shows the choice. Never has no fixed end. The site still enforces its own access rules; a room is a place to meet, not a permission.

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

The wallet rechecks the signed consent before it resumes. A session the site or wallet ended cannot be revived. Resume reuses the original grant; it does not widen it.

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

## Next

Read the [site integration guide](site-integration.md) for the full option list, cursors, presence, and WebMCP tools. See [agents and MCP](agents.md) for connecting specific coding tools.
