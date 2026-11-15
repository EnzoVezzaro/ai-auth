# Security boundaries

## What signatures establish

An ECDSA signature verifies that the holder of a particular private key signed a specific canonical JSON record. It does not establish a legal or human identity, prove that a person read the request, authorize a website resource, or guarantee that an agent is safe.

Websites are the authorization authority for their own resources. They must verify the signer, exact audience/origin, nonce, expiry, requested and approved capabilities, recipient, resource, and any applicable revocation policy before taking an action. Never trust a client-supplied `authorized: true` flag.

## Key storage and recovery

The private key is imported as a non-extractable Web Crypto key and stored in origin-scoped IndexedDB. During first creation, the browser briefly generates an extractable key pair so it can create the encrypted recovery file; the private JWK is encrypted before the non-extractable key is persisted. Same-origin JavaScript can still ask the wallet to sign, so protect the wallet origin against XSS, compromised dependencies, and malicious extensions.

The recovery file contains encrypted key material, not plaintext private JWK. Use a unique strong passphrase and store the file offline. There is no password reset service. Clearing browser data without the file permanently loses the wallet. Removing a wallet clears its local signed activity too.

## Signed data and freshness

Signed records use the `ai-auth-wallet` protocol marker, version, type, issuer, creation time, payload, and ECDSA P-256/SHA-256 proof. Canonicalization follows RFC 8785 for supported JSON values. Verifiers reject malformed keys, changed payloads, expired or future-dated events, incorrect audiences, and replayed nonces where a nonce guard is supplied.

## Peer network

Same-origin BroadcastChannel events are visible to other tabs on the same origin. Manual SDP may include IP/network candidates; exchange it only through a private channel. Direct WebRTC data channels are encrypted in transit, but message signatures and identity do not prevent a user from receiving unsafe content. No relay is configured. A network that requires TURN will fail to connect in this MVP.

Private mode stops this app's public presence and shared messages. It does not hide activity from browser extensions, operating-system software, the hosting provider, or another site, and it does not erase already received data on another peer.

## Not production authorization

The permission demonstration uses one origin for the wallet UI and sample verifier. It is not an isolated browser extension, native wallet boundary, or independent website integration. Do not use it to protect real accounts or tools. A production relying party needs its own challenge endpoint or message protocol, a trusted origin-binding mechanism, server-side policy enforcement, replay storage, revocation, audit retention, and security review.
