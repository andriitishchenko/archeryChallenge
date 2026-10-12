# ArrowMatch — behavior status index

This file is the compact status index for current implemented behavior. Detailed expectations, enforcement boundaries, regression scenarios, and limitations are maintained in the linked [component behavior records](DOCS/behavior/README.md). This is not a change log; planned requirements belong in [`app_spec.txt`](app_spec.txt).

## Current status

| Area | Status | Canonical behavior record / evidence boundary |
| --- | --- | --- |
| Guest, registered auth, password recovery, and profiles | Implemented | [Authentication and profile](DOCS/behavior/auth-challenges.md); backend auth/profile routes and frontend session flows. |
| Public/private challenges, filters, joining, expiry, and open-match limit | Implemented | [Challenge behavior](DOCS/behavior/auth-challenges.md); challenge routes/services and expiry worker. |
| Total/set scoring, tiebreaks, forfeits, inactivity, and disconnects | Implemented | [Match lifecycle](DOCS/behavior/matches.md); match/tiebreak services, routes, worker, and WebSocket. |
| User WebSocket, matchmaking, rematches, and client match recovery | Implemented | [Realtime and client recovery](DOCS/behavior/realtime.md); backend socket/router and frontend state/event modules. |
| History, ranking, achievements, and mobile presentation | Implemented | [Stats and client presentation](DOCS/behavior/stats-client.md); stats routes/services and frontend screens. |
| Scheduled-match start semantics | Partial | [Challenge behavior](DOCS/behavior/auth-challenges.md); deadline validation exists, but joining starts the match immediately. |
| Non-target disciplines | Partial | Only `target` is fully implemented; other discipline enum values are placeholders and server scoring rejects them with HTTP 501. |
| Account deletion/reset | Planned | Requirement exists in [`app_spec.txt`](app_spec.txt); no route or UI flow is present. |
| Production database migrations | Partial | Alembic creates fresh schemas and adopts only structurally matching version-5 databases; older or mismatched schemas still need a reviewed migration. See [architecture constraints](DOCS/decisions/architecture.md). |
| Automated test coverage | Partial | `backend/tests/` covers selected auth, scoring, match-state, migration, production-config, rate-limit, and WebSocket guards; `frontend/tests/` covers account linking and reset-link handling. Behavior records identify remaining API, browser, and realtime gaps. |

## Verification boundary

Statuses above reflect current code-level implementation and the documented gaps, not a claim of comprehensive end-to-end verification. Targeted backend regression tests cover selected auth, scoring, match-state, and rematch rules; many API, browser, and realtime flows still need additional coverage. When changing a behavior, verify the affected API/UI/realtime path at the narrowest useful level and update its [behavior record](DOCS/behavior/README.md) with actual regression coverage and any remaining limits.
