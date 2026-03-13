# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ArrowMatch is an online archery challenge platform ("Chatroulette-style") where users connect in real time, compete, and record results. It supports guest users (persistent userID stored locally) and registered users (email/password authentication).

## Language Requirements

- **All internal reasoning must be in English**
- **All code comments must be in English**
- **All UI text and interfaces must be in English only**

## Platform Requirements

- Mobile browser first
- UX optimized for mobile
- Comfortable color palette
- System must prevent data loss on page reload (localStorage, session restore, autosave)

## Workflow of implementation

- make a plan of implementation
- implement features or Resolve issues
- do regression testing
- update instructions.md

## Commands

### Development
```bash
cd backend

# Create virtual environment (first time)
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run development server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### Testing
No automated tests are present. Manual testing via the frontend UI at `http://localhost:8000/`.

### Database
- SQLite by default (arrowmatch.db in backend directory)
- No migrations — tables are created automatically on startup via `create_tables()`
- For production: set `DATABASE_URL=postgresql://...`

## User Types

1. **Guest**: Uses platform without registration. Receives persistent userID from server, stored locally for session restoration.
2. **Registered User**: Email + password authentication. Same userID is kept if upgrading from guest.
3. **Persistent Guest**: Guest whose userID is restored automatically without login.

## Entry Flow

- **First Visit**: Shows login form OR "Continue as Guest" button. Guest must complete profile in Settings scene.
- **Returning User**: Automatic session restore → redirect to Main Window.
- **Challenge Link**: If URL has `?c=<challenge_id>`, show challenge message and open Challenge scene.

## Scenes

1. **Settings**: Profile configuration. All fields required.
   - Name/Nickname (text, required)
   - Gender (Male/Female)
   - Age (Under 18, 18–20, 21–49, 50+)
   - Bow Type (Recurve, Compound, Barebow)
   - Skill Level (Beginner, Skilled, Master)
   - Country (dropdown, required)

2. **List Challenge**: Public challenges waiting for opponents. Shows creator's profile info. Own challenges excluded. Join button.

3. **New Challenge**: Create challenge with distance (18m–90m), scoring type, arrow count, invite message, deadline, private mode.

4. **My Challenges**: User's own challenges. Can delete or copy private link.

5. **Challenge (Score Input)**: Enter shooting results. Values entered 3 per row, auto-focus to next field.
   - Buttons: 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, DEL

6. **Challenge History**: Previous matches with results.

## Match Types

1. **Live**: Real-time competition via WebSocket
2. **Asynchronous**: Players submit results independently with deadline
3. **Scheduled**: Deadline set for result submission (23:59:59 of selected date)
4. **Private**: Link-only access ("I challenge you" mode). Can be reshared by creator. Not listed in "Open Challenges".

## Scoring Modes

### Total Score
- Specify number of arrows (3–360)
- Submit all arrows at once
- Server resolves when both players submit
- Tie → sudden-death tiebreak (1 arrow, closest to center wins)

### Set System
- 3 arrows per set
- 2 points for set win, 1 point each for tie
- First to 6 points wins
- Submit set by set via `POST /api/matches/{id}/set`
- 6–6 tie → sudden-death tiebreak (set_number=0, 1 arrow)

## Matchmaking

- **Find Opponent**: Random matching with optional filters
- Filters (all selected by default = no restrictions):
  - Skill Level (Beginner, Skilled, Master) — multiple selection
  - Gender (Male, Female)
  - Bow Type (Recurve, Compound, Barebow)
  - Age (Under 18, 18–20, 21–49, 50+)
  - Distance (18m–90m)
  - Country (dropdown, empty = any)
- **Bot Opponents**: If no real users available, bot spawned after `BOT_WAIT_SECONDS` (default 8s). Bot score ≈ user average ±10%. Bot flag never sent to client — users should believe they're playing a real opponent.

## Rating & Achievements

### Rating System
- Based on last 10 matches
- Metrics: average score, wins/losses, global ranking by bow type
- Global ranking based on number of matches won

### Achievement Badges (displayed on homepage)
- Win Streak: 5, 10, 25 wins in a row
- Participation: 10, 50, 100 matches played

## Architecture

### Backend (FastAPI)

```
backend/
├── main.py              # FastAPI app entry, serves frontend, health check
├── core/
│   ├── config.py        # Settings class (env vars, defaults)
│   ├── deps.py          # FastAPI dependencies (auth, rate limiting)
│   └── security.py      # Password hashing (bcrypt), JWT tokens
├── models/
│   ├── database.py      # SQLAlchemy engine, session factory
│   └── models.py        # ORM models (User, Profile, Challenge, Match, etc.)
├── routers/
│   ├── auth.py          # /api/guest, /api/auth/* (login, register, refresh)
│   ├── profile.py       # /api/profile/*
│   ├── challenges.py    # /api/challenges/* (create, join, list, delete)
│   └── scores.py        # /api/matches/*, /api/history, /api/ranking, /api/achievements
├── ws/
│   ├── manager.py       # WebSocket connection manager (matchmaking, live match)
│   └── routes.py        # WebSocket endpoints (/ws/match/{id}, /ws/matchmaking)
├── bots/
│   └── generator.py     # Bot profile/score generation (±10% of user average)
└── static/
    ├── index.html       # Frontend SPA
    ├── app.js           # Frontend logic (state management, API calls, WebSocket)
    └── styles.css       # Styling
```

