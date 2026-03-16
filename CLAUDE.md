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
| Layer    | Tech |
|---|---|
| Backend  | FastAPI + SQLAlchemy + SQLite (→ PostgreSQL via DATABASE_URL) |
| Auth     | JWT (access + refresh). Tokens in localStorage. |
| Realtime | WebSocket via `ws/manager.py` singleton |
| Frontend | Vanilla JS modules loaded in `index.html` |

---

## File map

```
start.sh                        # project-root start script
backend/
  main.py                       # app entry; serves /static → ../frontend/, /health
  core/
    config.py                   # Settings (env vars, BOT_WAIT_SECONDS, DEBUG)
    deps.py                     # get_db, get_current_user, check_rate_limit
    security.py                 # JWT, bcrypt (72-byte truncation)
  models/
    models.py                   # ORM models + enums
    database.py                 # engine, SessionLocal, create_tables(), schema-version guard
  schemas/                      # All Pydantic request/response models
    __init__.py                 # re-exports everything; import from here
    auth.py                     # GuestResponse, TokenResponse, MeResponse, …
    challenges.py               # ChallengeCreate, ChallengeOut, JoinResponse
    matches.py                  # SetResult, ScoreSubmission, MatchStatusOut, ActiveMatchOut, …
    stats.py                    # HistoryItem, RankingEntry, AchievementItem
    profile.py                  # ProfileRequest, ProfileResponse
  services/                     # Business logic shared across routers
    match.py                    # load_match, get_participant, get_opponent, count_set_points,
                                # build_judge_status, match_to_out, get_profile_name
    tiebreak.py                 # get/create tiebreak match, notify_tiebreak_started,
                                # resolve_parent_from_tiebreak
    challenges.py               # challenge_to_out (serialiser shared by routers)
  routers/
    auth.py                     # /api/guest  /api/auth/*
    profile.py                  # /api/profile/*
    challenges.py               # /api/challenges/*
    matches.py                  # /api/matches/* scoring + lifecycle + my-challenges
    stats.py                    # /api/history  /api/ranking  /api/achievements
    rematch.py                  # /api/matches/{id}/rematch  /accept  /decline
    expiry.py                   # background expiry task (challenge deadlines + match inactivity)
  bots/
    generator.py                # bot profile + score generation (±10%)
  ws/
    manager.py                  # ConnectionManager singleton + matchmaking queue
    routes.py                   # /ws/user — single persistent socket per user
frontend/                       # served as /static/*
  index.html                    # SPA shell — 6-layer event-driven script load order
  css/styles.css
  js/
    core/
      event-bus.js              # EventBus singleton + EVENT_TYPES constants (incl. APP_FORFEIT_*, APP_REMATCH_*)
      state.js                  # STATE object, WS_BASE, API_BASE, shared globals
      api.js                    # api() fetch helper, token management
      utils.js                  # showToast, escHtml, getTimeAgo, copyToClipboard
      ws.js                     # single /ws/user socket; routes server→client events to EventBus
    match/
      bot.js                    # generateBotOpponent, genBotArrows, genBotTotal (public API)
      match-state.js            # startMatch, completeMatch, _fetchAndResolveMatch (unified status fetch);
                                # pure state — zero DOM access; all UI via EventBus
      score-input.js            # renderMatchScene, numpad, forfeit two-step confirm,
                                # rematch overlay DOM — ONLY match module that touches DOM
      total-mode.js             # total-score submission + bot tiebreak
      set-mode.js               # set-system flow
    screens/
      auth.js                   # handleGuest, handleLogin, handleRegister, handleLogout
      settings.js               # refreshSettings, saveSettings
      challenges.js             # refreshChallengeList, joinChallenge, createChallenge,
                                # refreshMyChallenges, findOpponent, matchmaking;
                                # scene changes driven by APP_SCENE_CHANGE (no STATE.currentScene checks)
      history.js                # saveToHistory, refreshHistory
    app-init.js                 # DOMContentLoaded, restoreSession, showScene, navigation
```

## Architecture

```
Server push (WebSocket)
        │
        ▼
  core/ws.js             ← routes every server→client event to EventBus
        │
        ▼
   EventBus              ← global publish/subscribe hub (event-bus.js)
        │
   ┌────┴──────────────────────────────────┐
   ▼                                       ▼
match-state.js                    challenges.js / score-input.js /
(mutates STATE, emits             total-mode.js / set-mode.js /
 APP_* events)                    app-init.js
```

Server state is always the source of truth. Components subscribe to events they
care about and react locally. No module calls into another module's functions for
WS handling — all cross-module communication goes via EventBus.

---

## Data model

