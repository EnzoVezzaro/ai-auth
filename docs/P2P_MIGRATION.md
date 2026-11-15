# AI Auth P2P migration (first vertical slice)

This adds a **static-only P2P proof of concept** without modifying the existing Fastify server. Preview `apps/p2p/index.html` via a static HTTP server at the repo root. It imports `packages/p2p/index.js`.

## Implemented
- IndexedDB-backed browser ECDSA P-256 key pair; non-extractable private key
- Signed versioned events with SHA-256 key fingerprint, timestamp bounds, and replay checks
- Same-origin BroadcastChannel multi-tab discovery
- P2P WebRTC DataChannel with manually exchanged SDP offer/answer
- Presence, signed messages, explicit private mode, local exportable event view
- No AI Auth backend or central database required

## Not yet implemented
Automatic internet-wide discovery (add signaling plugins), NAT traversal, distributed persistence, revocation, real authorization policies, Clerk identity linking, enforceable locks, CRDT convergence, reliable event audit, real browser E2E test, scaling to 50 peers, and a plugin marketplace.

**Security boundaries:** Signed peer identity is not website authorization. Every privileged website action must be explicitly authorized by its controlling origin. Manual signaling may include local IP/ICE information; do not share SDP publicly. Private mode disables shared presence, not website operator auditing. Existing server remains a compatibility backend. Do not call this production-ready.

## Deployment
The static app can be deployed to a static host (Vercel, GitHub Pages, etc.) from the repo without the Fastify server. The existing Vercel project must be reconfigured to a static output before redeploy; do not route APIs to a serverless Fastify process.

## Follow-up gates
1. Browser automation test across independent browser contexts.
2. Automatic discovery plugin with honest signaling/STUN/TURN disclosures.
3. Capability grants signed by a trusted website authority, key rotation and revocation.
4. Pluggable Clerk identity-linking adapter, not a mandatory backend.
5. Durable local activity archive and independently verifiable audit export.
6. Peer group scalability tests and multi-device WebRTC tests.
