# Serverless / decentralized invariant: evidence plan

Scope: W3 of `docs/AGENT_E2E_PLAN.md`. No SDK source was changed. This note records how to prove the invariant and where the evidence stops.

## The claim in three parts

1. **Relays carry signaling only.** Peers exchange SDP offers, answers and ICE candidates over WebSockets to public Nostr relays. No message, cursor, receipt or tool event is published as a relay event.

2. **Application events go peer to peer.** Signed envelopes such as `message/text` and `presence/cursor` travel over WebRTC data channels opened by Trystero.

3. **No AI Auth application server is in the path.** Every HTTP(S) request belongs to the static site, a package CDN, or browser background traffic. No hosted API carries session data.

## Exact endpoints

Should appear: `http://127.0.0.1:PORT/ai-auth/...` (local static site plus wallet iframe); `https://enzovezzaro.github.io/ai-auth/...` (remote site); `https://esm.sh/...` (SDK bundle named in the connect instruction).

`wss://` on port 443 to the 30 relays exported as `defaultRelayUrls` by `@trystero-p2p/nostr` (signaling only). UDP STUN to `stun*.l.google.com:19302` and `stun.cloudflare.com:3478` is invisible to HTTP capture.

Must not appear: any `api.*ai-auth*`, analytics collector, TURN endpoint (`turn:` / `turns:`), or third party receiving an application event. Public relay sockets must carry only Nostr message types REQ, EVENT, OK, CLOSE, EOSE, NOTICE, COUNT, AUTH.

## Live capture procedure

1. Build once with `npm run build`, then run `AI_AUTH_LIVE=1 node scripts/verify-decentralized.mjs`. It starts the local static server, opens two isolated Chromium wallets on random rooms, joins both through real relays, and sends a unique text marker.

2. Capture Playwright `websocket` frames (sent and received), `request` and `requestfailed` events for both pages. Capture WebRTC via an injected observer that wraps `RTCPeerConnection`, records `iceServers`, tracks `createDataChannel` and `datachannel`, and logs every `send` and `message` payload.

3. Assert the marker is present on both data channels, absent from every relay frame and HTTP request, that relay frames decode to Nostr types, that HTTP hosts are in the allow list, and that no `turn:` server is configured.

## What the script implements

Default mode (no network) is fast and deterministic: seven source-level checks plus the URL inventory. It confirms the transport imports `@trystero-p2p/nostr`, forwards events through `sendAction(target: peerId)`, passes `turnConfig: []`, contains no `fetch` or HTTP client call in the transport and connect path, and publishes only public data in the connect instruction.

Live mode adds the checks above, prints PASS / FAIL / UNKNOWN / INFO per check, writes `test-results/decentralized-report.json`, and exits non-zero on any FAIL. UNKNOWN is never counted as PASS.

## Limits and honest unknowns

- Playwright cannot read DTLS-encrypted WebRTC packets. Data-channel evidence is page-level instrumentation, not a wire tap; it proves the SDK handed the event to a data channel that reached the peer.
- Relay frames are checked for known Nostr types and absence of application strings. An opaque encoded payload cannot be fully decoded by the script; source inspection covers that gap statically.
- No dedicated REA capture utility exists in this repository; the plan's "REA capture" is realised with Playwright network events plus the existing `iceDiagnosticsScript` pattern. The only browser mock in the sibling E2E is synthetic `getDisplayMedia`, unrelated to transport.
- The live check runs on one machine against the local static site. It does not prove cross-NAT reachability, mobile behaviour, or the deployed GitHub Pages origin; remote runs need the sibling body4ai harness pointed at that origin.

- A blocked relay or failed ICE yields UNKNOWN, not PASS. The absence of an app-server request is evidence for this session only; a future SDK change needs a fresh run.

This W3 task did not execute the live mode; only the offline checks were run (PASS 7, UNKNOWN 1). The network capture is provided as a reproducible procedure, not as a claim about a completed live session.
