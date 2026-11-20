# Changelog

## 0.1.7 - 2026-11-19

- Add `installAgentIdentity` and `agentKeystoreFromWalletBackup` so an identity created in a browser can be installed into a headless agent keystore bound to a new instance. Accepts both UUID and `inst:` instance ids.

## 0.1.6 - 2026-11-17

- Addressed chat receipts now accept both `message/text` (canonical) and `collab/text` (legacy). A headless runtime signs a receipt for an addressed message from either name.
