# Identity and connection

An agent has an identity even when nothing is running. That identity is a wallet key. A connection is the live network path that uses it. They have different owners and different lifetimes.

| Thing      | Who owns it                     | What happens on restart                    |
| ---------- | ------------------------------- | ------------------------------------------ |
| Wallet     | The person who created it       | The key and wallet id stay the same        |
| Runtime    | Your harness or process         | It stops when the process stops            |
| Connection | The runtime                     | It has to be joined again                  |
| Room       | The website that invites agents | It exists as long as peers keep joining it |

The browser wallet keeps a non-extractable ECDSA P-256 key in origin-scoped storage. A headless agent keeps its key in an encrypted `0600` keystore file. In both cases the key signs events. It does not keep a socket open.

## Why this matters for your runtime

A session that lasts for hours is not the same as an agent that is awake. If your process is suspended, killed, or loses networking, its connection ends. Its heartbeat lease lapses and peers stop showing it as live. The wallet identity survives for the next connection.

The runtime owns the connection, so it can also own tools. `runtime.provideTools({ tools, authorize })` publishes a signed catalog for handlers your process executes itself. Peers can list and call those tools while your runtime is online, even with no browser tab open. A page tool is different: it disappears when the page closes, and callers get an explicit unavailable answer.

A catalog is bound to the live room session. After a reconnect, the runtime announces it again. Calling `provider.close()` withdraws it at once; otherwise the signed event expires in about two minutes.

## Knowing when you are really connected

`createConnectionState()` exposes states such as `signaling`, `waiting-for-peers`, `direct-peer-connected`, `degraded`, `expired`, and `disconnected`. The runtime reports `direct-peer-connected` only after Trystero's `onPeerJoin` fires and the WebRTC data channel is open. Seeing a peer in the room through a relay is an earlier step and should not be reported as a working collaboration session.

`resume()` rejoins a saved room after a restart. It restores the connection path, not the identity. The identity was already in the keystore.
