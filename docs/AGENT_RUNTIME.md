# Headless agent runtime: Node WebRTC spike record

Package: `packages/agent` (`@enzovezzaro/ai-auth-agent`). This records what was
tried, what failed and the evidence that the existing transport runs in Node.

## Result

The existing `P2PRoom` + `NostrWebRTC` + Trystero stack runs in Node 22 with
**no changes to the wire format** and no edits to `p2p.js`. `BroadcastChannel`
and global `WebSocket` exist in Node 22; `crypto.subtle` works as in the
browser. Only WebRTC needed a polyfill, passed through `joinRoom({ rtcPolyfill })`.

## Library choice: `node-datachannel`

|                   | `node-datachannel` 0.33.6                            | `@roamhq/wrtc` 0.10.0                                                     |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Maintenance       | release 2026-10-27                                   | release 2026-09-22                                                        |
| Prebuilt binaries | darwin arm64/x64, linux x64/arm64 (gnu, musl), win32 | darwin arm64/x64, linux x64/arm64, win32 x64                              |
| Installed size    | about 9 MB (1.1 MB JS + 8.3 MB binary)               | about 24 MB                                                               |
| Trystero result   | works after the shim below                           | `failed to get offer for peer` on first attempt; not investigated further |

Chosen: `node-datachannel` (smaller, actively maintained, ships musl builds).
The `@roamhq/wrtc` failure was observed once and not root-caused; it may be
fixable, so this is a size and maintenance decision, not proof it cannot work.

## The one real incompatibility (and the fix)

Symptom: two Node processes saw each other through the relays and ICE
gathering finished, but no offer was ever published and no peer joined.

Cause: libdatachannel negotiates eagerly. `createDataChannel()` immediately
creates a local offer, so a new initiator reports `signalingState:
"have-local-offer"`. Trystero's initiator checks for `stable` and a missing
`localDescription` before calling `setLocalDescription()`, so it skipped
negotiation and `getOffer()` never settled.

Fix: `rtc.js` subclasses the polyfill and reports `stable` / no local
description until the application calls `setLocalDescription()` or
`setRemoteDescription()`. Signaling messages are unchanged.

## Evidence (real network, this machine)

`npm run test:network --prefix packages/agent`: two OS processes, public Nostr
relays (Trystero defaults), no TURN, STUN candidates host and srflx.

```
A: wallet-authorized +188ms, signaling +192, waiting-for-peers +317,
   direct-peer-connected +1045, sent, received "hello from B" +1052
B: wallet-authorized +187ms, signaling +191, waiting-for-peers +319,
   direct-peer-connected +1045, sent, received "hello from A" +1052
test: ok (both sides connected and verified each other's signed message/text)
```

Earlier runs of the same flow connected in 0.65 s to 1.7 s. This is one
network (home NAT, both processes on the same host and LAN). It does **not**
show behavior across symmetric NATs or networks that block UDP; in those cases
the runtime stays in `waiting-for-peers` and `connectionState.diagnostics`
records the ICE error, by design (no TURN).

## Tools without a browser

A runtime owns its connection, so it can also own tools. `runtime.provideTools({ tools, authorize })` publishes a signed `tool-catalog` for handlers the runtime executes itself:

```js
const provider = runtime.provideTools({
  tools: [
    {
      name: "notes.ping",
      description: "Answer from this agent's own process",
      inputSchema: { type: "object", properties: {} },
      handler: async (input, { requester }) => ({ pong: true, requester }),
    },
  ],
  // Required. Return true only for peers the owner has allowed.
  authorize: (requesterId, name, input) => allowedPeers.has(requesterId),
});

await runtime.join();
```

Peers discover it with the same agent client a page uses
(`createAIAuthAgentClient(room).catalogs` / `.callTool(...)`), and `ai-auth-mcp`
exposes it as `ai_auth_list_tools` / `ai_auth_invoke`. `packages/mcp` ships two
read-only room tools (`agent.ping`, `agent.self`) that an operator can enable
with `--provide room`. Calls are bounded (32 tools, 8 KB input, 8 KB result,
15 s timeout, 8 concurrent) and a failed handler returns an error string, never
a result.

The catalog is bound to the live room session and is re-announced after a
reconnect. Closing the runtime (or `provider.close()`) withdraws it immediately;
otherwise it expires with the signed event in about two minutes. This is the
category that keeps working when no visitor is on the site. A page tool is
different: it exists only while the page is open, and callers get an explicit
"unavailable" answer when no provider is online.
