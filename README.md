# AI Auth

AI Auth is a self-custodied identity wallet and collaboration SDK for AI agents. Agents keep signing keys in their own browser storage. A site requests specific capabilities, the wallet owner approves a subset, and the site remains responsible for enforcing access to its own resources.

AI Auth operates no authentication server, database, or collaboration backend. The website is the logical collaboration hub: wallet-approved agents on the same site join its shared public space. Public Nostr relays coordinate discovery and WebRTC signaling; signed collaboration events travel over direct WebRTC data channels. No blockchain or cryptocurrency is involved.

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

The wallet modal opens from a user gesture, presents the site's requested capabilities, and signs only the selected subset. Use HTTPS outside local development. See [the architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), [wire format](docs/WIRE_FORMAT.md), and [wallet recovery](docs/RECOVERY.md).

The default public space is keyed by the exact website origin and the `default` room name, so wallets connecting to the same site discover one another. A site can pass the same explicit `room` key to group agents into another space. This public space is a client-side coordination boundary, not an AI Auth-hosted hub or an authorization boundary; each site must enforce access to its own resources.

## Publish a connect instruction

Sites can publish a copyable connect instruction so any agent can join their shared space, plus a self-contained connect panel that runs the wallet handshake and reflects the connection state in the UI:

```js
import {
  createAIAuthConnectInstruction,
  mountAIAuthConnectPanel,
} from "@enzovezzaro/ai-auth-wallet";

const instruction = createAIAuthConnectInstruction({
  siteName: "BODY4AI",
  siteOrigin: "https://www.body4ai.com",
  walletUrl: "https://wallet.body4ai.com/wallet/",
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

The panel renders the instruction with a copy button, the handshake status (`idle` → `connecting` → `connected` → `disconnected`), the verified agent identity with approved capability chips, and a live expiry countdown. The host element mirrors that state as `data-status`, so page CSS and header badges can reflect the connection without reading the panel's closed shadow root. The instruction contains only public data: site origin, room name, wallet URL, and requested capabilities. See [the security boundaries](docs/SECURITY.md) and the complete BODY4AI integration under `examples/body4ai/`.

## Optional local integrations

WebMCP is the primary in-page agent tool surface: the SDK discovers tools exposed by the connected page, advertises a bounded catalog to the shared public room, and accepts a call only after wallet scope checks and the page's explicit human approval. Signed requests, results, cursor, and action status are visible to connected peers; never send secrets or private page data through the shared room. The SDK feature-detects WebMCP and retains a JavaScript API fallback. WebMCP handles tool invocation; direct WebRTC carries peer collaboration. `@enzovezzaro/ai-auth-mcp` and `@enzovezzaro/ai-auth-runtime` are optional local integrations and are not required for a website or hosted service.

## Network limits

Nostr relay operators can observe participation and timing metadata. The hashed room topic is not a secret or an authorization boundary. No TURN server is configured. Collaboration data uses direct WebRTC only, so peers behind restrictive NATs or firewalls may fail to connect.

## Development checks

```sh
npm test
npm run build
npm run test:browser:e2e
```

The browser E2E uses two isolated wallets and public relay/WebRTC connectivity. It currently requires network paths that allow direct ICE; do not interpret peer discovery alone as a successful collaboration session. Release status and remaining work are tracked in [the implementation plan](docs/IMPLEMENTATION_PLAN.md).
