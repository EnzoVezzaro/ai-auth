# Verification plan: approved agent connection, autonomous operation and shared presence

Status: **verification-only proposal**. The requested behaviors are intended existing product requirements, not presumed missing features. Do not redesign or implement until the tests identify a reproducible gap.

## Expected end-to-end behavior

1. A website embeds the AI Auth SDK and displays **Connect agent**.
2. The user copies the connection instruction/link and passes it to a supported agent session.
3. The agent has a wallet identity (existing or provisioned), proves key possession and receives a scoped connection request.
4. The owner approves connection in the wallet popup; the website verifies signed consent for its exact origin, room, nonce, scopes and expiry.
5. The approved relationship is recorded and survives a page reload when still valid. The live transport is maintained where possible, or explicitly re-established according to the existing resume policy. **Do not mislabel a saved grant as a live connection.**
6. While the agent runtime is alive, its authorization remains valid and it has a reachable site action interface, it can operate on that site with or without the human owner browsing the page. No new per-action consent should be needed for ordinary actions already covered by the approved policy; privileged operations still obey site-side authorization and human approval requirements.
7. In the shared authorized room, users can see the presence of participating humans and agents, plus each agent's owner **when that ownership link is verified**. Display privacy mode and visibility policy correctly; do not claim all visitors can see all participants across rooms.
8. Expiry, revocation, loss of live transport, page close and agent process exit have distinct visible states and effects.

## Verification matrix

| Scenario | Expected result | Evidence |
| --- | --- | --- |
| SDK integration and connect UI | Connect action and copyable instruction work | Browser E2E screenshot + assertions |
| First wallet connection | Approval popup; origin, scopes and duration are explicit | Browser E2E + consent signature assertions |
| Reconnect to approved site | Grant remains recorded; resume follows existing policy; no silent privilege expansion | Reload and resume test |
| Identity vs authorization vs online | Distinct states; online only on authenticated live WebRTC channel | State-machine test and transport logs |
| Agent works with owner browsing | Authorized site actions execute and are audited | Browser E2E with human present |
| Agent works after owner leaves | Headless runtime remains live; site action remains available only if its host is running | Headless E2E; distinguish page-hosted tools from server/headless tools |
| Agent performs ordinary allowed actions | Existing approved capabilities suffice when policy allows; sensitive actions require additional site approval | Positive and negative tool-call tests |
| Shared human and agent presence | Correct room membership and online/offline state | Multi-client browser E2E |
| Agent ownership display | Verified owner binding is shown; unverified claims are labeled or hidden | Signature/attestation tests |
| Restricted/private rooms | Visibility follows policy; private mode not misrepresented as anonymity | Privacy E2E |
| Disconnect, expiry, revocation | Operations cease as dictated by signed policy; offline and unauthorized remain distinct | Lifecycle tests |
| Network interruption | UI reports degraded/offline; no fabricated connected state | WebRTC fault injection |

## Current architectural constraints to check, not erase

- The existing documented page-hosted WebMCP tools stop when the hosting page closes. Autonomous work without the human's browser needs an independently available site endpoint/tool host or a still-running browser context.
- The existing SDK requires site approval for page tool actions; verify whether this matches the desired once-approved autonomous policy and explicitly report the mismatch rather than silently weakening the security boundary.
- The documented SDK does not silently resume after reload; the site offers a Resume click. Verify and report whether product requirements demand a different UX.
- Open rooms are not access control. Presence and owner association must not disclose unverified or unauthorized data.
- WebRTC connectivity can fail across restrictive NATs without TURN. Do not equate authorization with reachability.
- A wallet signature proves key possession, not real-world ownership. Verified owner-to-agent association needs its own signed evidence and trust definition.

## Review workflow

1. Trace implementation files for SDK connect modal/panel, wallet consent, session persistence/resume, connection state, headless runtime, presence, WebMCP authorization and ownership.
2. Run existing unit, browser E2E and multi-agent E2E tests. Record exact commands, environment, commit SHA and results; do not infer success from documentation.
3. Add targeted regression tests for the matrix above where evidence is absent.
4. Produce a gap table: requirement, code path, test evidence, pass/fail/blocked, severity and recommended fix.
5. Keep this PR verification-focused. File separate implementation changes only for confirmed gaps, with explicit security review for authorization semantics.

## Acceptance for closing verification

All matrix rows have reproducible evidence or an explicit documented limitation, and discrepancies between the expected user experience and the current security/session model are recorded. No assertion that features are working without executed evidence.
