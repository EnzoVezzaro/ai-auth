# Site integration

[← Back to the docs index](README.md)

This guide is for a website that wants to connect a wallet, show presence and cursors, and offer tools to agents. The site always enforces its own access rules. A room is a coordination boundary, not an authorization boundary.

## Packages

| Package                        | What it does                                                | Version |
| ------------------------------ | ----------------------------------------------------------- | ------- |
| `@enzovezzaro/ai-auth-wallet`  | Browser SDK, wallet dialog, collaboration, WebMCP bridge    | 0.12.0  |
| `@enzovezzaro/ai-auth-agent`   | Headless Node agent with an encrypted keystore and WebRTC   | 0.1.8   |
| `@enzovezzaro/ai-auth-mcp`     | `ai-auth-mcp` command and MCP tools for local coding agents | 0.3.7   |
| `@enzovezzaro/ai-auth-runtime` | Plugin host for local agent applications                    | 0.1.0   |

The site is hosted on [GitHub Pages](HOSTING.md) only; a CI script enforces this.

## Connect a site

Bundle the SDK as an ES module, or load the browser bundle written to `dist-p2p/ai-auth.js`. Call `connectAIAuthModal` from a user gesture. The SDK does not enforce a gesture check, so this is a convention. The wallet appears as an in-page modal, shows the requested capabilities, and signs only the ones the visitor allows.

```js
import {
  connectAIAuthModal,
  mountAIAuthCollaboration,
} from "@enzovezzaro/ai-auth-wallet";

const connection = await connectAIAuthModal({
  walletUrl: "https://wallet.example/wallet/",
  capabilities: ["presence.read", "messages.send", "tools.invoke"],
  room: "project-room",
});

const stopCursors = mountAIAuthCollaboration(connection);
connection.onEvent((event) => {
  console.log(event.body.type, event.body.payload);
});

// When the page is done:
stopCursors();
connection.close();
```

Use HTTPS outside local development. The default room name is `default`. Peers find each other by the exact site origin and room name, combined into a shared topic hash. Pass `room` to use a separate space.

### Connect options

These are the fields of `AIAuthConnectOptions` from the public type declarations.

| Option            | Type                   | Meaning                                                                          |
| ----------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `walletUrl`       | `string`               | Required. URL of the wallet page.                                                |
| `capabilities`    | `string[]`             | Required. Capability names to request.                                           |
| `room`            | `string`               | Room name. Defaults to `default`.                                                |
| `origin`          | `string`               | Site origin used for the request. Defaults to the current origin.                |
| `timeoutMs`       | `number`               | Approval window timeout in milliseconds.                                         |
| `windowObject`    | `Window`               | Window to use for the modal.                                                     |
| `sessionTtlMs`    | `number \| null`       | Fixed session lifetime, or `null` for Never. Omit to let the wallet offer Never. |
| `idleTimeoutMs`   | `number \| null`       | Inactivity limit, or `null` for none.                                            |
| `participation`   | `{ policy, now? }`     | Gate remote tool requests through a participation policy.                        |
| `sessionStore`    | `AIAuthSessionStore`   | Store for resumable session records.                                             |
| `storage`         | `AIAuthSessionStorage` | Backing for the default session store.                                           |
| `resumeRecord`    | `AIAuthSessionRecord`  | Internal. Resume this record instead of asking for fresh consent.                |
| `resumeTimeoutMs` | `number`               | Timeout while confirming a resume.                                               |

## Session lifetime

A session with no lifetime set by the site is Never by default, and the wallet shows the choice. Never has no fixed end; it lasts until the visitor ends it, the site ends it, or someone revokes it. The wallet also offers 5, 15, 30, and 60 minute choices. A numeric cap rules out Never. A numeric session with no idle setting ends after 10 minutes without authorized activity. `connection.renew()` asks the owner to approve again; it can keep or narrow capabilities, never widen them.

## Resume after a refresh

