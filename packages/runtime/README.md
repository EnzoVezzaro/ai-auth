# AI Auth runtime

`@enzovezzaro/ai-auth-runtime` provides the provider-neutral plugin host used by the AI Auth service. It does not bundle an identity service, database, or transport.

## Plugin API v2

Each plugin declares a unique `id`, a `slot`, `apiVersion: PLUGIN_API_VERSION`, an `implementation` that meets the slot contract, and an `initialize(context)` function. The `AnyAIAuthPlugin` input type is a discriminated union, so TypeScript rejects an implementation paired with the wrong slot. A plugin may also declare `dependsOn` IDs and a `close()` function.

| Slot            | Required implementation method                       | Contract                                              |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| `identity`      | `identify(publicKey)`                                | Resolve a public key to its stable agent identity.    |
| `authorization` | `allows(subject, capability, resource?)`             | Return `true` only when the exact request is allowed. |
| `storage`       | `getTenant(tenantId)`                                | Resolve the durable tenant storage handle.            |
| `presence`      | `getTenant(tenantId)`                                | Resolve the tenant presence handle.                   |
| `transport`     | `forwardTenant(tenant, path, method, data, request)` | Forward a checked operation to a tenant service.      |
| `observability` | `record(event, fields?)`                             | Record a sanitized operational event.                 |

The default host requires identity, authorization, storage, presence, and transport. Observability is optional. `createPluginHost` checks slot and method contracts before starting any plugin, starts dependencies first, and closes initialized plugins in reverse order. Startup errors do not expose provider exceptions; shutdown reports failed plugin IDs without serializing provider errors.

## Authorization providers

The runtime includes two synchronous authorization implementations that share the `allows` contract:

```js
import {
  createCallbackAuthorizationProvider,
  createScopeAuthorizationProvider,
} from "@enzovezzaro/ai-auth-runtime";

const sessionScopes = createScopeAuthorizationProvider();
const applicationPolicy = createCallbackAuthorizationProvider(
  (session, capability, resource) =>
    session.tenant === resource && session.capabilities.includes(capability),
);
```

The scope provider checks exact membership in `subject.capabilities` and rejects empty or non-string capability names. The callback provider also rejects malformed names and allows only the literal boolean `true`; `false`, `undefined`, promises, and other return values deny access. Policies are synchronous so callers cannot accidentally forget to await an asynchronous authorization check.

## Trust boundary

Plugins execute as trusted code in the host process. The host verifies shape, lifecycle ordering, and dependency consistency; it does not sandbox plugins or verify their business logic. A website or service must still enforce authorization on every protected operation.

The preview is published as `@enzovezzaro/ai-auth-runtime@0.1.0-beta.0` on npm's `next` tag. Install it with `npm install @enzovezzaro/ai-auth-runtime@next`. Its registry tarball and exports pass an isolated clean install. The API may change before a stable release. See the [AI Auth architecture](../../docs/ARCHITECTURE.md) for the deployed-target plan and current limitations.
