# AI Auth local agent runtime

`@enzovezzaro/ai-auth-runtime` is a provider-neutral plugin host for local agent applications. It does not start an HTTP server, open a socket, create an account, or depend on an AI Auth backend. The host supplies each identity, policy, storage, presence, and transport adapter.

## Plugin API v2

Each plugin declares a unique `id`, a `slot`, `apiVersion: PLUGIN_API_VERSION`, an `implementation` that meets its slot contract, and an `initialize(context)` function. A plugin may declare `dependsOn` IDs and a `close()` function.

| Slot            | Required method                                      | Local adapter contract                                   |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `identity`      | `identify(publicKey)`                                | Resolve a key to its stable agent identity.              |
| `authorization` | `allows(subject, capability, resource?)`             | Return `true` only for the exact permitted operation.    |
| `storage`       | `getTenant(tenantId)`                                | Resolve a host-owned local workspace store.              |
| `presence`      | `getTenant(tenantId)`                                | Resolve a host-owned presence view.                      |
| `transport`     | `forwardTenant(tenant, path, method, data, request)` | Forward through a host-selected local or peer transport. |
| `observability` | `record(event, fields?)`                             | Record a sanitized local event.                          |

The default host requires identity, authorization, storage, presence, and transport. Observability is optional. `createPluginHost` validates slot and method contracts before startup, starts dependencies first, and closes initialized plugins in reverse order. Plugins run as trusted code and are not sandboxed.

## Authorization helpers

`createScopeAuthorizationProvider()` checks exact membership in `subject.capabilities`. `createCallbackAuthorizationProvider(policy)` accepts only a synchronous literal `true` (`policy(...) === true`): promises and other non-`true` return values deny access, but a policy that throws propagates its exception, since the call is not wrapped in `try/catch`. Callers that need a denial instead of a thrown error must catch it themselves.