A refresh or a closed tab ends the live connection. This is not a bug in the site. The site stores a record in that origin's `localStorage`, with public data only: the signed consent, the wallet public key, granted capabilities, ids, and activity times. The wallet keeps approved grants in IndexedDB. No private key, backup, or passphrase is written to the site record.

To resume, show a Resume action to the visitor. On click, list the saved records with `listResumableSessions` and then call `resumeAIAuthSession`. The SDK never resumes silently. The wallet rechecks the signed consent and confirms the session still exists, so a session the site or wallet ended cannot be revived. Resuming reuses the original grant; it does not re-grant or widen scope.

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

### Not yet available

Automatic reconnect on page load is not available. The SDK does not check stored records on load. Do not describe a silent restore as working. Resume is always one click after a refresh.

## Presence and cursors

Presence shows who is in the room. It is shown only for participants connected to the same origin room. `mountAIAuthCollaboration` draws cursors over the page:

```js
const stopCursors = mountAIAuthCollaboration(connection, {
  target: document.body,
  pageKey: "/workspace/42",
});
```

`pageKey` scopes cursors to one page. It defaults to `location.pathname` when omitted. Cursors use the canonical v1 payload (`ai-auth-cursor`, version 1) with a `pageKey` field; a null `pageKey` means site-wide. Coordinates are document-anchored: they are fractions of the document size and follow page scroll. A cursor only reports where an agent is working; it grants no ability to click or type.

## WebMCP tools

WebMCP is the in-page tool surface. The page registers tools with `registerAIAuthPageActions` and supplies an `authorize` callback, which is required and is the human decision gate. An agent discovers the published tool catalog and calls a tool through `ai_auth_invoke` after approval. A call runs only after the wallet scope check and the page's own approval step.

```js
await registerAIAuthPageActions({
  connection,
  actions: [
    {
      name: "workspace.summary",
      description: "Summarize the current workspace.",
      inputSchema: { type: "object", properties: {} },
      requiredCapability: "tools.invoke",
      execute: async () => ({ summary: "Site-specific result" }),
    },
  ],
  authorize: async (action, input, context) =>
    showApprovalDialog({
      action,
      input,
      sharedPublicly: context.sharedPublicly,
    }),
});
```

Signed tool requests, results, and action status are visible to connected peers. Never put secrets or private page data in the shared room.

### Tool error codes

These are the machine-readable codes in `TOOL_ERROR_CODES`, defined in `packages/p2p/webmcp.js` and used by the agent tool provider:

| Code                | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `TOOL_UNAVAILABLE`  | The tool is not available.                                   |
| `SITE_DISCONNECTED` | The site connection is gone.                                 |
| `CATALOG_EXPIRED`   | The tool catalog has expired.                                |
| `AUTH_EXPIRED`      | Authorization for the call has expired.                      |
| `CANCELLED`         | The call was cancelled.                                      |
| `TIMEOUT`           | The call timed out.                                          |
| `NOT_JOINED`        | The caller is not joined to the room.                        |
| `DENIED`            | The call was refused, including a peer refusal with no code. |

## Chat types

Human chat in the page and the collaboration wheel use `message/text` as the wire type, with an optional signed `target` and `messageId`. The older `collab/text` name is still accepted from older senders and earns the same signed delivery receipt.

## Code Mode

Code Mode (`ai_auth_code`) is opt-in with the `--code-mode` flag of `ai-auth-mcp`. Guest code runs in a worker thread with a kill timeout. It is not a security boundary by itself; do not rely on it to contain untrusted code.

## Limits

- No AI Auth server holds keys.
- WebRTC needs a relay to signal. No TURN server is configured, so restrictive NATs or firewalls can block direct connections.
- A refresh or a closed tab ends the live connection. Resume takes one click.
- Presence is shown only for participants connected to the same origin room.

Release status and remaining work are tracked in [the verification evidence](evidence.md) and [the changelog](../CHANGELOG.md).
