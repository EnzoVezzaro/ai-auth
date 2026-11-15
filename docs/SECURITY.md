# Security notes and threat model

## Current local controls

- Local credentials are generated from 256 random bits, expire after 12 hours, and only SHA-256 hashes are stored. Registration returns the plaintext once. Revocation invalidates HTTP use and closes active sockets. An optional generic OIDC JWT verifier validates issuer, audience, signature, expiry, and required claims before mapping an identity.
- Request bodies are limited to 16 KiB. Zod validates route inputs; SQLite queries are parameterized. CORS defaults to disabled. WebSockets validate a supplied origin against `CORS_ORIGIN` when an Origin header is present.
- Private sessions are filtered from public presence/broadcasts/counters and cannot publish into shared rooms. Shared collaboration data is not tenant-isolated in this version.
- The SDK authenticates WebSockets with a one-use, room-bound ticket expiring in 30 seconds. A legacy query-token path remains for local opaque credentials and should not be used outside localhost.
- No bearer token is included in audit payloads.

## Material limitations

This is a localhost development service, not a secure multi-tenant deployment. Registration is unauthenticated. The optional OIDC adapter verifies JWT access tokens only; interactive OIDC, PKCE, per-action scopes, provider-side revocation, external provider integration tests, and tenant isolation are absent. There is no admin/user organization model, CSRF-protected cookie flow, distributed rate limit, signed/tamper-evident audit chain, encryption-at-rest key management, retention policy, OpenTelemetry, or production secret management. CORS origin checking does not replace authentication and a missing Origin header is allowed for non-browser clients. Private mode is claim/self-declared and not an organization policy. AAPP connections and presence are process-local.

Do not bind to a public interface, use real credentials, expose privileged agent tokens in browser code, or treat a lock as enforcement of a protected resource. Before deployment, replace open registration with an administrator-controlled provisioning/OIDC flow, use short-lived audience/scope-restricted credentials, add tenant and room authorization on every query, secure WebSocket ticket exchange, rate limits, CSP guidance, audit integrity/retention, and external security review.

## Threat coverage status

Input validation, credential hashing, direct agent identity assignment, revocation, basic private event filtering, parameterized SQL, and lock conflict transactions have code paths. Automated coverage currently checks missing credentials, messaging identity, private visibility/counters, lock conflicts, and revocation. Token replay, origin bypass, cross-tenant access, rate limiting, malicious MCP descriptions, XSS at integration sites, and distributed races are not comprehensively tested or solved.
