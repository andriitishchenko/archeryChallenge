# ArrowMatch — functional notes

This is a compact behavior ledger for implemented functionality. It protects existing requirements from being removed accidentally. It is not a roadmap; planned behavior belongs in `app_spec.txt`.

## Status snapshot — 2026-08-27

| Area | Status | Current evidence or gap |
| --- | --- | --- |
| Auth, guest mode, JWT, password reset, profile | Implemented | Routes and persistence exist; guest flow and password reset API smoke-tested. |
| Public/private challenges and filters | Implemented | Create, list, join, delete, invite-link, and notifications exist. |
| Total/set scoring, tiebreak, forfeit | Implemented | Server scoring and state transitions exist. |
| WebSocket events and matchmaking | Implemented | Single-user socket, human matching, single-shot bot fallback, offline queue, and bot-mode signalling exist. |
| Rematch flow | Implemented | Propose, accept, decline, and original-ID recovery exist. |
| Active match limit | Implemented | Server rejects creation/activation when either participant already has 10 open parent matches; tiebreak children do not consume another slot. |
| History, ranking, achievements | Implemented | Server endpoints calculate cumulative rating/stats; the history screen renders the server summary. |
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

- `start_server.sh` → installs the backend requirements into the current user's shared Python user-site and starts Uvicorn from `backend/` → multiple projects owned by that user can reuse the installed modules without creating a project-local virtual environment.
- App startup → creates the database schema if missing, checks `SCHEMA_VERSION`, and starts the expiry worker → an older schema is currently recreated from scratch.
- `POST /api/guest` → creates a guest user and returns access/refresh JWTs → the guest can enter gameplay without an account.
- Server restart → active match participants can be rebuilt from database rows when needed → WebSocket routing does not rely only on in-memory state.

### Authentication and profile

- Register with `existing_user_id` → upgrades the current guest row to a registered user → existing guest data remains attached to that user.
- Password reset request → creates a hashed, one-time token for a registered email and sends an expiring SMTP reset link → the response stays generic for unknown addresses and the token is never stored in plaintext.
- Password reset link → opens the reset form; submitting a valid new password → consumes the token and updates the account password → expired, reused, or invalid links are rejected and passwords are never emailed.
- Login or refresh → issues a new access/refresh token pair → invalid credentials or refresh tokens are rejected.
- Repeated register/login attempts → sliding-window IP rate limit applies → excess attempts receive HTTP 429.
- `PUT /api/profile` → creates or updates the authenticated user's profile → challenge creation and joining remain blocked until a profile exists.
- Browser session restore → validates `/api/auth/me`, reloads the profile, restores server matches, and opens the single user WebSocket → invalid sessions are cleared and return to entry.
- Page reload/close or browser/device Back with an unfinished match → requests native leave confirmation and keeps the SPA history sentinel when cancelled → the match remains available; leaving without an active match is not blocked.

### Challenges

- Public challenge list → returns active public challenges and excludes the current user's own challenges → profile, bow, distance (18m, 25m, 30m, 50m, 60m, 70m, or 90m), and country filters are applied.
- Create a public challenge → persists it and broadcasts `new_challenge` → connected users can refresh the list without polling for creation.
- Join a challenge → creates an active match with both participants, deactivates the challenge, and notifies the creator with `opponent_joined` → a user cannot join their own or expired challenge.
- Join a challenge or propose/accept a rematch → the server counts each participant's unfinished parent matches → the operation returns HTTP 409 at 10 open matches per user; an automatic tiebreak child does not consume an additional slot.
- Delete a challenge → removes it from the public feed and broadcasts `challenge_removed` → an in-progress match prevents deletion until it is forfeited.
- Scheduled challenge deadline passes with no active match → expiry worker deactivates it and sends `challenge_expired` → private/public notification behavior remains distinct.

### Match and scoring

