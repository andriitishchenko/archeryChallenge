# ArrowMatch — CLAUDE.md

## Rules (non-negotiable)
- Internal reasoning: English only
- Code comments: English only
- UI text: English only
- All logic on backend; client calls REST API only
- Mobile-first SPA; no framework (vanilla JS)

## Dev server
```bash
# From project root (recommended — handles venv automatically):
./start.sh

# Or manually:
cd backend && source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
# UI: http://localhost:8000/   API docs: http://localhost:8000/docs
```

## Stack
| Layer | Tech |
|---|---|
| Backend | FastAPI + SQLAlchemy + SQLite (→ PostgreSQL via DATABASE_URL) |
| Auth | JWT (access + refresh). Tokens in localStorage. |
| Realtime | WebSocket via `ws/manager.py` singleton |
| Frontend | Vanilla JS modules loaded in `index.html` |

---

## File map

```
start.sh                      # project-root start script (creates venv, installs deps, runs uvicorn)
backend/
  main.py                     # app entry; serves /static → ../frontend/, /health
  core/config.py              # Settings (env vars, BOT_WAIT_SECONDS, DEBUG)
  core/deps.py                # get_db, get_current_user
  core/security.py            # JWT, bcrypt (72-byte truncation)
  models/models.py            # ORM models + enums
  models/database.py          # engine, SessionLocal, create_tables(), _migrate()
  routers/auth.py             # /api/guest  /api/auth/*
  routers/profile.py          # /api/profile/*
  routers/challenges.py       # /api/challenges/*
  routers/scores.py           # /api/matches/*  /api/history  /api/ranking  /api/achievements
  ws/manager.py               # ConnectionManager singleton
  ws/routes.py                # WS endpoints
  bots/generator.py           # bot profile + score generation (±10%)
frontend/                     # ← moved from backend/static/; served as /static/*
  index.html                  # SPA shell — 7-layer event-driven script load order
  css/styles.css
  js/
    core/
      event-bus.js            # EventBus singleton + EVENT_TYPES constants  ← NEW
      state.js                # STATE object, shared globals
      api.js                  # api(), ApiError (handles 401 refresh)
      utils.js                # showToast, escHtml, getTimeAgo, copyToClipboard
    match/
      bot.js                  # generateBotOpponent, generateMockChallenges
      ws-manager.js           # ALL WS connections → EventBus.emit()       ← NEW
      match-state.js          # startMatch, completeMatch, forfeit, rematch;
                              # subscribes to WS events via EventBus
      score-input.js          # renderMatchScene, numpad handlers, arrow cells;
                              # subscribes to APP_MATCH_STARTED, WS_OPP_ARROW
      total-mode.js           # total-score flow; subscribes to WS_OPP_SCORE_DONE
      set-mode.js             # set-system flow; subscribes to WS_OPP_SET_DONE,
                              # WS_OPP_TIEBREAK_DONE
    screens/
      auth.js                 # handleGuest, handleLogin, handleRegister, handleLogout
      settings.js             # refreshSettings, saveSettings
      challenges.js           # refreshChallengeList, joinChallenge, createChallenge,
                              # refreshMyChallenges, deleteChallenge, handleChallengeLink,
                              # findOpponent; subscribes to WS_NEW_CHALLENGE,
                              # WS_CHALLENGE_REMOVED, WS_MM_STATUS, WS_MM_MATCHED
      history.js              # saveToHistory, refreshHistory
    app-init.js               # DOMContentLoaded, restoreSession, showScene, navigation;
                              # subscribes to APP_MATCH_STARTED, APP_SESSION_READY
```

## Event-driven architecture

```
Server push (WebSocket)
        │
        ▼
  ws-manager.js          ← translates every WS message into EventBus.emit()
        │
        ▼
   EventBus              ← global publish/subscribe hub (event-bus.js)
        │
   ┌────┴──────────────────────────────────┐
   ▼                                       ▼
match-state.js                    challenges.js / score-input.js /
(mutates STATE, emits             total-mode.js / set-mode.js /
 APP_* events)                    app-init.js
        │
        ▼
   EventBus (APP_* events)
        │
        ▼
  UI components react independently
```

