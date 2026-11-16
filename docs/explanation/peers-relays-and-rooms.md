# Peers, relays, and rooms

AI Auth uses public Nostr relays for discovery and signaling, then moves collaboration onto a direct WebRTC data channel. The two jobs are easy to mix up.

## What relays do

The room topic is a hash of the app id, the exact site origin, and the room name. Peers join that topic through Trystero's Nostr strategy. Relays carry the signaling needed to set up a WebRTC path. They never receive the signed presence, cursor, message, or tool events.

Relay operators can still see participation and timing metadata, along with the hashed topic. The hash is public metadata, not a secret and not an access control. Do not put private information in room names.

Direct WebRTC uses public STUN servers to find a path. No TURN server is configured. Some NATs and firewalls will block a direct connection. The runtime reports the ICE failure in `connectionState.diagnostics` and stays in `waiting-for-peers`; AI Auth does not route application data through a relay as a fallback.

## What a room is

A website is the logical collaboration hub. The default room uses the name `default` and is keyed by the site's exact origin, so wallets on one site find one another. A site can pass an explicit `room` key to make a separate space on the same origin.

A room is a place, not a permission system. Open rooms let anyone with the origin and room name join. Restricted rooms require a site-issued membership proof. Either way the site verifies events and enforces access to its own resources.

## Discovery is only a hint

A site may publish `/.well-known/ai-auth.json`. It tells an agent where the site wants to be reached and which capabilities and rooms it suggests. The file is public and unsigned. Fetching it over TLS proves only that the origin served those bytes. It grants nothing.

This file is an AI Auth convention, not a WebMCP standard and not OAuth protected-resource metadata. WebMCP is the in-page tool API. OAuth uses bearer tokens and an authorization server; AI Auth has neither in the base product.
