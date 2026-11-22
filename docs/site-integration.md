# Site integration

[← Back to the docs index](README.md)

This guide is for a website that wants to connect a wallet, show presence and cursors, and offer tools to agents. The site always enforces its own access rules. A room is a coordination boundary, not an authorization boundary.

## Packages

| Package                        | What it does                                                | Version |
| ------------------------------ | ----------------------------------------------------------- | ------- |
| `@enzovezzaro/ai-auth-wallet`  | Browser SDK, wallet dialog, collaboration, WebMCP bridge    | 0.12.2  |
| `@enzovezzaro/ai-auth-agent`   | Headless Node agent with an encrypted keystore and WebRTC   | 0.2.0   |
| `@enzovezzaro/ai-auth-mcp`     | `ai-auth-mcp` command and MCP tools for local coding agents | 0.3.9   |
| `@enzovezzaro/ai-auth-runtime` | Plugin host for local agent applications                    | 0.1.3   |

The version numbers above mirror each package's own `package.json`. The root `package.json` is the single source for the product release label; any version rendered in UI is generated from that source at build time or omitted from nontechnical UI.

The site is hosted on [GitHub Pages](HOSTING.md) only; a CI script enforces this.

## Connect agents (recommended)

A site never opens, hosts or picks a wallet. The agent carries its own wallet, on the machine where it runs. The site only needs a **Connect** button:

1. The visitor presses **Connect**. A popup checks whether an agent this browser connected before is in the site's room. That agent answers a fresh signed challenge and is connected straight away.
2. If no agent answers, the popup shows a **one-time connect link**. The visitor gives it to their agent, on this computer or another one.
3. The agent runs `npx -y @enzovezzaro/ai-auth-mcp serve --connect "<link>"`. If it has no identity yet, it first creates one on its own machine (`ai-auth-mcp init --new-identity`). Its owner approves the scopes in the agent's terminal (or with `--approve`). The site shows it as connected.
4. Both sides remember each other. Next time, the agent runs `ai-auth-mcp serve` with no arguments and reconnects; the site re-verifies it with a fresh challenge. No new link is needed.

```js
import {
  createAIAuthAgentLink,
  mountAIAuthAgentConnect,
  mountAIAuthInPageAgent,
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

// Optional: site tools that only connected agents can call.
await link.start();
await mountAIAuthInPageAgent({
  connection: link.toolConnection(),
  actions: [
    {
      name: "site.whoami",
      description: "Tell the calling agent which site this is.",
      inputSchema: { type: "object", properties: {} },
      requiredCapability: "tools.invoke",
      readOnly: true,
      execute: async (_input, { requester }) => ({
        site: location.origin,
        agent: link.agent(requester?.id),
      }),
    },
  ],
  authorize: async (action, input, { requester }) =>
    Boolean(link.agent(requester?.id)) && (await askTheVisitor(action, input)),
});
```

`link.state` has `phase` (`idle`, `checking`, `needs-link`, `connected`), the connected `agents` with the scopes both sides allowed, and the current `link`. `link.onChange(fn)` reports every change, and `link.forget(agentId)` stops trusting an agent in this browser.

What the link is and is not:

- **A one-time pass.** It admits one agent, expires after 10 minutes (at most 30), and belongs to one page session. Its secret sits in the URL fragment, which browsers never send to a server. Share it only with your own agent.
- **Never a wallet URL.** It names the site's origin, room, a short-lived site key and the scopes the site offers. The agent grants only scopes that its owner approves and the site offers.
- **The secret never enters the room.** The agent proves it holds the link with an HMAC over the site key, its own signed id and a fresh nonce. Both sides then derive a pair secret from the link code mixed with an ephemeral ECDH key exchange, so neither another peer in the room nor someone who later finds the used link can compute it. Reconnect challenges are authenticated with it in both directions: another peer in the open room can neither pose as the site to the agent nor as the agent to the site.
- **A claim by whoever shared it.** The link URL's origin must match the origin inside it, but nothing else proves who made it. Use links from the site's own Connect popup only. The site's tool catalog, like everything in an open room, is visible to every peer in the room; only connected agents can call the tools.
- **Remembered per browser.** The site keeps each agent's public id, name, scopes and pair secret in its origin's `localStorage`. The agent keeps the site in `linked-sites.json` (mode `0600`) next to its keystore.

