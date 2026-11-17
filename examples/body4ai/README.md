# BODY4AI — agent connect integration

> **Demo example only.** This folder is a sample consumer of the AI Auth SDK,
> not the real or official Body4AI site or production code. The live Body4AI
> website (body4ai.com) is maintained separately in its own repository; nothing
> here is deployed to it.

This demo shows everything an agent needs to connect to a Body4AI-style
catalog using the `@enzovezzaro/ai-auth-wallet` SDK: a copyable connect
instruction, the signed wallet handshake, and a connect panel whose UI reflects
the live connection state. Nothing here starts a chat session with external
agents, and there is no `/mcp` server endpoint — WebMCP is the in-page tool
surface and the wallet handshake authenticates the agent.

## 1. Install or bundle the SDK

```sh
npm install @enzovezzaro/ai-auth-wallet
```

Or load the prebuilt browser bundle from your static wallet host:

```html
<script type="module">
  import * as AIAuth from "https://esm.sh/@enzovezzaro/ai-auth-wallet";
  window.AIAuth = AIAuth;
</script>
```

## 2. Add a mount point

In a real Body4AI integration you would replace the old "BODY4AI MCP / READ
ONLY" section with the block below: remove all three traces of the endpoint in
that block — the `/mcp` URL, its copy button, and any copy that says "This
endpoint" or "The MCP reads the published catalog". WebMCP has no endpoint and
no connection URL. This demo does not modify the live site.

```html
<section id="agent-connect" aria-labelledby="agent-connect-heading">
  <p><strong>BODY4AI WEBMCP / IN-PAGE · READ ONLY</strong></p>
  <h2 id="agent-connect-heading">Connect your agent to the catalog.</h2>
  <p>
    This demo page registers WebMCP tools that agent-capable browsers can
    discover and invoke when it is served locally. The live body4ai.com site is
    maintained separately. There is no endpoint and no URL to connect to:
    agents search products, open product pages, compare devices,
    and find review sources directly in the page, and only with your explicit
    approval.
  </p>
  <p>
    <strong>AVAILABLE TOOLS</strong>
    <code
      >search_products · get_product · compare_products ·
      get_purchase_link</code
    >
  </p>
  <p>
    WebMCP reads the published catalog in the page itself; it does not start a
    chat session with external agents.
  </p>
  <div id="body4ai-connect-panel"></div>
</section>
```

## 3. Mount the connect panel

To adapt this pattern in your own site repository, copy `agent-connect.js`
into that repo (e.g. `src/agent-connect.js`) and import it from the page:

```html
<script type="module">
  import { mountBody4AIAgentConnect } from "./src/agent-connect.js";
  mountBody4AIAgentConnect({
    target: document.getElementById("body4ai-connect-panel"),
  });
</script>
```

The panel then handles the full flow with no further wiring:

1. **Copy instruction** — visitors copy the canonical connect instruction
   (public data only: origin, room, wallet URL, capabilities) and paste it
   into any agent's browser page.
2. **Connect agent** — a user gesture opens the wallet modal; the signed
   handshake completes when the wallet owner approves the requested
   capabilities.
3. **Connected state** — the panel badge switches to CONNECTED with the
   verified agent identity, approved capability chips, and a live expiry
   countdown; DISCONNECTED / EXPIRED appear when the wallet closes or the
   grant lapses.

The demo site in `site/` does not use the wallet modal. It keeps the wallet in
the page and shows one approval dialog that lists the requested permissions;
the visitor can untick any of them, and Escape or "Don't allow" cancels. The
site draws its own panel so its status text and buttons use plain words (for
example "Connected. Waiting for other visitors or agents."). Renewal is
"Extend for 30 more minutes", and a declined extension keeps the current
session until its end time.

## 4. Reflect the connection elsewhere in the page

The panel is the source of truth. Its host element mirrors the live state as
`data-status` (`idle`, `connecting`, `connected`, `disconnected`), so CSS can
react without reading the panel's closed shadow root:

```css
body:has([data-ai-auth-connect-panel][data-status="connected"]) .agent-badge {
  color: #245d4e;
}
```

To also badge the site header from JS, subscribe:

```js
const remove = mountBody4AIAgentConnect({
  target: document.getElementById("body4ai-connect-panel"),
  onStateChange: (state) => {
    // state.status: "idle" | "connecting" | "connected" | "disconnected"
    document.body.toggleAttribute(
      "data-agent-connected",
      state.status === "connected",
    );
  },
});
```

## 5. Host the wallet

The wallet must be served over HTTPS on its own origin (local development may
use `localhost`). In this SDK repo: `npm ci && npm run build`, then deploy
`dist-p2p/` and `wallet/` as static files and point `WALLET_URL` in
`agent-connect.js` at the deployed `/wallet/` path.

## Security notes

- The connect instruction contains no secrets; it is the public connection
  descriptor (origin, room, capabilities, wallet URL).
- Every connection is authenticated by an ECDSA P-256 wallet signature over
  the site's permission request; the panel only ever displays data from
  verified lifecycle events.
- WebMCP tool calls additionally require the page's human approval callback,
  and catalogs, requests, and results are visible to peers in the site's
  shared public space — never include private page data in tool results.
