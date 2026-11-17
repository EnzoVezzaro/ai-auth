# @enzovezzaro/ai-auth-agent

Headless AI Auth agent for Node 22+. One keystore identity joins a signed room
over **direct WebRTC data channels**; public Nostr relays carry only discovery
and signaling. There is no AI Auth server, database or relay-mediated
application data, and no TURN: on networks that block peer candidates it does
not fall back to a relay. Before SDP is exchanged the connection stays in
`waiting-for-peers`; after SDP exchange an ICE failure moves it to
`reconnecting` and records `lastIceError` (see
`packages/p2p/connection-state.js`).

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
await runtime.send("collab/text", { text: "hello" }); // signed, verified by peers
```

`collab/text` is the canonical chat type. The legacy `message/text` type is
still accepted for compatibility, but it carries no signed message id or target
and gets no delivery receipt.

## What the signature does and does not prove

A signature proves possession of the agent's key. It does not prove who runs
the agent, and it does not prove the site admitted it. Restricted rooms need a
membership proof (the `participation` policy; see `docs/PROTOCOL.md` section 4
and `docs/SECURITY.md`, "Participation modes").

## Keystore

`createFileKeystore({ dir })` keeps **one wallet per instance** in
`<dir>/identity.json` (file `0600`, directory `0700`), encrypted with AES-GCM
under a PBKDF2-SHA-256 (310 000 iterations) key from the passphrase
(`AI_AUTH_PASSPHRASE`, else a no-echo TTY prompt). The 12-character minimum is
enforced only by `create()` and `rotate()`; `unlock()` accepts any non-empty
passphrase. The header carries a random `instanceId` that is authenticated as AES-GCM
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
- `connectionState` / `onConnectionState(fn)`: the SDK's `connection-state.js`
  lifecycle. `CONNECTION_STATUSES` in `packages/p2p/connection-state.js` is the
  source of truth and lists 12 values: `idle`, `approval-pending`,
  `wallet-authorized`, `connecting`, `signaling`, `waiting-for-peers`,
  `direct-peer-connected`, `reconnecting`, `degraded`, `expired`, `revoked`,
  `disconnected`. The runtime also emits `reconnecting` from `checkLeases()`
  when no direct peer has been seen for `rejoinAfterMs`. `direct-peer-connected`
  appears only after a data channel is open.
- Leases: `peers()` lists `{ id, name, seenAt, leaseExpiresAt, stale }` from
  signed heartbeats; `onPeerStale` fires once per lapsed lease.
- Reconnect: `join()` retries transport failures with exponential backoff and
  jitter (`backoff: { baseMs: 1000, maxMs: 30000, maxAttempts: 8 }`), then
  reports `onError` and ends `disconnected`. A transport with no direct peers
  for `rejoinAfterMs` (default 120 s) is rebuilt.
- The last room is stored in `<dir>/runtime.json` (0600). It holds no secrets.

## Agent-provided tools

`provideTools({ tools, authorize })` publishes a signed tool catalog for
handlers this runtime runs itself. It requires the `tools.invoke` capability.
Peers discover and call these tools through the normal agent client
(`createAIAuthAgentClient`), so they work while every browser is closed:

```js
const provider = runtime.provideTools({
  tools: [
    {
      name: "build.status",
      description: "Current build status",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ ok: true }),
    },
  ],
  // Required: allow only peers the owner chose.
  authorize: (requesterId, name, input) => allowlist.has(requesterId),
});
await runtime.join(); // the catalog is announced once the room is live
// provider.close() withdraws it; runtime.close() does the same.
```

Limits: 32 tools, 8 KB input, 8 KB result, 15 s timeout, 8 concurrent calls.
A failing handler returns an error, never a result. The catalog is bound to the
live room session and re-announced after a reconnect; otherwise it expires with
the signed event in about two minutes. This is different from a page tool, which
only exists while the site's page is open.

## Node WebRTC

`node-datachannel` (libdatachannel, prebuilt for macOS, Linux and Windows) is
used through `NodeRTCPeerConnection`. libdatachannel negotiates eagerly, which
stalls Trystero's initiator, so the subclass in `rtc.js` hides the eager offer
until Trystero asks for it. The wire format is unchanged.

## Tests

`npm test` runs offline tests with an in-process fake transport.
`npm run test:network` spawns two processes over public relays and real WebRTC
(needs internet and a network that allows peer candidates).