A runnable version is the [agent connect example](/agent-link/), and its real end-to-end test (`npm run test:agent-link`): real Chromium, the real `ai-auth-mcp` CLI, and real Nostr/WebRTC.

## Connect a person's browser wallet

`connectAIAuthModal` below is a different flow: a person brings a browser wallet so the site can show their presence and cursor. Agents do not need it; use connect links above.

### Connect a site

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

For a runnable, minimal version of this exact flow — one **Connect agent** button, a real in-page wallet approval, effective scopes only, peers and signed events — see the [minimal host site example](/host-site/README.html) and its real end-to-end test (`npm run test:host-site`). It covers only the external wallet connection; identity setup is a separate flow documented in the [Connect Agent acceptance plan](CONNECT_AGENT_E2E_ACCEPTANCE.md).

In that example every peer row is labelled `signed presence — not authorized`. The site sees signed hello/heartbeat events in an open room but does not verify the owner's membership authority for other peers, so a peer in the list is presence only, never a site grant. Full wallet and agent ids are masked in the example UI and in the wallet's developer panes; only an explicit copy/export action uses the unmasked signed envelope. The same rule applies everywhere in this product: a room is a coordination boundary, not an authorization boundary.

### Connect options

These are the fields of `AIAuthConnectOptions` from the public type declarations.

| Option            | Type                   | Meaning                                                                                                                   |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `walletUrl`       | `string`               | Required. URL of the wallet page.                                                                                         |
| `capabilities`    | `string[]`             | Required. Capability names to request.                                                                                    |
| `room`            | `string`               | Room name. Defaults to `default`.                                                                                         |
| `origin`          | `string`               | Site origin used for the request. Defaults to the current origin.                                                         |
| `timeoutMs`       | `number`               | Approval window timeout in milliseconds.                                                                                  |
| `windowObject`    | `Window`               | Window to use for the modal.                                                                                              |
| `sessionTtlMs`    | `number \| null`       | Fixed session lifetime, or `null` for Never. Omit to let the wallet offer a bounded default and an explicit Never choice. |
| `idleTimeoutMs`   | `number \| null`       | Inactivity limit, or `null` for none.                                                                                     |
| `participation`   | `{ policy, now? }`     | Gate remote tool requests through a participation policy.                                                                 |
| `sessionStore`    | `AIAuthSessionStore`   | Store for resumable session records.                                                                                      |
| `storage`         | `AIAuthSessionStorage` | Backing for the default session store.                                                                                    |
| `resumeRecord`    | `AIAuthSessionRecord`  | Internal. Resume this record instead of asking for fresh consent.                                                         |
| `resumeTimeoutMs` | `number`               | Timeout while confirming a resume.                                                                                        |

## Session lifetime

At the protocol level a session with no lifetime is Never: no fixed end, until the visitor ends it, the site ends it, or someone revokes it. In the wallet approval UI, first use pre-selects a bounded 30-minute session (or the site's smaller cap). The owner can choose 5, 15, 30, or 60 minutes, or the explicit "Until I disconnect" choice, which has no time or idle limit. A numeric cap rules out Never. Explicit `sessionTtlMs: null` still means Never when the site permits it and the owner chooses it. A numeric session with no idle setting ends after 10 minutes without authorized activity. `connection.renew()` asks the owner to approve again; it can keep or narrow capabilities, never widen them.

The first-use default decision is resolved (P1-15); see [Session and connection lifecycle](lifecycle.md#design-decision-bounded-first-use-default-p1-15). Saved grants, renewals, signature verification and the protocol meaning of `null` are unchanged.

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
