# Interaction Wheel — UX and capability verification proposal

Status: review/design PR only. Do not claim existing functionality works or is missing without tracing the implementation and running tests.

## Product intent

The **Interaction Wheel** is the single, contextual action launcher for **all supported interactions** a person can initiate with agents and people connected to the current website/room. It should not be a decorative radial menu or expose cryptographic/protocol internals. The selected target and current permissions determine which actions appear as available.

## User flow

1. On a website using AI Auth, open the Interaction Wheel from a persistent but unobtrusive affordance, keyboard shortcut or participant entry.
2. Select a target: specific connected agent, human participant, selected group, or room. Display verified identity, owner association when provable, and live/offline state.
3. The wheel shows available actions in a small first ring; overflow/secondary actions are in a second ring or accessible list. On narrow screens, use an accessible sheet/list rather than cramming radial slices.
4. Choose an action. If already authorized, execute immediately with a clear state; if a new scope is needed, show a targeted approval request. If unavailable, show the exact reason and next step.
5. Surface ongoing interactions (chat, screen share, collaboration) with visible stop/end controls and a persistent indicator. Closing the wheel must not silently stop a session.

## Interaction catalog (capability-driven; verify support before enabling)

| Category           | Actions                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Communication      | Direct chat with agent, room chat, human-to-human message, mention, send prompt/instruction, reply, voice conversation where supported                                                              |
| Screen and context | Share screen/window/tab with a **selected agent**, stop sharing, share a selected file, link, text selection, screenshot or application context                                                     |
| Collaboration      | Invite agent to current room/task, hand off a task, ask agent to inspect page state, request a summary, co-browse/navigate, point to an element, follow cursor, annotate, shared pointer            |
| Agent operations   | Request an allowed site tool, delegate a scoped task to a subagent, request status/progress, pause/resume/cancel work, inspect recent signed activity                                               |
| People and trust   | View verified identity and owner, see agent parent/child relationship, view current capabilities, request additional scoped access, revoke a grant, disconnect, report/block where site supports it |
| Room and presence  | See online participants, filter agents/people, switch rooms, invite participants, mute/hide presence, privacy mode                                                                                  |
| Session controls   | Reconnect, inspect session duration, end interaction, review active shares, audit recent actions                                                                                                    |

All catalog entries are **candidate UX affordances**, not claims that the current SDK implements them. Unsupported actions must be hidden or disabled with honest explanation, not simulated. Site-specific actions can be registered as extensions through a capability/action registry.

## Security and privacy requirements

- Sharing a screen requires a deliberate user gesture, browser permission and a clearly identified recipient; never auto-start or silently expand the recipient list. Show persistent sharing indicator and one-click stop. Screen capture and transport need a separate technical feasibility check; existing signed WebRTC data messages do not prove video-track support.
- Agent access to a site is constrained by origin, room, scoped grants, session lifetime and the site's own policy. Presence alone never grants tool or screen access.
- No false owner verification: distinguish cryptographically verified association from untrusted self-reported labels.
- Do not show private-mode participants beyond the established visibility policy; restricted room membership is enforced independently of the wheel.
- Wheel actions must respect live peer state; queue/offline actions only if explicitly supported and labeled.
- Accessibility: full keyboard operation, focus return, Escape to close, screen-reader action names, reduced motion, touch target sizes, responsive fallback, no hover-only functionality.

## Verification tasks for the implementation agent

1. Locate all existing interaction controls, participant menus, collaboration overlays, chat surfaces, capability gates and current wheel implementations (if any).
2. Inventory existing actions and map each to actual SDK capability, backend/tool transport, target type, permission requirements, error states and test coverage.
3. Test interaction targeting: one agent, multiple agents, a human and room; ensure actions never go to the wrong peer.
4. Test direct chat and room messaging using authenticated live peers, with offline and revoked negative cases.
5. Test screen sharing **only if implemented**; otherwise report a specific implementation gap and browser permissions/transport design needed.
6. Test responsive and accessible wheel/list UI, including 20+ registered actions without overcrowding.
7. Confirm every ongoing action has observable start/stop/progress/error state and that site-specific extensions cannot bypass authorization.
8. Publish a gap matrix: action, exists?, code path, proof/test, pass/fail/blocked, severity and implementation recommendation. Add screenshots and actual E2E assertions.

## Acceptance criteria

- The wheel provides one discoverable entry point for all _available_ interactions, without forcing users to understand rooms, relays, signatures or grants.
- A user can choose a particular connected agent and start a permitted direct chat; the recipient is unambiguous.
- If screen sharing is supported, it is explicitly approved, target-specific and stoppable; if unsupported, that limitation is documented and not represented as working.
- Capability changes update available actions without page refresh; no unauthorized action can execute.
- Large catalogs remain usable on desktop, mobile and assistive technology.
- Existing interaction mechanisms are reused rather than duplicated; findings are grounded in executed tests.

## Scope

This PR is a **review contract and verification checklist**, not a wheel implementation. Implement confirmed gaps in follow-up PRs after the audit. Coordinate with PR #17 (session/subagent identity) and PR #18 (connection/presence verification), without conflating those scopes.
