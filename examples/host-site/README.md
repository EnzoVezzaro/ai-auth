# Minimal host site

A deliberately small example of the **external wallet integration only**: a
host page whose single primary action opens the AI Auth wallet as an in-page
modal. It is distinct from the identity setup flow in `apps/connect-agent/`.

This site creates no identity and holds no keys. The wallet owner and the agent
each bring their own identity; the owner approves a subset of the requested
capabilities in the wallet dialog.

## Files

- `index.html` — markup: `#connect`, `#disconnect`, `#status`, `#scopes`,
  `#peers`, `#events`.
- `site.js` — calls `connectAIAuthModal(...)` from the button's user gesture,
  renders state, and exposes `window.__hostSite`.
- `site.css` — accessible styling (one primary action, visible focus, high
  contrast, `prefers-color-scheme`).

## What it demonstrates

1. Clicking **Connect agent** calls `connectAIAuthModal` from a user gesture
   with `walletUrl` pointing at the same-origin `/wallet/` directory,
   `capabilities: ["presence.read", "messages.send"]` and `room: "host-demo"`.
   The SDK imports come from `../../../packages/p2p/browser.js`, the same
   relative import used by the BODY4AI demo (bundled at build time, not a
   remote bundle).
2. `#status` (`role="status"`, `aria-live="polite"`) shows `Not connected`,
   `Waiting for approval…`, `Connected` or `Disconnected`. When connected it
   includes only a **masked** wallet id — the full id is never rendered.
3. `#scopes` shows the **effective** scopes from the verified consent. It uses
   `connection.capabilities` when present, otherwise
   `connection.consent.body.payload.capabilities`. Requested scopes are never
   shown as approved and nothing is invented.
4. `#peers` lists peers seen through `connection.onEvent` presence announcements
   (`peer/hello` / `peer/heartbeat`, removed on `peer/goodbye`). `#events` keeps
   the latest signed events as `type · short issuer`.
5. **Disconnect** closes the connection and resets the UI to `Disconnected`.
6. `window.__hostSite = { state, connection }` lets an E2E inspect the page.
   Approval must still be performed in the real wallet modal, not via a mock.

## Copy and safety notes

- No automatic install is promised.
- No keys, passphrases, credentials or private URLs appear on the page.
- Presence is scoped to the exact site origin plus the `host-demo` room.
- A page refresh ends the live connection; this example does not auto-resume.

## Run it locally

From the repository root:

```sh
npm ci
npm run dev
```

Then open `http://127.0.0.1:4173/host-site/` (the wallet is at
`http://127.0.0.1:4173/wallet/`). `npm run dev` builds `dist-p2p/` and publishes
this example to `/host-site/`. HTTP is allowed only on localhost; a deployed
site must use HTTPS.

## End-to-end verification

```sh
npm run test:host-site
```

The test uses real Chromium, the real in-page wallet modal, a real owner
approval signature and real Nostr/WebRTC transport — no wallet or signature
mocks. It proves, in seven steps:

1. `/host-site/` is served and the contract (`#connect`, `#status`, `#scopes`,
   `#peers`, `#events`, `window.__hostSite`) is inspectable.
2. The initial UI shows **Not connected** with no false green state.
3. **Connect agent** opens the real wallet modal with the exact origin and
   requested scopes.
4. The owner approves `presence.read` and `messages.send`; the site shows
   **Connected**, a masked id, exactly those effective scopes, and never
   `tools.invoke` (which was not requested).
5. An owner-authorised headless agent joins `host-demo` and appears as a
   verified peer with a masked id; its signed `message/text` reaches `#events`.
6. An uninvited identity with another authority cannot change the site status
   or scopes.
7. Stopping the agent removes its peer, and **Disconnect** clears any green
   state.

A JSON report is written to `test-results/host-site-e2e-report.json` with masked
identifiers only — no passphrases, full wallet ids or secrets.

## Scope of this example

This is the **external connection** flow, not identity setup. The owner wallet
and the agent each bring their own key. For the separate flow that creates,
backs up and installs an agent identity, see `apps/connect-agent/` and its E2E
(`npm run test:connect-agent`). For the full SDK contract, see the
[site integration guide](../../docs/site-integration.md).
