# Optional Clerk account adapter (example)

This is an **optional, site-owned example**. It is not part of the AI Auth
core. The wallet works fully without it. A site that does not use Clerk
never needs to load these files.

## What it does

A site that already has Clerk accounts can attach an AI Auth agent link to
one of its users:

1. The user approves a site link in the wallet. The wallet returns a signed
   link proof (`approveLink` in the wallet SDK).
2. The site's browser sends that proof, plus the user's Clerk session token,
   to `POST /links`.
3. The route verifies the Clerk session, then verifies the link proof with
   `verifyLink`. It checks the exact origin, the site resource, the
   requested capabilities, the one-use nonce, and revocations.
4. On success it stores a mapping:

   ```json
   {
     "clerkUserId": "user_…",
     "walletId": "…",
     "scopes": ["read"],
     "linkId": "…"
   }
   ```

When the wallet unlinks, it emits a signed revocation event. The site sends
it to `POST /revocations`. After `verifyLinkRevocation` accepts the event, the
route deletes the mapping and remembers the `linkId`. A later link proof for
that `linkId` is rejected.

## Identity and permissions

- A wallet signature proves key possession only. It does not prove who the
  human is. The Clerk session proves the human's site account.
- The mapping ties the wallet to that account. Each site decides what the
  scopes mean. The adapter only copies the scopes from the verified link.
  It never grants permissions by itself.
- The adapter stores no tokens. Each mapping holds only identifiers and scopes.

## Files

| File                | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `server.mjs`        | `createClerkLinkServer(deps)`: Node HTTP routes, JSON envelope, input validation |
| `mapping-store.mjs` | `createMappingStore()`: in-memory mapping and revoked-link set                   |
| `server.test.mjs`   | `node --test` suite with mocked Clerk, `verifyLink` and revocation verifiers     |

## Wiring (site code)

The example does not add Clerk to any package. The site installs its own
Clerk backend SDK and passes in the check.

```js
import { createServer } from "node:http";
import { createClerkLinkServer } from "./examples/clerk-adapter/server.mjs";
import { createMappingStore } from "./examples/clerk-adapter/mapping-store.mjs";
// verifyLink / verifyLinkRevocation come from the AI Auth wallet SDK
import {
  verifyLink,
  verifyLinkRevocation,
  createLinkNonceStore,
} from "@enzovezzaro/ai-auth-wallet";

const server = createClerkLinkServer({
  expectedOrigin: "https://site.example",
  expectedResource: "site:example",
  expectedCapabilities: ["read"],
  nonceStore: createLinkNonceStore(), // use a durable store in production
  mappings: createMappingStore(), // in-memory only, see below
  verifyClerkSession: async (token) => {
    // Site-owned: verify with your Clerk backend SDK and return { userId }.
    // Return null for an invalid session.
  },
  verifyLink,
  verifyLinkRevocation,
});
```

`verifyLink` and `verifyLinkRevocation` are not exported from the package
root in every version. Check the package exports before wiring. The real
`verifyLink` also needs `expectedCapabilities`, which the adapter passes on.

## Routes

All routes take `POST` with a JSON body and return
`{ "success", "data", "error" }`. Errors return `{ "code", "message" }` and
never include stack traces.

| Route               | Body                      | Success                   | Failures                                                                                                                                 |
| ------------------- | ------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /links`       | `{ proof, clerkSession }` | `201` mapping             | `400` bad input, `401` invalid session, `403` origin mismatch, `409` already linked, `415` not JSON, `422` invalid link, `413` too large |
| `POST /revocations` | `{ event }`               | `200 { linkId, removed }` | `400` bad input, `422` invalid revocation                                                                                                |

## Limits (honest scope)

- **In-memory only.** Mappings and revoked IDs reset when the process restarts.
  A real site needs a database with the same `add`, `get`, and `revoke` shape.
  The revoked-ID set also grows without bound in this example.
- **No revocation source.** A revocation only reaches sites that receive the
  signed event. Link lifetimes still bound any access the site has not seen
  revoked.
- **Replay protection depends on the nonce store.** Use a durable store in
  production.

## Tests

```sh
node --test examples/clerk-adapter/server.test.mjs
```
