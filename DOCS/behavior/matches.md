# Match scoring and lifecycle behavior

## FEAT-MATCH-001 — Total scoring and total-score tiebreak

- Status: Implemented
- Scope: Match routes/services, tiebreak service, WebSocket events, match frontend.
- Goal / acceptance: Persist and resolve total scores; tied scores proceed through a sudden-death child match.
- Expected behavior and invariants: Server scores are authoritative. Equal base totals keep the parent unresolved; the child match is linked to its parent. A submitted tiebreak arrow remains visible and locked until both players submit; reload restores the one-arrow stage. Completion presents base scores and deciding arrows consistently.
- Enforcement and current behavior: Total submission → stores arrows and waits for opponent → server resolves when both scores exist. Equal totals → starts a tiebreak child → parent remains unresolved. One child arrow pending → locks input and preserves the value → another is requested only after equal paired arrows. Status recovery → returns active child/stage and final deciding arrows → clients restore or render the correct stage/results.
- Regression coverage: No automated test suite is committed; verify scoring, equal-score transitions, concurrent submissions, reload recovery, and both clients' results with API/UI checks.
- Remaining limits: Browser end-to-end and concurrent-client verification are not represented by committed tests.

## FEAT-MATCH-002 — Set System and sudden death

- Status: Implemented
- Scope: Match/tiebreak services, match status API, WebSocket, set-mode client.
- Goal / acceptance: Resolve regular sets, award set points, and continue a 5:5 tie into one-arrow sudden death.
- Expected behavior and invariants: Set points are 2/1/0 for win/draw/loss; first to 6 wins; a regular match lasts 3–5 sets. Set System sudden death persists as `set_number=0`. Clients use authoritative status when events are missed or requests overlap.
- Enforcement and current behavior: Set submission → persists arrows and resolves after both submit → applies 2/1/0 points. At 5:5 → persists sudden-death state, broadcasts transition, and clients confirm through `/status` → equal arrows reset the round; unequal arrows award the sixth point and complete the match. Ready arrow pairs without an event → status reconciles → match advances/resolves rather than waiting indefinitely. Overlapping status requests → newest response wins → stale state cannot overwrite 5:5. Completion → renders set points and final shoot-off score → omits sudden-death line when none occurred.
- Regression coverage: No automated test suite is committed; verify set progression, 5:5 reload/event recovery, concurrent status requests, and UI score rendering.
- Remaining limits: Automated regression coverage is absent.

## FEAT-MATCH-003 — Match input, correction, and forfeits

- Status: Implemented
- Scope: Match API and frontend score input.
- Goal / acceptance: Let users correct their final arrow before submission and complete matches consistently on forfeit.
- Expected behavior and invariants: Clearing a live preview is not score submission. A completed match cannot be forfeited again.
- Enforcement and current behavior: Final arrow → waits 600 ms before automatic submission while DEL remains enabled → player can correct it. Double-tap/DEL → clears the arrow and sends a null preview → corrected value is not submitted during the correction window. Forfeit → marks requester loss/opponent win, completes match, and notifies opponent → completed match cannot be forfeited again.
- Regression coverage: No automated test suite is committed; verify correction window/null preview and forfeit authorization/result through API/UI checks.
- Remaining limits: Automated regression coverage is absent.

## FEAT-MATCH-004 — Inactivity and disconnect handling

- Status: Implemented
- Scope: Expiry worker and WebSocket manager.
- Goal / acceptance: Resolve inactive matches and notify connected opponents when a player disconnects.
- Expected behavior and invariants: Match data remains persisted and recoverable after disconnect; inactivity outcome depends on whether a participant submitted in time.
- Enforcement and current behavior: Match inactivity threshold reached → expiry worker completes a stale match as draw or awards the timely submitter a win → timeout notifications are sent. Opponent disconnect → connected opponent receives `opponent_disconnected` → match data remains available for recovery.
- Regression coverage: No automated test suite is committed; verify expiry outcomes and disconnect notification/recovery in targeted runtime checks.
- Remaining limits: Worker timing and socket behavior have no committed automated coverage.
