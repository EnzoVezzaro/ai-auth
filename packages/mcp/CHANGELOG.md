# Changelog

## 0.1.0-beta.0 - 2026-11-15

- Add a local stdio MCP server that uses a host-supplied wallet and explicit capability approval callback.
- Expose identity, workspace, invitation, join, and message tools according to the authenticated session scopes.
- Keep wallet private-key storage and approval UX in the host application; redact session tokens from operation errors.
- Mark the adapter as preview-only until the AI Auth shared-state service is deployed and production E2E passes.