Server state is always the source of truth. Components subscribe to events
they care about and decide locally how to react. No module calls into another
module's functions for WS handling — all cross-module communication goes via
EventBus.

---

## Data model

```
users          id(PK) | email | hashed_password | is_guest | created_at | last_seen
profiles       user_id(FK) | name | gender | age | bow_type | skill_level | country
challenges     id | creator_id(FK) | match_type | scoring | distance | arrow_count |
               invite_message | deadline | is_private | is_active | created_at
matches        id | challenge_id(FK→NULL) | status | created_at | completed_at |
               rematch_status | rematch_proposed_by
match_participants  id | match_id(FK) | user_id(FK) | is_creator | is_bot |
                    final_score | result | submitted_at
arrow_scores   id | participant_id(FK) | arrow_index | value | set_number
```

### Enums
```
match_type:   live | async | scheduled | private
scoring:      total | sets
gender:       Male | Female
age:          Under 18 | 18–20 | 21–49 | 50+
bow_type:     Recurve | Compound | Barebow
skill_level:  Beginner | Skilled | Master
result:       win | loss | draw | pending
match.status: waiting | active | complete
rematch_status: null | proposed | accepted | declined
```

### Key constraints
- `challenge_id` → SET NULL on delete (preserves match history)
- `is_private=True` challenges excluded from public list; stay active after join
- `match_type=live|async` → `is_active=False` after first join
- `match_type=private` → stays active (creator can reshare)
- Delete challenge blocked if any linked match has ≥2 participants and status≠complete

---

## API contract

### Auth
```
POST /api/guest                              → {user_id, access_token, refresh_token}
POST /api/auth/register  {email,password}   → tokens
POST /api/auth/login     {email,password}   → tokens
POST /api/auth/refresh   {refresh_token}    → tokens
GET  /api/auth/me                           → {user_id, email, is_guest}
```

### Profile
```
GET  /api/profile               → ProfileOut
PUT  /api/profile  {name,…}     → ProfileOut
GET  /api/profile/{user_id}     → ProfileOut
```

### Challenges
```
GET    /api/challenges?skill=&gender=&bow=&dist=&country=  → [ChallengeOut]  # excludes own
POST   /api/challenges  {match_type,scoring,distance,arrow_count,…}  → ChallengeOut
GET    /api/challenges/mine      → [ChallengeOut]
GET    /api/challenges/{id}      → ChallengeOut          # no auth (private links)
DELETE /api/challenges/{id}      → 204 | 400 if active match | 403 if not owner
POST   /api/challenges/{id}/join → JoinResponse          # includes scoring,distance,arrow_count,creator_name,match_type
```

### Matches
```
GET  /api/matches/mine/active          → [ActiveMatchOut]  # both creator + joiner
GET  /api/matches/{id}                 → MatchOut
GET  /api/matches/{id}/status          → MatchStatusOut
POST /api/matches/{id}/set    {set_number,arrows:[]}  → SetResult
POST /api/matches/{id}/score  {arrows:[{arrow_index,value}]}  → {status,match_complete,tiebreak_required}
POST /api/matches/{id}/forfeit         → {status,match_id}
POST /api/matches/{id}/rematch         → RematchOut  # proposes; WS push to opponent
POST /api/matches/{id}/rematch/accept  → RematchOut  # creates new match; WS push to proposer
POST /api/matches/{id}/rematch/decline → RematchOut  # WS push to proposer
```

### Stats
```
GET /api/history            → [HistoryItem]
GET /api/ranking?bow_type=  → [RankingEntry]
GET /api/achievements       → [AchievementItem]
```

---

## WebSocket protocol

### `/ws/match/{match_id}?token=`
Handles live per-match events. `register_match()` also stores in `_user_sockets[user_id]`.

