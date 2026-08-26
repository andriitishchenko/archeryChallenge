# ArrowMatch — functional notes

This is a compact behavior ledger for implemented functionality. It protects existing requirements from being removed accidentally. It is not a roadmap; planned behavior belongs in `app_spec.txt`.

## Status snapshot — 2026-08-26

| Area | Status | Current evidence or gap |
| --- | --- | --- |
| Auth, guest mode, JWT, profile | Implemented | Routes and persistence exist; guest flow smoke-tested. |
| Public/private challenges and filters | Implemented | Create, list, join, delete, invite-link, and notifications exist. |
| Total/set scoring, tiebreak, forfeit | Implemented | Server scoring and state transitions exist. |
| WebSocket events and matchmaking | Implemented | Single-user socket, human matching, offline queue, and bot fallback exist. |
| Rematch flow | Implemented | Propose, accept, decline, and original-ID recovery exist. |
| History, ranking, achievements | Implemented | Server endpoints and frontend rendering exist. |
| Expiry and inactivity handling | Implemented | Background worker handles deadlines and stale matches. |
| Scheduled-match start semantics | Partial | Deadline validation exists, but joining starts the match immediately. |
| Non-target disciplines | Partial | Enum values exist, but server scoring rejects them with HTTP 501. |
| Account deletion/reset | Planned | Requirement is in `app_spec.txt`; no route or UI flow exists. |
| Production database migrations | Planned | Current schema-version mismatch recreates the database. |
| Automated test suite | Planned | No committed test suite exists yet. |

The snapshot is based on source inspection plus a temporary-database smoke test of `/health`, `POST /api/guest`, and the generated OpenAPI route list. It is not a substitute for full browser end-to-end verification.

## How to maintain this file

For every user-visible or automatic behavior, record:

`Trigger → automatic behavior → result/guard`

Keep notes short and factual. Update this file in the same change whenever a route, event, state transition, background task, or fallback behavior changes. Never remove an implemented note unless the user explicitly requests a behavior change and all dependent code and docs are updated.

## Implemented behavior

### Startup and persistence

- App startup → creates the database schema if missing, checks `SCHEMA_VERSION`, and starts the expiry worker → an older schema is currently recreated from scratch.
- `POST /api/guest` → creates a guest user and returns access/refresh JWTs → the guest can enter gameplay without an account.
- Server restart → active match participants can be rebuilt from database rows when needed → WebSocket routing does not rely only on in-memory state.

### Authentication and profile

- Register with `existing_user_id` → upgrades the current guest row to a registered user → existing guest data remains attached to that user.
- Login or refresh → issues a new access/refresh token pair → invalid credentials or refresh tokens are rejected.
- Repeated register/login attempts → sliding-window IP rate limit applies → excess attempts receive HTTP 429.
- `PUT /api/profile` → creates or updates the authenticated user's profile → challenge creation and joining remain blocked until a profile exists.
- Browser session restore → validates `/api/auth/me`, reloads the profile, restores server matches, and opens the single user WebSocket → invalid sessions are cleared and return to entry.

### Challenges

- Public challenge list → returns active public challenges and excludes the current user's own challenges → profile, bow, distance, and country filters are applied.
- Create a public challenge → persists it and broadcasts `new_challenge` → connected users can refresh the list without polling for creation.
- Join a challenge → creates an active match with both participants, deactivates the challenge, and notifies the creator with `opponent_joined` → a user cannot join their own or expired challenge.
- Delete a challenge → removes it from the public feed and broadcasts `challenge_removed` → an in-progress match prevents deletion until it is forfeited.
- Scheduled challenge deadline passes with no active match → expiry worker deactivates it and sends `challenge_expired` → private/public notification behavior remains distinct.

### Match and scoring

