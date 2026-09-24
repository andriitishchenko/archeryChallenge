# History, ranking, achievements, and client presentation

## FEAT-STATS-001 — Cumulative match rating and ranking

- Status: Implemented
- Scope: Stats routes/services and history screen.
- Goal / acceptance: Derive rating and leaderboard summaries from completed human matches on the server.
- Expected behavior and invariants: Tiebreak child matches are not independent matches; the browser renders server summaries rather than inferring rank from a limited local history.
- Enforcement and current behavior: Completed human match → server adds 10 participation points, 100 win points (40 for draw), bounded total-score quality bonus, and capped consecutive-win bonus → rating accumulates across normal matches from 0. History refresh → requests `/api/ranking/me` → cumulative rating/wins/average render; no-match rating is 0. Global ranking → calculates same rating and sorts by rating, wins, best streak, average, and match count → returns authoritative rank and personal summary.
- Regression coverage: No automated test suite is committed; verify calculations, tiebreak exclusion, sort tie-breakers, and empty-history display through API/UI checks.
- Remaining limits: No committed automated regression coverage.

## FEAT-STATS-002 — Historical win streak achievements

- Status: Implemented
- Scope: Achievement endpoint and history screen.
- Goal / acceptance: Award 5-, 10-, and 25-win streak badges based on completed parent matches.
- Expected behavior and invariants: Maximum historical consecutive streak is calculated; later loss or draw does not remove an already achieved lower threshold.
- Enforcement and current behavior: Achievement request → calculates historical maximum streak and evaluates each threshold independently → an achieved badge remains highlighted after subsequent results.
- Regression coverage: No automated test suite is committed; verify streak boundaries and persistence after loss/draw through API/UI checks.
- Remaining limits: Automated regression coverage is absent.

## FEAT-UI-001 — Mobile viewport and match result presentation

- Status: Implemented
- Scope: `frontend/index.html`, CSS, match result UI.
- Goal / acceptance: Keep the SPA usable in mobile/tablet viewports and present scoring/tiebreak results with their relevant base totals.
- Expected behavior and invariants: Scene scrolling remains available; total-score tiebreak popup keeps the base score separate from deciding arrows (see match behavior record).
- Enforcement and current behavior: Mobile browser viewport → enables edge-to-edge safe-area viewport and dynamic-height layout with manipulation touch handling → SPA fills the mobile/tablet viewport, avoids double-tap zoom, and allows scene scrolling.
- Regression coverage: No automated test suite is committed; viewport and result layout require browser/device visual verification.
- Remaining limits: Device/browser visual coverage is not committed.
