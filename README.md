# AI Auth

AI Auth is a local-first service for agent identity, live presence, room messaging, task handoff, advisory resource locks, and persistent audit history. This repository contains an early, working local MVP. External identity providers and the full product vision are not implemented.

## Start locally

Requires Node.js 22+ and npm. No paid credentials or external database are required.

```sh
npm ci
npm run dev
```

The API listens at `http://127.0.0.1:3333`, persists to `./data/ai-auth.sqlite`, and serves the dashboard at `/dashboard`. `AI_AUTH_DB` changes the database file. Browser origins are blocked by default; set `CORS_ORIGIN` to an explicit comma-separated allowlist. Set `HOST=0.0.0.0` only for local network access.

Open `/demo` for the local website with the explicit WebMCP test tool, `/docs` for the short guide, and `/dashboard` for authenticated activity.

## Register and connect an agent

```sh
curl -s http://127.0.0.1:3333/v1/agents/register \
  -H 'content-type: application/json' \
  -d '{"name":"Writer","runtime":"example-runtime","category":"autonomous_agent"}'
```

The bearer token is shown only once; only its SHA-256 hash is stored. Categories distinguish autonomous agents, browser automation, simulated test clients, and human users. These local credentials are not OIDC identities. Registration is intentionally open for a single-user development service and must not be exposed publicly.

Authenticated endpoints use `Authorization: Bearer <token>`. The SDK obtains a one-use, room-bound WebSocket ticket that expires after 30 seconds. The legacy token-in-URL path remains for local-only compatibility. Public sessions can exchange messages/tasks/locks in shared rooms. A private session is omitted from public presence, connection events, and counters, and is blocked from shared room writes. Private state still creates restricted per-agent security audit records.

## Website snippet

Serve the SDK from the local service:

```html
<script
  src="http://localhost:3333/sdk/ai-auth.js"
  data-site="my-website"
  defer
></script>
<script>
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      AIAuth.init({
        baseUrl: "http://localhost:3333",
        token: agentToken,
        room: "workspace",
      });
      AIAuth.presence.subscribe((event) => console.log(event));
    },
    { once: true },
  );
</script>
```

The script alone does not authenticate a website visitor or create files/routes on the website's origin. The token must come from a trusted agent runtime. Do not embed a privileged long-lived credential in public HTML.

## Local functionality

- `POST /v1/agents/register`, `GET /v1/me`, `POST /v1/revoke`, `POST /v1/status`
- `GET /v1/presence?room=workspace`, `GET /v1/events?token=…&room=…`
- Room messages, task creation and updates, advisory locks with 5–300 second leases
- Per-agent `GET /v1/audit`; authenticated summary at `GET /v1/analytics`
- `/.well-known/ai-auth`, `/agents.txt`, `/dashboard`, `/sdk/ai-auth.js`
- `GET /demo` serves the explicitly authored demo site; `AIAuth.webmcp` uses native WebMCP when present and an in-page compatibility adapter otherwise
- `npm run dev:mcp` starts an official-SDK MCP stdio server when `AI_AUTH_TOKEN` is set; it uses the same authenticated API

For MCP, first start the API and register an agent, then configure your MCP client to launch `npm run dev:mcp` with `AI_AUTH_TOKEN` set to that agent's token. `AI_AUTH_URL` defaults to `http://127.0.0.1:3333`. The token is process configuration and is not accepted as a tool parameter.

## Install from npm

The server package is `@enzovezzaro/ai-auth-server`; the browser SDK package is `@enzovezzaro/ai-auth`. Install the server package and run `npx ai-auth-server`. For a script tag, serve `/sdk/ai-auth.js` from the server or use the SDK package's `./script` export. The SDK module entry is browser-only and expects `window` and `document`.

Locks are coordination hints; the protected website must enforce its own transaction or authorization. Room/site isolation and administrator roles are not yet implemented: this is a single-site local service. Audit rows are durable SQLite records but are not tamper-evident. Cursor sharing, OpenTelemetry, external OIDC, and autonomous LLM browser-agent workflows are not implemented. MCP stdio and the demo's native WebMCP tool have been exercised locally; this does not imply remote MCP authorization or general browser compatibility.

## Checks

```sh
npm test
npm run test:security
npm run test:load
npm run typecheck
npm run build
npm run format:check
```

See [the protocol](docs/PROTOCOL.md), [API reference](docs/API.md), [security notes](docs/SECURITY.md), [MCP guide](docs/MCP.md), [WebMCP guide](docs/WEBMCP.md), [research record](docs/RESEARCH.md), and [test record](docs/TESTING.md). The [machine-readable test report](docs/test-report.json) lists passed and unrun work separately.