- One user session → maintains one `/ws/user` connection → server events are routed through `frontend/js/core/ws.js` and `EventBus`.
- WebSocket connect, receive, route, send, queue, failure, and close → logger `arrowmatch.websocket` records the user, message type, match ID, recipients, and payload → server logs show whether a message arrived, was routed, sent, queued offline, or failed.
- Browser API or WebSocket send → the browser console records the method/channel, target, payload, and send/skip status → authentication tokens, passwords, and secrets are redacted from diagnostics.
- Live arrow input or WebSocket reconnect → client sends the current full arrow snapshot with the changed arrow and replays it after reconnect → the opponent's preview recovers missing arrows instead of retaining a sparse series.
- Total-score sudden death live preview → uses the one-arrow tiebreak size instead of the parent match arrow count → the opponent sees `[10]: 10`, not the original multi-arrow slots.
- Final arrow entered → client waits 600 ms before automatic submission and keeps DEL enabled → the player can correct the last input before the score is sent.
- Double-tap on an entered arrow or press DEL → client clears that arrow, restores it as the active input, and sends a null live-preview update → the value is removed locally and is not submitted while the correction window is active.
- Total-score submission → stores the player's arrow values and waits for the opponent → the server resolves win/loss when both scores exist.
- Equal total scores → keeps the parent match unresolved and starts a tiebreak child match → tiebreak data is linked to the parent match.
- One tiebreak arrow submitted while the opponent is still pending → keeps the submitted arrow visible and locks the input → a new arrow is requested only after both players submit equal values.
- Page reload during a total-score tiebreak → `/api/matches/{id}/status` returns the active tiebreak stage and child ID, then the frontend renders the restored state → the one-arrow sudden-death UI is preserved instead of returning to the parent match's original arrow count.
- Completed total-score tiebreak → parent status keeps the original total scores and returns the final tiebreak arrows → the completion popup shows consistent totals and tiebreak values on both clients.
- Set submission → stores the set arrows and resolves the set when both players submit the same set → points follow 2 for win, 1 for draw, 0 for loss; the first archer to reach 6 set points wins and a regular match lasts 3–5 sets.
- Set score reaches 5:5 → persists Set System sudden death as set_number=0, broadcasts the transition, and each client immediately confirms the authoritative 5:5 score through `/status` before continuing → both clients show 5:5 in the one-arrow input, equal arrows reset the round, and a non-equal pair awards the sixth set point and completes the parent match.
- Set arrow submission → disables the local score buttons until the opponent result event or status response arrives → the client never resubmits cleared arrows and cannot send an empty set that the API rejects with 422.
- Both set or sudden-death arrows persisted without a resolution event → the next status request identifies the last set by stored set points, reconciles every ready pair, and waiting clients retry status until the authoritative state changes → the set advances/resolves or the sudden-death round resets instead of remaining on “Both submitted — calculating result…”.
- Overlapping match status requests → only the newest response updates the local match state → a stale pre-transition response cannot replace the authoritative 5:5 sudden-death score.
- Completed Set System sudden death → the result popup renders the set points and the final sudden-death arrow score → the sudden-death line is omitted when no tiebreak occurred.
- Forfeit → marks the player as loss, the opponent as win, completes the match, and notifies the opponent → a completed match cannot be forfeited again.
- Match inactivity → expiry worker completes a stale no-activity match as draw or awards win/loss to the timely submitter → notifications explain the timeout.
- Opponent disconnects → connected opponents receive `opponent_disconnected` → match data remains persisted for recovery.

### Matchmaking and rematch

- Matchmaking request → replaces any previous request for the same user and searches compatible queued profiles → if no human match is found after `BOT_WAIT_SECONDS`, one bot fallback event is emitted with `is_bot=true` and the client starts a non-persisted bot match.
- Offline notification → queues up to 50 messages per user → queued messages flush when that user reconnects.
- Rematch proposal → creates a private waiting rematch match and notifies the opponent with the original match ID → duplicate proposals are rejected and the client can associate the request with the correct completed match.
- Rematch accept/decline → accepts either the waiting rematch ID or the original completed match ID → both sides receive the corresponding event, the accepted foreground rematch opens on the challenge screen, the declined match is removed, and the original match can be rematched again.
- Rematch cancellation by proposer → deletes the waiting rematch and its private challenge, resets the original match proposal flag, and notifies the opponent with `rematch_cancelled` → both My Challenges cards disappear and the opponent cannot accept the cancelled request.