Client→Server: `ping` | `arrow {arrow_index,value}` | `set_submitted {set_number}` | `score_submitted` | `tiebreak_submitted`

Server→Client: `pong` | `opp_arrow` | `opp_set_done` | `opp_score_done` | `opp_tiebreak_done` | `opponent_disconnected` | `opponent_forfeited` | `rematch_proposed {match_id,challenge_id,proposed_by,scoring,distance,arrow_count,match_type}` | `rematch_accepted {match_id,challenge_id,opponent_name,…}` | `rematch_declined {match_id,declined_by}`

### `/ws/challenge/{challenge_id}/wait?token=`
Creator waits for opponent after creating a live challenge. Registers in `_user_sockets`.

Server→Client: `opponent_joined {match_id,opponent_name}` | `pong`

### `/ws/challenges?token=`
Public feed. All authenticated clients subscribe on login.

Server→Client: `new_challenge {challenge}` | `challenge_removed {challenge_id}` | `pong`

### `/ws/matchmaking?token=`
Client→Server: `find {filters,profile}` | `cancel` | `ping`

Server→Client: `status {message}` | `matched {match_id,opponent}` | `cancelled` | `pong`

---

## Key invariants (check before every change)

**Backend**
- Route handlers that call `asyncio.ensure_future()` or `await` must be `async def`
- `notify_user(user_id)` delivers via `_user_sockets[user_id]` — user must have an open WS (match, wait, or matchmaking socket)
- `broadcast_challenge_event()` targets `_challenge_feed` list (all subscribers of `/ws/challenges`)
- DB migrations: additive only, run in `_migrate()` at startup, guarded by PRAGMA table_info check
- JoinResponse must return: `match_id, challenge_id, scoring, distance, arrow_count, creator_name, match_type`

**Frontend**
- `STATE.activeMatches[matchId]` is the single source of truth for in-progress matches
- Page reload: `_restoreActiveMatchesFromServer()` fetches `/api/matches/mine/active`, rebuilds state, re-opens WS sockets
- `startMatch(challenge)` requires: `id, matchId (optional), name, scoring, distance, arrowCount`; opens WS only if `matchId && !isBot`
- `joinChallenge()` uses fields from `JoinResponse` directly — never falls back to `STATE.challenges` lookup in success path
- `completeMatch()` captures `wasDisplayed` BEFORE calling `_removeActiveMatch()` which reassigns `currentMatchId`
- Forfeit: `_forfeitAndExit()` → removes match → `showScene('my-challenges')` (no result overlay)
- Feed WS (`connectChallengeFeed`): auto-reconnects after 5s on unexpected close; filters via `_challengePassesFilters()`
- `proposeRematch/acceptRematch/declineRematch` → REST only, no local logic

**Scoring**
- Total mode: client polls `GET /api/matches/{id}/status` every 2s after submit; bg poll every 5s for non-submitting matches
- Set mode: server resolves set when both players submit same `set_number`; returns `SetResult`; first to 6 pts wins
- Tiebreak (both): sudden-death 1 arrow via `POST /api/matches/{id}/set` with `set_number=0`
- Bot: score generated server-side in matchmaking; `is_bot` never sent to client

---

## localStorage keys
```
arrowmatch_userid           user ID
arrowmatch_access_token     JWT access token
arrowmatch_refresh_token    JWT refresh token
arrowmatch_user             {email, is_guest}
arrowmatch_profile          profile object
arrowmatch_active_matches   {matchId: matchState} — arrow values for reload merge
arrowmatch_my_challenges    creator's challenge list cache
arrowmatch_history          match history cache
```

## Environment variables (backend/.env)
```
SECRET_KEY          JWT signing key (required in production)
DATABASE_URL        sqlite:///./arrowmatch.db  |  postgresql://...
CORS_ORIGINS        comma-separated origins
BOT_WAIT_SECONDS    8 (seconds before bot spawns in matchmaking)
DEBUG               true → enables /docs and /redoc
AUTH_RATE_LIMIT     5
AUTH_RATE_WINDOW    60
```
