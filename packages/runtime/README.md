# @enzovezzaro/ai-auth-runtime

A provider-neutral plugin host for local agent applications. Version 0.1.3.

This package does not start a server, open a socket, create an account or depend on an AI Auth backend. The host supplies each identity, policy, store, presence view and transport.

## Plugin API v2

Each plugin declares a unique `id`, a `slot`, `apiVersion: PLUGIN_API_VERSION`, an `implementation` for that slot and an `initialize(context)` function. A plugin may declare `dependsOn` ids and a `close()` function.

| Slot            | Required method                                      | What the adapter does                        |
| --------------- | ---------------------------------------------------- | -------------------------------------------- |
| `identity`      | `identify(publicKey)`                                | Resolve a public key to a stable agent id.   |
| `authorization` | `allows(subject, capability, resource?)`             | Allow only the exact permitted operation.    |
| `storage`       | `getTenant(tenantId)`                                | Resolve a host-owned local workspace store.  |
| `presence`      | `getTenant(tenantId)`                                | Resolve a host-owned presence view.          |
| `transport`     | `forwardTenant(tenant, path, method, data, request)` | Forward through a host-selected local route. |
| `observability` | `record(event, fields?)`                             | Record a sanitized local event.              |

The default host requires identity, authorization, storage, presence and transport. Observability is optional.

`createPluginHost(plugins, options)` validates the slots and methods before startup. It starts dependencies first. If startup fails, it closes the plugins that already initialized in reverse order. `host.get(slot)` returns a plugin, and `host.close()` closes them all.

Plugins run as trusted code. They are not sandboxed.

## Authorization helpers

`createScopeAuthorizationProvider()` allows a capability only when it appears in `subject.capabilities`.

`createCallbackAuthorizationProvider(policy)` allows a call only when `policy(subject, capability, resource) === true`. Promises and other return values deny. If the policy throws, the error propagates to the caller. Catch it yourself if you need a denial instead.
