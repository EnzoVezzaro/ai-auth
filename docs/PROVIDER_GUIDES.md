# Provider adapter status

The current build contains only its local development credential flow. No external provider is wired or integration-tested.

- **Generic OIDC:** not implemented; an adapter needs issuer discovery, audience validation, JWKS signature verification through a maintained library, and explicit scope mapping.
- **Keycloak:** not configured or tested as a local OIDC provider.
- **WorkOS:** auth.md was reviewed as an evolving agent registration/discovery protocol; no WorkOS API or auth.md claim flow is implemented.
- **Clerk:** not implemented or tested.
- **Vercel Connect:** not implemented. Delegated service connections must be modeled separately from user/agent identity.
- **Auth0 and Supabase Auth:** not implemented or tested.

Do not label a provider operational based on this document. The local flow is not a substitute for OIDC.

## Generic OIDC and local Keycloak

The current generic adapter validates provider-signed JWT access tokens (see [AUTHENTICATION.md](AUTHENTICATION.md)); it does not perform browser login or PKCE. The local Keycloak test realm is in `infra/keycloak/realm.json`; run `npm run test:keycloak` with Docker available. It uses the Keycloak 26.8.2 container and a local-only client secret. This integration script is provided but has not passed in the current environment because the Docker daemon was unavailable. WorkOS, Clerk, Auth0, Supabase, and Vercel Connect are not implemented or verified adapters.
