# AI Auth Worker (local prototype)

This Worker is a local implementation of the wallet-authenticated service API. It is not deployed. The stable `@enzovezzaro/ai-auth-wallet@0.1.1` does not include the service SDK; the preview `@enzovezzaro/ai-auth-wallet@next` (`0.2.0-beta.4`) includes it at `/service`.

The Worker obtains identity, authorization, storage, presence, transport and observability behavior through the `@enzovezzaro/ai-auth-runtime` plugin API v2. The identity plugin derives the agent ID used to verify signed consent; the authorization plugin checks exact session scopes; tenant state, presence and transport resolve through separate provider contracts. The runtime ships both an exact-scope authorizer and a synchronous callback policy provider. See [runtime contracts](../../packages/runtime/README.md).

## Run locally

From this directory:

```sh
npm ci
npm test
npm run dev
```

Wrangler serves the API locally on port `8787`. `wrangler.jsonc` allows the wallet app origins `http://localhost:4173` and `http://127.0.0.1:4173` plus the existing static Vercel origin. Change the exact allowlist before using another origin.

## API

All routes use the `/v1` prefix. Protected HTTP requests send the short-lived session token as `Authorization: Bearer <token>`.

| Route                                      | Required capability    | Purpose                                                                                                           |
| ------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /health`                              | —                      | Check that the Worker can query durable authorization storage.                                                    |
| `POST /auth/challenge`                     | —                      | Create a signed-consent challenge bound to an allowlisted application origin and explicit requested capabilities. |
| `POST /auth/session`                       | —                      | Verify wallet consent and issue a 15-minute opaque session token.                                                 |
| `POST /auth/session/revoke`                | —                      | Revoke the token in the authorization header.                                                                     |
| `POST /tenants`                            | `tenant.create`        | Create an isolated workspace.                                                                                     |
| `DELETE /tenants/:id`                      | `tenant.delete`        | Delete an owned workspace and its active registration.                                                            |
| `POST /tenants/:id/invitations`            | `tenant.invite`        | Store an owner-signed, recipient-bound delegation.                                                                |
| `DELETE /tenants/:id/invitations/:grantId` | `tenant.invite`        | Revoke an invitation before it is used.                                                                           |
| `DELETE /tenants/:id/members/:agentId`     | `tenant.member.revoke` | Revoke a member and close their active sockets.                                                                   |
| `POST /tenants/:id/join`                   | `tenant.join`          | Accept a signed invitation once.                                                                                  |
| `GET /tenants/:id/rooms/:room/messages`    | `messages.read`        | Read the latest 100 room messages.                                                                                |
| `POST /tenants/:id/rooms/:room/messages`   | `messages.write`       | Add a message and broadcast it to authorized sockets.                                                             |
| `GET /tenants/:id/rooms/:room/events`      | `presence.read`        | Open an origin-checked WebSocket, then authenticate in its first frame.                                           |

For WebSockets, browser clients cannot set an Authorization header. The first client frame must be `{"type":"authenticate","token":"…"}` within ten seconds. The token is never placed in the URL. Authenticated clients may send `presence.update` and `message.send` events; the server checks session and tenant membership again before each protected action.

## Current limits

- The Worker emits structured request-start and completion logs with an allowlisted method and route group, response status, and duration. It omits raw paths, tenant/room identifiers, query strings, origins, client IPs, and credentials. Logging is best-effort; durable metric aggregation, export, dashboards and alert delivery are not configured.
- SQLite state is partitioned by tenant Durable Object. The local integration suite aborts all Durable Objects and confirms that tenant membership, messages, and sessions survive instance reinitialization. Behavior on Cloudflare's managed runtime still needs a deployed smoke test.
- Challenge issuance is limited to 60 requests per client IP and audience per minute, with bounded rate-limit keys and pending challenges. The authorization directory caps active sessions and tenant registrations, plus lifetime tenant creations at 10,000 globally and 100 per wallet identity. Deleting a workspace does not reset those lifetime quotas; they bound storage churn on free service tiers.
- WebSocket upgrades are limited to 4 per client IP in each 10-second window. Within a tenant, each agent may publish 30 presence updates and write 60 messages per minute; the tenant-wide ceilings are 300 presence updates and 600 message writes per minute. Limits use fixed windows and are enforced in the durable authorization/workspace objects.
- Each tenant stores at most 1,000 active invitations. Expired and revoked invitations are purged when a new invitation is issued; consumed-grant replay records remain until the signed grant expires. Only the tenant owner can delete a workspace.
- Each tenant retains at most 1,000 messages and 5,000 audit events. These oldest-first retention limits bound local SQLite growth; they are not an archival or backup policy.
- Unauthenticated WebSockets are limited to 10 pending connections per tenant, total tenant sockets to 200, and authenticated sockets to 10 per agent. The per-IP upgrade quota prevents a single source from filling the pending pool. Unknown tenant IDs are rejected before the workspace Durable Object is selected.
- There is no member listing UI, reconnect/resync protocol, backup/restore procedure, or production deployment.
- Each tenant has one owner. Only that owner may issue invitations, revoke members, or delete the workspace.
- The service SDK is available in the published `@enzovezzaro/ai-auth-wallet@next` preview at `@enzovezzaro/ai-auth-wallet/service`. Fresh isolated registry installs verify the package exports; the preview still targets a local Worker because no hosted service is available.
- Wrangler deployment is intentionally gated. The current local environment has no authenticated Cloudflare account, and production deployment needs free-account/billing verification.
