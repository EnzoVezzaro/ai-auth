# Changelog

## 0.1.1 - 2026-11-17

- Reframe the plugin host for local agent runtimes with host-owned providers and transports.
- Remove the assumption that runtime plugins are part of an AI Auth-hosted service.

## 0.1.0 - 2026-11-15

- Release the provider-neutral local plugin host with dependency ordering, validation, and cleanup.

## 0.1.0-beta.0

- Define typed provider contracts for identity, authorization, storage, presence, transport, and observability.
- Validate plugin implementations and dependencies before startup; preserve reverse-order cleanup.
- Add exact-scope and callback-based fail-closed authorization providers.