```
users          id(PK) | email | hashed_password | is_guest | created_at | last_seen
profiles       user_id(FK) | name | gender | age | bow_type | skill_level | country
challenges     id | creator_id(FK) | challenge_kind | match_type | discipline |
               scoring | distance | arrow_count | invite_message | deadline |
               is_private | is_active | created_at | parent_id(FK)
matches        id | challenge_id(FK→NULL) | parent_match_id(FK→NULL) | status |
               created_at | completed_at | first_to_act |
               rematch_status | rematch_proposed_by
match_participants  id | match_id(FK) | user_id(FK) | is_creator | is_bot |
                    final_score | result | submitted_at
arrow_scores   id | participant_id(FK) | arrow_index | value | set_number
```

### Enums
```
match_type:      live | scheduled
scoring:         total | sets
discipline:      target | indoor | field | 3d | clout | flight  (only target implemented)
challenge_kind:  normal | tiebreak | rematch
gender:          Male | Female
age:             Under 18 | 18–20 | 21–49 | 50+
bow_type:        Recurve | Compound | Barebow
skill_level:     Beginner | Skilled | Master
result:          win | loss | draw | pending
match.status:    waiting | active | complete
```

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
GET    /api/challenges?skill=&gender=&bow=&dist=&country=  → [ChallengeOut]
POST   /api/challenges  {…}              → ChallengeOut
GET    /api/challenges/mine              → [ChallengeOut]
GET    /api/challenges/{id}              → ChallengeOut
DELETE /api/challenges/{id}             → 204
POST   /api/challenges/{id}/join        → JoinResponse
```

### Matches
```
GET  /api/matches/mine/active           → [ActiveMatchOut]
GET  /api/matches/{id}                  → MatchOut
GET  /api/matches/{id}/status           → MatchStatusOut
POST /api/matches/{id}/set    {…}       → SetResult
POST /api/matches/{id}/score  {arrows}  → {status, match_complete, tiebreak_required}
POST /api/matches/{id}/forfeit          → {status, match_id}
POST /api/matches/{id}/rematch          → RematchOut
POST /api/matches/{id}/rematch/accept   → RematchOut
POST /api/matches/{id}/rematch/decline  → RematchOut
```

### Stats
```
GET /api/history              → [HistoryItem]
GET /api/ranking?bow_type=    → [RankingEntry]
GET /api/achievements         → [AchievementItem]
GET /api/my-challenges        → [ChallengeOut+match fields]
```

---

## WebSocket protocol

### `/ws/user?token=`  (single persistent socket per session)

Client→Server: `ping` | `arrow {match_id,arrow_index,value}` | `mm_find {filters,profile}` | `mm_cancel`

Server→Client: `pong` | `opp_arrow` | `opp_set_done` | `opp_score_done` | `set_resolved` |
`opponent_score_submitted` | `opponent_forfeited` | `opponent_disconnected` | `opponent_joined` |
`match_complete` | `tiebreak_started` | `match_ready` |
`rematch_proposed` | `rematch_accepted` | `rematch_declined` |
`new_challenge` | `challenge_removed` | `challenge_expired` |
`mm_status` | `mm_matched` | `mm_cancelled`

---

## Key invariants

**Backend**
- `services/match.py` — shared DB helpers; all routers use `load_match`, `get_participant`, etc.
- `services/tiebreak.py` — all tiebreak creation/resolution goes through here
- `services/challenges.py` — `challenge_to_out()` is the single serialiser for challenges
- `rematch/accept` and `rematch/decline` accept either the new rematch match ID *or* the
  original completed match ID — `_resolve_rematch_match()` handles both transparently
- DB migrations: schema-version-based recreation (see `models/database.py`)

**Frontend**
- `STATE.activeMatches[matchId]` is the single source of truth for in-progress matches
- `startMatch(challenge)` requires: `id, matchId (optional), name, scoring, distance, arrowCount`
- `completeMatch()` captures `wasDisplayed` BEFORE calling `_removeActiveMatch()`
- Total mode: client polls after WS event (no background timers)
- Forfeit: `_forfeitAndExit()` → removes match → `showScene('my-challenges')`

---

## Environment variables (backend/.env)
```
SECRET_KEY                   JWT signing key (required in production)
DATABASE_URL                 sqlite:///./arrowmatch.db  |  postgresql://...
CORS_ORIGINS                 comma-separated origins
BOT_WAIT_SECONDS             8
MATCHMAKING_TIMEOUT          30
EXPIRY_CHECK_INTERVAL_SECONDS  60
MATCH_INACTIVITY_SECONDS     172800  (48 h)
DEBUG                        true → enables /docs and /redoc
AUTH_RATE_LIMIT              5
AUTH_RATE_WINDOW             900
```

## localStorage keys
```
arrowmatch_userid           user ID
arrowmatch_access_token     JWT access token
arrowmatch_refresh_token    JWT refresh token
arrowmatch_user             {email, is_guest}
arrowmatch_profile          profile object
arrowmatch_active_matches   {matchId: matchState}
arrowmatch_my_challenges    challenge list cache
arrowmatch_history          match history cache
```
