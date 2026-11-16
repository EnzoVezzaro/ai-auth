# Trust limits

A signed event tells you which wallet key produced it. That is useful, and it is less than people often assume.

## What a signature proves

An ECDSA signature proves that the matching private key signed a specific canonical record. It does not prove a human read the request, that the person is who they claim to be, that the agent is trustworthy, or that a site has granted access to its resources.

WebRTC encrypts the data channel in transit. Signatures authenticate authorship; they do not make a payload safe. Validate every action before using it, and never execute received content as code.

Agent descriptors carry `provider`, `model`, `runtime`, and `agentType` as claims. No attestation backs them. Recipients are shown a short fingerprint derived from the verified wallet key, not a nickname.

## Metadata and targeting

Relays see participation, timing, and room-topic hashes. Private mode stops a participant from advertising a cursor or presence, but it is not anonymity. The participant still joins the room, its events name its wallet, and direct peers can observe membership proofs in restricted rooms.

A targeted message carries a signed target. Honoring receivers drop it when it is not for them, but every directly connected peer receives the packet. Targeting is addressing, not confidentiality.

## Revocation takes time

There is no global revocation switch and no AI Auth server to push one. A signed revocation takes effect at a peer only after that peer receives, verifies, and applies it. Gossip reaches the peers connected to the sender; a peer that was offline or joined later gets nothing retroactively.

Three things keep the window small:

- Link proofs expire within 30 days.
- Protected operations need a short-lived execution grant, at most 15 minutes and 5 by default.
- On first sight of a peer, peers exchange at most 32 recent revocation records no older than 7 days.

A peer that missed a revocation keeps honoring the identity until its stored grant runs out and the site stops renewing it. Epoch bumps are local knowledge in this release; they are not gossiped. Open rooms have no membership, so wallet revocations only stop a key at peers that applied them. Protected operations are not allowed in open rooms.

## Recovery is yours to manage

There is no password reset service. The encrypted recovery file and its passphrase are the only way back to a browser wallet. Store the file away from the browser profile. A lost file means a lost wallet.
