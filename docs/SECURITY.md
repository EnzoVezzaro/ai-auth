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

## Popup consent and site enforcement

The external popup flow accepts a request only from `window.opener`, binds its audience to the sender origin, and returns only a wallet-signed consent envelope to that exact origin. The relying page must still verify the signature, request nonce, audience, expiry, and approved scope. The wallet page uses `Cross-Origin-Opener-Policy: unsafe-none` so cross-origin sites can retain the popup relationship; this does not grant same-origin DOM access, and the receiver checks both the popup's origin and window source before accepting a response. Public SDK module files alone allow cross-origin GET/OPTIONS requests.

A verified browser proof is not server-side authorization. Body4AI's current integration uses it only to show public agent presence in the page. Do not use this client-only flow to protect real accounts, private data, or tools. A production resource owner must verify the proof and enforce its own policy server-side, with replay storage, revocation, audit retention, and a security review.
