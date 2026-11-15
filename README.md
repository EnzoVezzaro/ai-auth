# AI Auth

AI Auth is a browser wallet for cryptographic agent identity, scoped consent, capability delegation and direct peer collaboration. It uses the browser's Web Crypto and IndexedDB APIs. It needs no AI Auth backend, account provider, blockchain, cryptocurrency, or gas.

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

The consent flow is a same-app protocol demonstration, not an independent wallet-to-website integration. A relying website must issue its own challenge and enforce its own authorization policy. A wallet signature proves key possession and consent to a message; it does not authorize website resources.

## Install the wallet SDK

```sh
npm install @enzovezzaro/ai-auth-wallet
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

The package also exposes `@enzovezzaro/ai-auth-wallet/wallet`, `/connect`, `/capabilities`, and `/p2p`. It has no runtime dependencies and uses browser APIs. ESM import is available in modern Node.js for signature verification; wallet key storage and WebRTC require a browser.

## Security and limits

- Keys: ECDSA P-256 / SHA-256, IndexedDB CryptoKey storage, AES-GCM-encrypted recovery file.
- Signed JSON: RFC 8785 canonicalization, versioned envelopes, bounded freshness, origin-bound consent, nonce replay guard.
- Presence: BroadcastChannel, limited to same-origin tabs.
- Peer data: manually signaled WebRTC DataChannels, signed message envelopes, no configured relay.
- Delegation: signed explicit scopes and short expiry; no global revocation broadcast yet.
- Clerk: optional future human-account linking. It will not own the agent key.

See [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md), [wire format](docs/WIRE_FORMAT.md), [recovery](docs/RECOVERY.md), and the [migration plan](docs/IMPLEMENTATION_PLAN.md).

The historical `@enzovezzaro/ai-auth-server` npm package remains published, but its source, Docker configuration, and Fly app have been removed from this repository. Old published server releases are not part of the wallet architecture.

## Checks

```sh
npm test
npm run test:e2e
npm run build
npm pack --dry-run
```