### Frontend

Single-page application (vanilla JS, CSS). No framework. Served by FastAPI at `/`.

**State management**: Global `STATE` object stored in localStorage for offline resilience and session restoration.

### Data Model

```
User ─┬─< Profile (1:1)
      └─< MatchParticipant >── Match ─── Challenge

Match ──< MatchParticipant ──< ArrowScore
```

**Key entities**:
- `User`: id (server-generated hash like `AM-xxx-xxx`), email, is_guest
- `Profile`: name, gender, age, bow_type, skill_level, country
- `Challenge`: match_type (live/async/scheduled/private), scoring (total/sets), distance, arrow_count
- `Match`: status (waiting/active/complete), participants
- `MatchParticipant`: user_id, is_creator, is_bot, final_score, result
- `ArrowScore`: individual arrow values with set_number for set-system scoring

### Authentication Flow

1. **Guest**: `POST /api/guest` → returns `user_id` + tokens
2. **Register**: `POST /api/auth/register` (can upgrade guest by passing `existing_user_id`)
3. **Login**: `POST /api/auth/login`
4. **Refresh**: `POST /api/auth/refresh`

Tokens stored in localStorage: `arrowmatch_access_token`, `arrowmatch_refresh_token`.

### WebSocket Protocol

**Matchmaking** (`/ws/matchmaking`):
- Client → `{"type": "find", "filters": {...}, "profile": {...}}`
- Server → `{"type": "matched", "match_id": "...", "opponent": {...}}`
- If no real users available → bot spawned after `BOT_WAIT_SECONDS` (default 8s)

**Live Match** (`/ws/match/{match_id}`):
- Client → `{"type": "arrow", "arrow_index": N, "value": V}` (real-time preview)
- Server broadcasts `{"type": "opp_arrow", ...}` to opponent
- Set submission, score submission, tiebreak notifications

### Environment Variables

See `backend/.env.example`:
- `SECRET_KEY` — JWT signing (change in production!)
- `DATABASE_URL` — SQLite default or PostgreSQL
- `CORS_ORIGINS` — comma-separated frontend origins
- `AUTH_RATE_LIMIT`, `AUTH_RATE_WINDOW` — rate limiting
- `BOT_WAIT_SECONDS` — delay before spawning bot opponent
- `DEBUG=true` — enables `/docs` and `/redoc`

## Important Patterns

### Password Handling
Backend uses `bcrypt` directly (not passlib) with explicit 72-byte truncation. See `core/security.py`.

### WebSocket Accept Order
**Critical**: WebSocket must be `accept()`ed before any send/close. Routes in `ws/routes.py` call `await websocket.accept()` before delegating to the manager.

### Challenge Deletion
When deleting a Challenge, linked Matches must have their `challenge_id` set to NULL (not cascade delete) to preserve match history. See `routers/challenges.py:delete_challenge`.

### Private Challenges
Private challenges (`is_private=True`) are not listed in public `/api/challenges`. Accessible only via direct link with challenge ID. Stay active after join so creator can reshare.

### Bot Score Generation
Bot scores are calibrated to ±10% of user's reference score. Users never see bot flag — `is_bot` stripped in `_safe_profile()`. See `bots/generator.py`.

### Frontend Match Restoration
On page reload, `STATE.matchState` is restored from localStorage. If a match was in progress, the Challenge scene restores it automatically.

## Security Checklist

Code must be checked for:
- Authentication vulnerabilities
- Injection attacks (SQL injection, XSS)
- Session hijacking
- WebSocket abuse

## Resolved Issues (Task History)

1. **Arrowmatch.html → index.html**: Served at root `/`.
2. **Password bcrypt truncation**: Passwords truncated to 72 bytes before hashing (see `core/security.py`).
3. **WebSocket accept order**: `ws.accept()` called before any send/close in `ws/routes.py`.
4. **Achievements from server**: `GET /api/achievements` returns badge status calculated server-side.
5. **Own challenges hidden**: List Challenge screen excludes current user's own challenges.
6. **Challenge deletion cascade**: Matches have `challenge_id` set to NULL to preserve history.
7. **Private challenges**: Not shown in "Open Challenges"; accessible via link only; copy link button in "My Challenges".
8. **Bot delay**: Bots connect after `BOT_WAIT_SECONDS` (configurable, default 8s).
9. **Set System scoring**: Server waits for both players to submit each set, then resolves winner.
10. **Total Score tiebreak**: Equal scores trigger sudden-death (1 arrow) via `set_number=0`.
11. **CSS/JS split**: Properly separated into `styles.css` and `app.js`.