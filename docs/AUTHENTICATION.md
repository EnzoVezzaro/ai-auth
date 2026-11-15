# Authentication

## Local development adapter

`POST /v1/agents/register` issues a random opaque bearer token with a 12-hour lifetime and stores only its SHA-256 digest. Registration is open in this local MVP and must not be exposed publicly. Revoke the current agent credential with `POST /v1/revoke`. The local token is not OAuth, OIDC, JWT, auth.md identity assertion, or proof-of-possession.

## Generic OIDC JWT access tokens

The API can additionally accept a provider-issued signed JWT access token when all three administrator-controlled variables are configured: `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_JWKS_URL`. Verification uses `jose` with RS256 or ES256 only, exact issuer and audience matching, required `sub`/`iat`/`exp` claims, and a five-second clock tolerance. No identity fields are used before signature and claim verification. Never set the JWKS URL from user input or token claims.

After verification, the service maps `(issuer, subject, authorized party/client ID)` to one persistent local agent identity. It uses signed `agent_name`, `agent_runtime`, `agent_category`, and `ai_auth_private` claims only; unknown categories become `human`. A human principal and an agent identity remain separate concepts, but this MVP does not implement owner or organization records. Identity mapping is tested against a local generated JWKS issuer; it is not a Keycloak or commercial-provider validation.

This adapter verifies bearer JWTs and does not implement interactive OIDC login, discovery, authorization-code/PKCE, dynamic client registration, scope-based per-operation authorization, token exchange, refresh, introspection, or provider-side revocation. A provider token remains valid until its own expiry unless its identity is revoked in AI Auth. Keep access tokens short-lived and API-audience restricted. Provider adapters for WorkOS, Clerk, Auth0, Keycloak, Supabase, and Vercel Connect are not claimed as operational.

## WebSocket authentication

The SDK calls `POST /v1/events/ticket` with its bearer credential and room. The server returns a random, one-use ticket bound to that agent and room for 30 seconds; the SDK sends only the ticket in the WebSocket URL. This reduces exposure of the longer-lived bearer token in URL logs. The ticket is process-local and disappears on restart. For compatibility with existing local tests/clients, `/v1/events?token=...&room=...` remains accepted for local opaque credentials; do not use this legacy form outside localhost. OIDC clients must use the ticket route.

## Standards boundaries

The auth.md repository offers a discoverable registration and claim proposal; it is not treated as a finalized universal authentication standard. WebMCP provides page capability registration, not authentication. MCP authorization is separate from the AAPP WebSocket presence transport. Vercel Connect is a delegated connection/credential product and must not be treated as interchangeable with a human identity provider.
