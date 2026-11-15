# AI Auth

AI Auth is a browser wallet for cryptographic agent identity, scoped consent, capability delegation and direct peer collaboration. It uses Web Crypto and IndexedDB. The wallet works without a hosted backend, account provider, blockchain, cryptocurrency, or gas. An optional Cloudflare Worker prototype adds server-verified sessions and durable shared workspaces; it is not deployed.

## Run the wallet locally

Requires Node.js 22+ and npm.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:4173`. This command builds and serves static files only; it exposes no API or stateful backend. For Vercel, the configured output is also static.

Create a wallet and save its encrypted recovery file. The browser stores a non-exportable private `CryptoKey` in origin-local IndexedDB. If browser data is cleared, the recovery file is required to restore the identity.

## MVP flows

1. Create or restore an agent wallet with a public P-256 identity.
2. Review selected capabilities for an exact website origin and sign short-lived consent.
3. Create a scoped capability grant naming its recipient, resource, operations and expiry.
4. Share signed presence with other tabs on the same origin.
5. Connect wallets with manual WebRTC offer/answer exchange and send signed messages.
6. Review the local signed activity log.

Manual WebRTC signaling uses no AI Auth service and no TURN relay. This limits network reachability; some devices will not connect. Do not share SDP publicly because it can include network candidates.

The built-in consent flow is a same-app protocol demonstration, not an independent wallet-to-website integration. A relying website must issue its own challenge and enforce its own authorization policy. A wallet signature proves key possession and consent to a message; it does not authorize website resources.

## Optional shared-workspace service

`apps/worker` is a local Cloudflare Workers prototype for signed wallet sessions, isolated tenants, delegated invitations, messages, and authenticated WebSocket presence. The service uses Cloudflare Durable Objects and SQLite; it is not part of the static wallet or currently deployed. See [Worker setup, routes and limits](apps/worker/README.md).

The `@enzovezzaro/ai-auth-wallet@next` service client connects a local wallet to that service. Its `connectPresenceResilient` method reconnects after transient socket loss, reauthenticates in the first frame, and forwards the server's fresh presence snapshot; call `close()` to stop retries. The standalone MCP adapter is published as `@enzovezzaro/ai-auth-mcp@next`. MCP requires an explicit wallet approval callback and exposes only session-scoped tools. The host loads and protects its own wallet; the adapter does not save private keys. See [MCP integration](packages/mcp/README.md). These are preview components for the local Worker; the service is not deployed.

## Install the wallet SDK

```sh
npm install @enzovezzaro/ai-auth-wallet@0.1.1
```

```js
import {
  createPermissionRequest,
  approvePermissionRequest,
  verifyPermissionConsent,
  createCapabilityGrant,
  verifyCapabilityGrant,
  P2PRoom,
  ManualWebRTC,
} from "@enzovezzaro/ai-auth-wallet";
```

The stable `latest` wallet package remains `0.1.1` and exposes `/wallet`, `/connect`, `/capabilities`, and `/p2p`. The `next` preview is `0.2.0-beta.4` and adds `/service`; install it with `npm install @enzovezzaro/ai-auth-wallet@next`. The MCP adapter is published as `@enzovezzaro/ai-auth-mcp@0.1.0-beta.0` and installs with `npm install @enzovezzaro/ai-auth-mcp@next`. Both preview packages target the local Worker prototype and do not imply that a hosted service is available.

The provider host is published separately as `@enzovezzaro/ai-auth-runtime@0.1.0-beta.0`; install it with `npm install @enzovezzaro/ai-auth-runtime@next`. Its typed plugin contracts are documented in [the runtime package guide](packages/runtime/README.md).

## Security and limits

- Keys: ECDSA P-256 / SHA-256, IndexedDB CryptoKey storage, AES-GCM-encrypted recovery file.
- Signed JSON: RFC 8785 canonicalization, versioned envelopes, bounded freshness, origin-bound consent, nonce replay guard.
- Presence: BroadcastChannel, limited to same-origin tabs.
- Peer data: manually signaled WebRTC DataChannels, signed message envelopes, no configured relay.
- Delegation: signed explicit scopes and short expiry; no global revocation broadcast yet.
- Clerk: optional future human-account linking. It will not own the agent key.

See [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), [wire format](docs/WIRE_FORMAT.md), [recovery](docs/RECOVERY.md), and the [migration plan](docs/IMPLEMENTATION_PLAN.md).

The historical `@enzovezzaro/ai-auth-server` npm package is deprecated; its source, Docker configuration, and Fly app have been removed from this repository. Existing old releases do not receive updates and are not part of the wallet architecture.

## Checks

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm pack --dry-run
```

The browser E2E uses an isolated Playwright Chromium context. In CI, install only the headless shell with `npx playwright install --with-deps --only-shell chromium`.

To verify all source packages and the wallet-to-MCP-to-Worker service path and the browser-to-local-Worker HTTP/WebSocket flow, install each isolated package with the default npm workflow first:

```sh
npm ci
npm ci --prefix packages/mcp
npm ci --prefix apps/worker
npm run test:all
npm run test:service:e2e
npm run test:service:browser:e2e
```

CI performs these installs and runs the same checks. Root `npm test` and `npm publish` intentionally verify only the wallet package; runtime, MCP and Worker have separate manifests, while CI verifies local package tarballs and published registry installs.
