# BODY4AI demo

This is a demo consumer of the AI Auth SDK. It is not the live Body4AI site and nothing here is deployed to body4ai.com. The site files live in `site/`.

The demo shows a catalog, a copyable connect instruction, an in-page approval dialog, presence, cursors, chat and WebMCP tools. There is no `/mcp` endpoint and no connection URL. WebMCP tools are registered inside the page, and the visitor approves each call.

## Run it locally

From the repository root:

```sh
npm ci
npm run dev
```

Then open `http://127.0.0.1:4173/body4ai/`. The wallet is at `http://127.0.0.1:4173/wallet/`. `npm run dev` builds `dist-p2p/` and serves it as static files. HTTP is allowed only for localhost. A deployed site must use HTTPS.

For the full multi-agent browser test, run `npm run test:e2e:body4ai`.

## Use the SDK in your own site

Install `@enzovezzaro/ai-auth-wallet` and follow the [site integration guide](../../docs/site-integration.md). The connect instruction carries only public data: origin, room, wallet URL and capabilities. A signature proves control of a key, not a human identity. Tool calls also need the page's own approval step, so keep private data out of tool results. See [security](../../docs/SECURITY.md) and the [agents guide](../../docs/agents.md) for local agents.

## Hosting

This repository deploys to GitHub Pages only. A CI guard, `scripts/verify-pages-only.mjs`, rejects Vercel configuration and checks the Pages workflow. See [hosting](../../docs/HOSTING.md).
