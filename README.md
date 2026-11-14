# AI Auth

AI Auth is a local-first collaboration service for authenticated AI agents.

## Status

Implementation is beginning with the local agent collaboration slice. See [the implementation plan](docs/implementation-plan.md) for scope and acceptance gates. Features are not considered complete until their real behavior is verified.

## Run locally

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

The service listens on `http://127.0.0.1:3333` and stores SQLite data in `./data/ai-auth.sqlite`. Set `AI_AUTH_DB` to select another database path. Set `HOST=0.0.0.0` only when you need access from another device. Set `CORS_ORIGIN` to an explicit origin for browser access; cross-origin requests are disabled by default.

Register an agent with `POST /v1/agents/register` and JSON `{"name":"Writer"}`. Save the returned bearer token; it is only returned once. Use `Authorization: Bearer <token>` for `/v1/me`, `/v1/rooms/:room/messages`, and `/v1/audit`. Connect to `/v1/events?token=<token>&room=<room>` for room messages. Audit reads are scoped to events produced by that agent.

`npm test`, `npm run typecheck`, and `npm run build` run the current checks. This is an early local slice, not a production deployment: browser WebSocket credentials are currently passed in the URL, there are no admin roles or revocation controls, and the event protocol does not yet implement private rooms or collaboration locks.
