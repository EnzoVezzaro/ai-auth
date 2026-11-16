# @enzovezzaro/ai-auth-agent

Headless AI Auth agent for Node 22+. One keystore identity joins a signed room
over **direct WebRTC data channels**; public Nostr relays carry only discovery
and signaling. There is no AI Auth server, database or relay-mediated
application data, and no TURN: on networks that block peer candidates the
connection stays in `waiting-for-peers` (and records the ICE error) rather than
falling back to a relay.

```js
import {
  createFileKeystore,
  createAgentRuntime,
} from "@enzovezzaro/ai-auth-agent";

const keystore = createFileKeystore({ dir: "./.ai-auth/agent-1" }); // AI_AUTH_PASSPHRASE or TTY prompt
if (!(await keystore.exists())) await keystore.create({ name: "build-agent" });

const runtime = createAgentRuntime({
  keystore,
  origin: "https://site.example",
  room: "default",
  capabilities: ["presence.read", "messages.send"],
  descriptor: { name: "build-agent" },
});
runtime.onConnectionState((s) => console.log(s.status, s.directPeerCount));
await runtime.join();
await runtime.send("message/text", { text: "hello" }); // signed, verified by peers
```

## What the signature does and does not prove

A signature proves possession of the agent's key. It does not prove who runs
the agent, and it does not prove the site admitted it. Restricted rooms need a
membership proof (`participation` option, see `docs/WIRE_FORMAT.md`).

## Keystore

`createFileKeystore({ dir })` keeps **one wallet per instance** in
`<dir>/identity.json` (file `0600`, directory `0700`), encrypted with AES-GCM
under a PBKDF2-SHA-256 (310 000 iterations) key from the passphrase
(`AI_AUTH_PASSPHRASE`, else a no-echo TTY prompt; at least 12 characters). The
header carries a random `instanceId` that is authenticated as AES-GCM
associated data. The wallet exposes `{ id, name, instanceId, publicKey, sign }`;
the private key is never returned, logged or serialized. Signatures are
ECDSA P-256 envelopes that the browser package's `verifyEnvelope` accepts.

| Situation                                   | Behavior                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| File corrupted or unknown format            | `KEYSTORE_CORRUPT`; the file is never overwritten, `create()` refuses (`KEYSTORE_EXISTS`).                                                        |
| Wrong passphrase / tampered header          | `KEYSTORE_UNLOCK_FAILED` (indistinguishable by design).                                                                                           |
| Group/world-readable file                   | `KEYSTORE_PERMISSIONS`; fix with `chmod 600`.                                                                                                     |
| Directory unreadable or missing disk        | `KEYSTORE_UNAVAILABLE`; nothing is created elsewhere.                                                                                             |
| Directory copied to another machine (clone) | It is the **same identity and instance id**. Two live copies would impersonate each other; give a clone its own key with `rotate()`.              |
| Identity compromise or reuse                | `rotate()` writes a new identity and archives the old file as `identity.<ts>.rotated.json` (still encrypted). Peers must re-trust the new id.     |
| Backup                                      | `backup(path)` copies the encrypted file (0600, never overwrites); `restore(path, { replace })` validates it first and archives any current file. |
| Removal                                     | `delete()` removes the active keystore; rotated and replaced archives stay until you delete them.                                                 |

## Runtime

`createAgentRuntime({ keystore, origin, room?, capabilities, descriptor? })`

- `join(room?)`, `leave()` (announces departure and forgets the room),
  `close()` (stops, keeps the last room), `resume()` (rejoins the persisted
  room if it was saved for the same origin).
- `connectionState` / `onConnectionState(fn)`: the SDK's
  `connection-state.js` lifecycle (`signaling`, `waiting-for-peers`,
  `direct-peer-connected`, `disconnected`; `degraded` is defined in the transition table but no code path enters it yet). `direct-peer-connected`
  appears only after a data channel is open.
- Leases: `peers()` lists `{ id, name, seenAt, leaseExpiresAt, stale }` from
  signed heartbeats; `onPeerStale` fires once per lapsed lease.
- Reconnect: `join()` retries transport failures with exponential backoff and
  jitter (`backoff: { baseMs: 1000, maxMs: 30000, maxAttempts: 8 }`), then
  reports `onError` and ends `disconnected`. A transport with no direct peers
  for `rejoinAfterMs` (default 120 s) is rebuilt.
- The last room is stored in `<dir>/runtime.json` (0600). It holds no secrets.

## Node WebRTC

`node-datachannel` (libdatachannel, prebuilt for macOS, Linux and Windows) is
used through `NodeRTCPeerConnection`. libdatachannel negotiates eagerly, which
stalls Trystero's initiator, so the subclass in `rtc.js` hides the eager offer
until Trystero asks for it. The wire format is unchanged.

## Tests

`npm test` runs offline tests with an in-process fake transport.
`npm run test:network` spawns two processes over public relays and real WebRTC
(needs internet and a network that allows peer candidates).
