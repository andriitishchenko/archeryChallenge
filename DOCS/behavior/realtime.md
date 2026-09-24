# Realtime, matchmaking, rematch, and client recovery

## FEAT-REALTIME-001 — Single user socket, delivery, and diagnostics

- Status: Implemented
- Scope: `backend/ws/`, `frontend/js/core/ws.js`, `EventBus`, browser/server logging.
- Goal / acceptance: Route realtime match events through one authenticated user socket and recover eligible offline notifications.
- Expected behavior and invariants: One `/ws/user` connection per user session; frontend translates server event types before cross-module delivery. Offline queue is bounded.
- Enforcement and current behavior: User session → maintains one socket → server events pass through `ws.js` and `EventBus`. Offline notification → queues up to 50 messages per user → reconnect flushes queued messages. WebSocket lifecycle/routing → logger records connection, message, recipients, delivery/queue/failure. Browser API/socket send → console logs method/channel and result → tokens, passwords, secrets, and authorization values are redacted.
- Regression coverage: No automated test suite is committed; verify authenticated connection, routing, queue flush, and redaction in runtime checks.
- Remaining limits: No committed automated socket tests.

## FEAT-MATCHMAKING-001 — Quick Find and local bot fallback

- Status: Implemented
- Scope: WebSocket matchmaking, frontend match setup, shadow-bot helper.
- Goal / acceptance: Match compatible queued users or allow a local fallback match after waiting.
- Expected behavior and invariants: Repeated request replaces the same user's prior queue entry. Both matched clients derive identical scoring rules. The shadow bot is local-only and does not create a persisted match.
- Enforcement and current behavior: Matchmaking request → replaces prior user request and searches compatible profiles → one bot event is emitted after `BOT_WAIT_SECONDS` if no human is found. Quick Find → matching bow types use that bow defaults; mixed types use total scoring with 18 arrows → both clients share rules. Bot fallback → selects Compound total/15 arrows or Recurve Set System/3 arrows per set with 5:5 shoot-off based on profile → scoring is local and not stored server-side. The helper is loaded before scoring; bot arrows blend the latest player arrow with the bot's form/skill and signed skill-dependent spread, and round totals adapt to the series, completed rounds, history average, and skill. Finalization retains the exact bot arrows already shown and fills only missing restored positions; the result presents base score before deciding arrows.
- Regression coverage: No automated test suite is committed; verify queue replacement, same/different bow rules, fallback event uniqueness, bot completion, and absence of server persistence.
- Remaining limits: Bot algorithm behavior has no automated coverage; only current target discipline is fully implemented (see status index).

## FEAT-REMATCH-001 — Proposal, response, and cancellation

- Status: Implemented
- Scope: Rematch routes/services and challenge/match screens.
- Goal / acceptance: Completed-match opponents can propose and accept/decline or cancel a rematch.
- Expected behavior and invariants: Duplicate proposals are rejected; accepted rematches can be recovered by either waiting-rematch ID or original match ID. Cancelling removes the waiting rematch and makes it impossible to accept.
- Enforcement and current behavior: Proposal → creates private waiting rematch and notifies opponent with original match ID → duplicate proposals rejected. Accept/decline → resolves from waiting ID or original completed ID → accepted foreground rematch opens challenge screen; declined match is removed and original can be rematched again. Proposer cancellation → deletes waiting rematch/private challenge, resets proposal flag, sends `rematch_cancelled` → neither card remains and opponent cannot accept it.
- Regression coverage: No automated test suite is committed; verify duplicate, accept/decline recovery, cancellation, and card refresh through targeted API/UI checks.
- Remaining limits: Automated regression coverage is absent.

## FEAT-CLIENT-001 — Active-match cache and navigation recovery

- Status: Implemented
- Scope: `frontend/js/core/state.js`, challenge/match screens, local storage, status API.
- Goal / acceptance: Recover persisted active matches and keep parallel/background matches selectable without displaying stale state.
- Expected behavior and invariants: Server status supersedes stale cache. `STATE.activeMatches[matchId]` holds per-match state and `STATE.matchState` aliases selected match. Background events do not navigate away from the user's current screen.
- Enforcement and current behavior: Active match → cached in local storage → server status wins; empty bot sessions are discarded, while bot progress restores locally. Switch match → resets transient input/status/live preview then restores selected state → no state leaks from another match. Background event/completion → updates notification/resume/history/list → active screen stays selected. My Challenges refresh → only newest response updates list and omitted local matches reconcile via status → stale refresh cannot resurrect completed match. Resume of a completed visible card → removes local state and refreshes list → one informational toast.
- Regression coverage: No automated test suite is committed; verify reload recovery, parallel match switching, overlapping refreshes, and background completion via UI/API checks.
- Remaining limits: UI recovery behavior has no committed automated coverage.

## FEAT-CLIENT-002 — Live previews and contextual rematch notice

- Status: Implemented
- Scope: Frontend match input, WebSocket reconnect, notifications.
- Goal / acceptance: Keep opponent live preview complete across reconnect and show background rematch requests without hijacking the current screen.
- Expected behavior and invariants: Reconnect sends the current full arrow snapshot; a tiebreak preview uses one arrow, not the parent match count.
- Enforcement and current behavior: Arrow update/reconnect → sends changed value and full snapshot → missing opponent preview arrows are recovered. Total sudden-death preview → uses one-arrow size → opponent sees a single slot. Rematch proposal off the completion screen → shows toast and retains proposal in My Challenges → completion overlay appears only while match screen is displayed.
- Regression coverage: No automated test suite is committed; verify reconnect snapshots, tiebreak preview, and background proposal presentation.
- Remaining limits: Browser realtime behavior has no committed automated coverage.
