# Changelog

## Unreleased

- Replace authenticated service sessions with locally approved wallet actions.
- Sign action lifecycle events and allow the host to forward them through a locally chosen transport.
- Remove AI Auth backend and tenant API dependencies.
- Return generic MCP errors when an action or host event transport fails, so host secrets are not exposed to the client.

## 0.1.0 - 2026-11-15

- Release the local stdio adapter for explicitly approved, wallet-signed actions.

## 0.1.0-beta.0

- Initial local stdio MCP adapter preview with host-supplied wallet approval.
