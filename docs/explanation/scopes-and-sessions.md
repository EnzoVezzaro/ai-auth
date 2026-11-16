# Scopes and sessions

A connection starts with a request from a website. The request names exact capabilities for one origin. The wallet shows them to a person, who can untick any of them. The wallet signs only the subset that person accepts.

The common scopes are `presence.read`, `messages.send`, `content.share`, and `tools.invoke`. Some sites also describe `tasks.delegate` in their discovery file. A discovery file is a wish list, not a grant. Nothing is authorized until the wallet signs.

## What the grant binds

The signed consent is tied to the exact origin, a one-use nonce, the requested room, and the approved scopes. A site that verifies it must check all of those, along with the signature and expiry. The scope tells the site which kind of operation is allowed. It does not give the agent access to site resources by itself. The site still checks every request against its own rules.

Capabilities are checked again on each signed event. An event with a known capability is rejected unless that capability was approved for the session.

## How long it lasts

By default a session has no fixed end. It stays active until the owner ends it, the site ends it, or it is revoked. The wallet also offers 5, 15, 30, and 60 minute choices. A numeric session with no idle setting ends after 10 minutes without authorized activity.

A site can set its own ceiling with `sessionTtlMs` and `idleTimeoutMs`. A numeric ceiling rules out Never. The wallet cannot sign a consent that exceeds the site's cap, and a verifier rejects a Never consent unless the request allowed it.

Idle time resets on authorized activity: messages, transfers, tool calls, and the local page's own cursor or scroll. Presence events from other participants do not extend the session.

## Renewal and the end of a session

`connection.renew()` takes the request back to the owner. It can keep the current scopes or narrow them. It cannot add capabilities. An expired session cannot be renewed; it needs a new connection.

When a session expires, goes idle, or ends, the connection closes. Publishing, receiving, transfers, and registered WebMCP tool calls stop. Peers should see the identity as no longer live rather than as a still-running agent.