### History, ranking, and client state

- Completed human matches → the server adds 10 participation points, 100 win points (40 for a draw), a bounded total-score quality bonus, and a capped consecutive-win bonus → rating starts at 0, accumulates across normal matches, and tiebreak children are not counted as separate matches.
- History screen refresh → requests `/api/ranking/me` and renders its cumulative rating, wins, and average score → a user with no completed match displays rating 0; the client no longer derives a fake rank from only the last 10 local entries.
- Global ranking request → server calculates the same cumulative rating for every completed human normal match and sorts by rating with wins, best streak, average score, and match count as tie-breakers → `/api/ranking` returns authoritative rating/rank values and `/api/ranking/me` returns the current user's summary.
- Achievement request → calculates the maximum historical consecutive-win streak from completed parent matches and evaluates 5, 10, and 25-win badges independently → once a streak has occurred, a later loss or draw does not un-highlight the smaller completed streak badge.
- Active match state → is kept in `STATE.activeMatches[matchId]` and cached in local storage for session recovery → server status wins over stale browser cache, empty local-only bot sessions are discarded, and a bot session with input progress restores its controls without a server status request.
- Starting or switching to a match → resets the local arrow input, shared status message, and transient opponent live-result indicator, then restores only the selected match's server state → a parallel or rematch session cannot display scores, waiting text, or stale live preview carried over from the previously displayed match.
- Background match event → shows a notification and updates the resume indicator without switching away from the current screen → active match remains selectable.
- Background match completion → resolves the authoritative result, records it in history, and shows a win/loss/draw toast without switching screens → the resume indicator and My Challenges list are refreshed.
- Navigation to My Challenges while a match is active → refreshes server match metadata while retaining transient scoring/tiebreak flags → later WebSocket events continue to resolve the background match.
- Resume for a match completed while its dashboard card was visible → removes the stale local match and refreshes My Challenges when the server no longer returns it → the user sees one informational toast and cannot keep reopening the finished session.
- Overlapping My Challenges refreshes → only the newest server response updates state and the rendered list, and omitted local matches are reconciled through `/status` → an older in-flight response cannot restore a completed match card and a missed completion event still records/removes the match.
- Background tiebreak event → retains the tiebreak stage and shows a notification without opening the match screen → the player can resume the match from the resume indicator.
- Rematch proposal received outside the completion screen → shows a rematch toast and keeps the proposal available in My Challenges → the completion overlay is only used when the match screen is currently displayed.
- Set score tied at 5:5 → broadcasts `set_tiebreak_started` with both participants' points and current first-to-act value, then clients refresh `/status` → both players enter the same authoritative 5:5 sudden-death state, including after a page reload or while one is viewing another screen.
- Bot/offline fallback → loads the current shadow-bot helper before the scoring UI, selects Compound total scoring with 15 arrows (5 rounds × 3) or Recurve Set System scoring with 3 arrows per set and a 5:5 shoot-off from the user's bow profile, and calculates each next bot arrow from the latest entered player arrow blended with the bot's own form, skill coefficient, and a wider signed skill-dependent spread, then adapts round totals to the current series, completed bot rounds, historical average, and skill profile → cached script versions cannot leave scoring without `botShadowShoot`, the completion popup always renders the base score first and the deciding sudden-death arrows second, finalization scores the exact bot arrow array already shown during the round and only fills missing restored positions, total-mode sudden death keeps the tied base score and shows the deciding arrows separately, bot arrows and round totals can land noticeably above or below the player's result instead of nearly mirroring it, and the bot remains local-only rather than persisted server data.

## Explicit current limits

- `target` is the only fully implemented discipline; other discipline enum values are placeholders.
- The schema-version guard recreates an older development database; there is no production migration system yet.
- There is no committed automated test suite; behavior changes require targeted API and UI verification.
