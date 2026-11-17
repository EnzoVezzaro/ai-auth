# Site discovery: `/.well-known/ai-auth.json`

**This is an AI Auth convention. It is not a WebMCP standard.** WebMCP is a browser API a page uses to register tools. It defines no discovery file, and this document does not claim otherwise. The file below only tells an agent where an AI Auth site wants to be reached. It is optional; a site works without it.

## What it is and is not

- **Public and unsigned.** Anyone can serve or edit it, and a fetch proves nothing about the site's identity beyond "this origin served these bytes over TLS". It is a hint, never consent. Access still requires a signed wallet approval bound to the exact origin (see `WIRE_FORMAT.md`).
- **Not a secret store.** The validator rejects documents that contain credentials, private keys, tokens, or anything shaped like one. Never put bearer tokens, session keys, or private page data in it.
- **No new server.** The file is static. AI Auth operates no registry; agents fetch it directly from the site.

## Schema v1

```json
{
  "type": "ai-auth-discovery",
  "v": 1,
  "origin": "https://site.example",
  "name": "Example site",
  "walletUrl": "https://wallet.example/",
  "docsUrl": "https://site.example/docs/agents",
  "capabilities": ["presence.read", "tools.invoke"],
  "rooms": [{ "name": "research", "mode": "restricted" }],
  "issuers": ["agent:..."],
  "webmcp": true
}
```

| Field          | Rule                                                                                                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`, `v`    | Required: `"ai-auth-discovery"`, `1`.                                                                                                                                                                                                                                                                                |
| `origin`       | Required. Must equal the origin the file was fetched from, exactly (scheme, host, port).                                                                                                                                                                                                                             |
| `name`         | Optional, at most 80 characters. A claim.                                                                                                                                                                                                                                                                            |
| `walletUrl`    | Optional URL, `https`, or `http` for localhost only. No credentials or query string.                                                                                                                                                                                                                                 |
| `docsUrl`      | Same URL rule.                                                                                                                                                                                                                                                                                                       |
| `capabilities` | Optional unique subset of `presence.read`, `messages.send`, `content.share`, `tools.invoke`, `tasks.delegate`. A wish list, not a grant. `tasks.delegate` is still accepted for compatibility but is no longer offered as a default choice: no task or command protocol exists yet, so it grants no working handoff. |
| `rooms`        | Optional, at most 8 of `{ name, mode }`; `mode` is `open` or `restricted`. Room names are public metadata, not access control.                                                                                                                                                                                       |
| `issuers`      | Optional, at most 8 wallet ids the site says issue memberships. A claim; trust policy stays local to the verifier.                                                                                                                                                                                                   |
| `webmcp`       | Optional boolean: the page registers WebMCP tools.                                                                                                                                                                                                                                                                   |

Unknown fields are rejected, so the schema can only grow with a version bump.

## Fetching safely

`fetchDiscovery(origin)` requests `<origin>/.well-known/ai-auth.json` with `redirect: "error"`, no credentials, no referrer, and a timeout. It requires a JSON content type, caps the body at 16 KiB, and requires the document's `origin` to equal the requested origin. The requested origin must be `https`, or `http` for `localhost`, `127.0.0.1` and `[::1]`. Any failure returns `{ ok: false, reason }`; nothing is guessed or partially accepted.

## Relation to other conventions

- **`llms.txt`** is human-readable guidance for language models about a site's content. It is read as text and has no security semantics. `ai-auth.json` is machine-validated connection metadata. They are independent; a site can link one from the other.
- **OAuth protected-resource metadata (RFC 9728)** describes which authorization servers protect an HTTP resource and how to obtain bearer tokens. AI Auth has no bearer-token flow and no authorization server in the base product, so this file does not replace or imitate it. A site that also runs OAuth should publish its own protected-resource metadata separately.
- **WebMCP** is the in-page tool API. `webmcp: true` merely says tools may exist; the tool catalog is still exchanged over the signed room and each call still needs human approval.

## Failure reasons

`bad-origin`, `no-fetch`, `http-error`, `bad-content-type`, `too-large`, `bad-json`, `fetch-failed` (network error, redirect, or timeout), then validation reasons: `not-an-object`, `unknown-field`, `not-a-v1-document`, `origin-mismatch`, `contains-secret`, `bad-name`, `bad-walletUrl`, `bad-docsUrl`, `bad-capabilities`, `bad-rooms`, `bad-issuers`, `bad-webmcp`.
