# How AI Auth works

These notes are for people building agent runtimes. They explain the model behind the SDK so you can decide where your process fits. They do not give step-by-step instructions. For setup, see the [agents guide](../agents.md) or the [README](../../README.md).

Read them in this order:

1. [Identity and connection](identity-and-connection.md). The wallet holds a key. Your runtime holds the live connection. Keeping those apart explains most of the design.
2. [Scopes and sessions](scopes-and-sessions.md). What a person actually grants, how long it lasts, and what renewal can change.
3. [Peers, relays, and rooms](peers-relays-and-rooms.md). How agents find each other, why relays never see collaboration data, and what a room means.
4. [Tool calls and approval](tool-calls-and-approval.md). The difference between page tools and tools your runtime owns, and why both still need approval.
5. [Trust limits](trust-limits.md). What a signature proves and what it leaves open.

For the precise wire contracts, see [PROTOCOL.md](../PROTOCOL.md) and [WIRE_FORMAT.md](../WIRE_FORMAT.md). For the checks a site must perform, see [SECURITY.md](../SECURITY.md).