- One user session → maintains one `/ws/user` connection → server events are routed through `frontend/js/core/ws.js` and `EventBus`.
- WebSocket connect, receive, route, send, queue, failure, and close → logger `arrowmatch.websocket` records the user, message type, match ID, recipients, and payload → server logs show whether a message arrived, was routed, sent, queued offline, or failed.
- Browser API or WebSocket send → the browser console records the method/channel, target, payload, and send/skip status → authentication tokens, passwords, and secrets are redacted from diagnostics.
- Total-score submission → stores the player's arrow values and waits for the opponent → the server resolves win/loss when both scores exist.
- Equal total scores → keeps the parent match unresolved and starts a tiebreak child match → tiebreak data is linked to the parent match.
- One tiebreak arrow submitted while the opponent is still pending → keeps the submitted arrow visible and locks the input → a new arrow is requested only after both players submit equal values.
- Page reload during a total-score tiebreak → `/api/matches/{id}/status` returns the active tiebreak stage and child ID, then the frontend renders the restored state → the one-arrow sudden-death UI is preserved instead of returning to the parent match's original arrow count.
- Completed total-score tiebreak → parent status keeps the original total scores and returns the final tiebreak arrows → the completion popup shows consistent totals and tiebreak values on both clients.
- Set submission → stores the set arrows and resolves the set when both players submit the same set → points follow 2 for win, 1 for draw, 0 for loss; first to 6 wins.
- Set score reaches 5:5 → starts sudden-death tiebreak scoring → one arrow is compared and equal arrows repeat.
- Forfeit → marks the player as loss, the opponent as win, completes the match, and notifies the opponent → a completed match cannot be forfeited again.
- Match inactivity → expiry worker completes a stale no-activity match as draw or awards win/loss to the timely submitter → notifications explain the timeout.
- Opponent disconnects → connected opponents receive `opponent_disconnected` → match data remains persisted for recovery.

### Matchmaking and rematch

- Matchmaking request → searches compatible queued profiles → if no human match is found after `BOT_WAIT_SECONDS`, a bot opponent is generated.
- Offline notification → queues up to 50 messages per user → queued messages flush when that user reconnects.
- Rematch proposal → creates a private waiting rematch match and notifies the opponent with the original match ID → duplicate proposals are rejected and the client can associate the request with the correct completed match.
- Rematch accept/decline → accepts either the waiting rematch ID or the original completed match ID → both sides receive the corresponding event and the declined match is removed.

### History, ranking, and client state

- Completed human matches → appear in history and contribute to ranking → tiebreak child matches are not counted as separate normal matches.
- Achievement request → calculates the maximum historical consecutive-win streak from completed parent matches and evaluates 5, 10, and 25-win badges independently → once a streak has occurred, a later loss or draw does not un-highlight the smaller completed streak badge.
- Active match state → is kept in `STATE.activeMatches[matchId]` and cached in local storage for session recovery → server status wins over stale browser cache.
- Background match event → shows a notification and updates the resume indicator without switching away from the current screen → active match remains selectable.
- Background match completion → resolves the authoritative result, records it in history, and shows a win/loss/draw toast without switching screens → the resume indicator and My Challenges list are refreshed.
- Navigation to My Challenges while a match is active → refreshes server match metadata while retaining transient scoring/tiebreak flags → later WebSocket events continue to resolve the background match.
- Resume for a match completed while its dashboard card was visible → removes the stale local match and refreshes My Challenges when the server no longer returns it → the user sees one informational toast and cannot keep reopening the finished session.
- Overlapping My Challenges refreshes → only the newest server response updates state and the rendered list, and omitted local matches are reconciled through `/status` → an older in-flight response cannot restore a completed match card and a missed completion event still records/removes the match.
- Background tiebreak event → retains the tiebreak stage and shows a notification without opening the match screen → the player can resume the match from the resume indicator.
- Rematch proposal received outside the completion screen → shows a rematch toast and keeps the proposal available in My Challenges → the completion overlay is only used when the match screen is currently displayed.
- Set score tied at 6:6 → broadcasts `set_tiebreak_started` to both participants → both players can enter the sudden-death arrow even if one is viewing another screen.
- Bot/offline fallback → supports local gameplay when the real opponent path is unavailable → it is not a substitute for persisted server data.

## Explicit current limits

- `target` is the only fully implemented discipline; other discipline enum values are placeholders.
- The schema-version guard recreates an older development database; there is no production migration system yet.
- There is no committed automated test suite; behavior changes require targeted API and UI verification.
