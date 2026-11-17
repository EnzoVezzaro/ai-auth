# @enzovezzaro/ai-auth-agent

A headless AI Auth agent for Node 22+. One keystore identity joins a signed room over a direct WebRTC data channel. Public Nostr relays carry signaling only. There is no AI Auth server, no database, no relay carried application data and no TURN server. If peer candidates are blocked, the connection stays in `waiting-for-peers`.

Version 0.1.5. See the [agents guide](../../docs/agents.md) for tools, approval, reconnect and MCP setup.

## Install

```sh
npm install @enzovezzaro/ai-auth-agent
```

## Join a room

```js
import {
  createFileKeystore,
  createAgentRuntime,
} from "@enzovezzaro/ai-auth-agent";

const keystore = createFileKeystore({ dir: "./.ai-auth/agent-1" });
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
await runtime.send("collab/text", { text: "hello" });
```

Human and wheel chat also use `collab/text`. The legacy `message/text` type is still accepted. The canonical type name is under review.

## Keystore

`createFileKeystore({ dir })` keeps one wallet in `<dir>/identity.json`. The file is mode `0600` and the directory `0700`. AES-GCM encrypts it under a PBKDF2-SHA-256 key from the passphrase, taken from `AI_AUTH_PASSPHRASE` or a terminal prompt. The 12-character minimum applies to `create()` and `rotate()`, not to `unlock()`.

| Situation          | Result                                                                            |
| ------------------ | --------------------------------------------------------------------------------- |
| Corrupt file       | `KEYSTORE_CORRUPT`. The file is never overwritten.                                |
| Wrong passphrase   | `KEYSTORE_UNLOCK_FAILED`.                                                         |
| Loose permissions  | `KEYSTORE_PERMISSIONS`. Fix with `chmod 600`.                                     |
| Missing directory  | `KEYSTORE_UNAVAILABLE`. Nothing is written elsewhere.                             |
| Copied directory   | The clone is the same identity. Do not run two copies.                            |
| Rotate keys        | `rotate()` archives the encrypted old file. Peers must trust the new id.          |
| Backup and restore | `backup(path)` copies the encrypted file. `restore(path, { replace })` checks it. |
| Delete             | `delete()` removes the active keystore. Archives stay until you remove them.      |

A signature proves possession of the key. It does not prove who runs the agent or that a site admitted it. Restricted rooms need a membership proof. See [security](../../docs/SECURITY.md) and [protocol](../../docs/PROTOCOL.md).

## Runtime

`createAgentRuntime({ keystore, origin, room?, capabilities, descriptor? })`

- `join(room?)`, `leave()`, `close()` and `resume()`. `leave()` forgets the room, `close()` keeps it.
- `connectionState` and `onConnectionState(fn)` report the SDK lifecycle. `direct-peer-connected` appears only after the data channel opens. The status list is in [connection lifecycle](../../docs/CONNECTION_LIFECYCLE.md).
- `peers()` reads signed heartbeat leases. `onPeerStale` fires once per lapsed lease.
- `join()` retries transport failures with bounded backoff. The last room is saved in `<dir>/runtime.json`, with no secrets.
- The connection lasts only while this process runs. There is no background daemon.

## Tools from the runtime

`provideTools({ tools, authorize })` publishes a signed catalog for handlers this runtime runs itself. It needs `tools.invoke`. Peers can call them while every browser is closed.

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
  authorize: (requesterId, name, input) => allowlist.has(requesterId),
});
await runtime.join();
```

`authorize` is required. Limits are 32 tools, 8 KB input, 8 KB result, 15 seconds and 8 concurrent calls. A failing handler returns an error, not a result. `provider.close()` and `runtime.close()` withdraw the catalog. Otherwise it expires with the signed event in about two minutes. A page tool is different: it exists only while the site's page is open.

## Node WebRTC

`node-datachannel` supplies WebRTC through `NodeRTCPeerConnection`. libdatachannel negotiates eagerly, so the subclass in `rtc.js` hides the local offer until Trystero asks for it. The wire format is unchanged.

## Tests

`npm test` runs offline tests with an in-process transport. `npm run test:network` starts two processes over public relays and real WebRTC. It needs internet and a network that allows peer candidates.
