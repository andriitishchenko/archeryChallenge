# ArrowMatch — System Specification & Implementation Reference

> **Usage:** This file is the primary system specification, development checklist, implementation validation reference, and retrospective review checklist.
> All new requirements are appended here automatically. Latest requirement overrides earlier specification on conflict.
> Claude must continuously update this file during development for regression testing.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [File Structure](#3-file-structure)
4. [Frontend — HTML / CSS](#4-frontend--html--css)
5. [Frontend — JavaScript (app.js)](#5-frontend--javascript-appjs)
6. [Backend — Data Models](#6-backend--data-models)
7. [Backend — API Routes](#7-backend--api-routes)
8. [Backend — WebSocket Protocols](#8-backend--websocket-protocols)
9. [Match Scoring Logic](#9-match-scoring-logic)
10. [Authentication & Session Management](#10-authentication--session-management)
11. [Private Challenges](#11-private-challenges)
12. [Bot Fallback System](#12-bot-fallback-system)
13. [Filters & Matchmaking](#13-filters--matchmaking)
14. [History, Stats & Achievements](#14-history-stats--achievements)
15. [Deployment & Configuration](#15-deployment--configuration)
16. [Regression Review Checklist](#16-regression-review-checklist)
17. [Known Issues & Fixes Log](#17-known-issues--fixes-log)

---

## 1. Project Overview

**ArrowMatch** is a "Chatroulette-style" mobile-first archery challenge platform.

- Archers worldwide can find opponents, create challenges, and record scored rounds.
- Supports Live (real-time WebSocket), Async, Scheduled, and Private (link-only) match types.
- Supports two scoring systems: **Total Score** (sum of all arrows) and **Set System** (WA-style: 2pts/1pt/0pt per set, first to 6 wins).
- Mobile-first single-page application. Backend is FastAPI + SQLAlchemy + SQLite (upgradeable to PostgreSQL).

**Non-negotiable rules:**
- All internal reasoning: English only.
- All code comments: English only.
- All UI text and interfaces: English only.
- Swift 6+ / macOS 16+ user preferences apply only to native app extensions (not this web platform).

---

## 2. Architecture

```
Browser (SPA)
  └── index.html          ← shell; references /static/css/styles.css and /static/js/app.js
  └── css/styles.css      ← full design system
  └── js/app.js           ← all application logic

FastAPI Backend
  ├── GET /               → serves static/index.html
  ├── /static/*           → StaticFiles(directory=static/)
  │     ├── index.html
  │     ├── css/styles.css
  │     └── js/app.js
  ├── /api/*              → REST endpoints (JSON)
  ├── /ws/*               → WebSocket endpoints
  └── /health             → health check
```

**Key architectural decisions:**
- Same-origin serving: backend serves the frontend SPA. No separate dev server in production.
- All API calls from frontend are same-origin (no CORS issues in production).
- `API_BASE = ''` (empty string) in `core/state.js` — all fetch calls use relative paths.
- `WS_BASE` auto-derived from `location.host` — works for localhost, staging, production without config.
- CSS and JS are **external files** referenced by `index.html` — NOT inline — for cacheability and maintainability.

---

## 3. File Structure

```
archery/                        ← frontend source (development)
  index.html                   ← shell HTML template (loads CSS + 14 JS modules)
  css/
    styles.css                 ← canonical CSS source (723 lines)
  js/
    core/
      state.js                 ← STATE, matchSockets, API_BASE, WS_BASE, globals
      api.js                   ← api(), _tryRefresh, _storeTokens, _clearSession
      utils.js                 ← showToast, copyToClipboard, escHtml, dates, loadCountries
    match/
      bot.js                   ← _genBot*, generateBotOpponent, generateMockChallenges
      score-input.js           ← renderMatchScene, numpad handlers, refreshArrowCells
      set-mode.js              ← resolveSet, _applySetResult, _startTiebreak, resolveTiebreak
      total-mode.js            ← checkTotalComplete, _pollForResult, _startTotalTiebreak
      match-state.js           ← startMatch, completeMatch, forfeitMatch, saveMatchState,
                                  _removeActiveMatch, _updateResumeTab, switchToMatch, startRematch
      websocket.js             ← _connectMatchSocket, _scheduleBotFallback,
                                  findOpponent, _connectMatchmaking, _fallbackFindOpponent,
                                  _onOpponentArrow, _showOppSetArrows
    screens/
      auth.js                  ← handleGuest, handleLogin, handleRegister, handleLogout, toggleRegister
      settings.js              ← refreshSettings, saveSettings, updateSettingsAccountSection
      challenges.js            ← refreshChallengeList, renderChallengeList, joinChallenge,
                                  createChallenge, refreshMyChallenges, deleteChallenge,
                                  handleChallengeLink, toggleFilter, updateFilterBadge
      history.js               ← saveToHistory, refreshHistory, renderStats,
                                  renderAchievements, renderHistoryList
    app-init.js                ← init, restoreSession, showUI, showScene, goBack, updateNavTitle

arrowmatch-backend/             ← backend (production server)
  main.py                      ← FastAPI app entry point
  requirements.txt
  Dockerfile
  .env.example
  instructions.md              ← THIS FILE
  core/
    config.py                  ← settings from .env
    security.py                ← JWT + bcrypt
    deps.py                    ← get_db, get_current_user, check_rate_limit
  models/
    models.py                  ← SQLAlchemy ORM models + enums
    database.py                ← engine, SessionLocal, create_tables()
  routers/
    auth.py                    ← /api/guest, /api/auth/*
    profile.py                 ← /api/profile, /api/profile/{user_id}
    challenges.py              ← /api/challenges/*
    scores.py                  ← /api/matches/*, /api/history, /api/ranking, /api/achievements
  ws/
    manager.py                 ← ConnectionManager singleton
    routes.py                  ← WebSocket route handlers
  bots/
    generator.py               ← generate_bot_profile()
  static/
    index.html                 ← BUILT from archery/index.html (paths rewritten to /static/*)
    css/
      styles.css               ← COPIED from archery/css/styles.css
    js/                        ← mirrors archery/js/ exactly
      core/  match/  screens/  app-init.js
```

**Module load order in index.html** (dependency order, all `defer`-free globals):
1. `core/state.js` → `core/api.js` → `core/utils.js`
2. `match/bot.js` → `match/score-input.js` → `match/set-mode.js` → `match/total-mode.js`
3. `match/match-state.js` → `match/websocket.js`
4. `screens/auth.js` → `screens/settings.js` → `screens/challenges.js` → `screens/history.js`
5. `app-init.js`

**Build rule:** After editing source files in `archery/`, run:
```bash
# Rewrite CSS and JS paths, mirror the full module tree
sed 's|href="css/styles.css"|href="/static/css/styles.css"|g;
     s|src="js/core/|src="/static/js/core/|g;
     s|src="js/match/|src="/static/js/match/|g;
     s|src="js/screens/|src="/static/js/screens/|g;
     s|src="js/app-init.js"|src="/static/js/app-init.js"|g' \
    archery/index.html > arrowmatch-backend/static/index.html

cp archery/css/styles.css          arrowmatch-backend/static/css/styles.css
cp archery/js/core/*.js            arrowmatch-backend/static/js/core/
cp archery/js/match/*.js           arrowmatch-backend/static/js/match/
cp archery/js/screens/*.js         arrowmatch-backend/static/js/screens/
cp archery/js/app-init.js          arrowmatch-backend/static/js/app-init.js
```

**Per-file editing guide** (which file to open for a given change):
| Change area | File |
|---|---|
| Auth / login / session | `screens/auth.js` (~115 lines) |
| Profile form | `screens/settings.js` (~88 lines) |
| Challenge list, filters, invite links | `screens/challenges.js` (~312 lines) |
| History, stats, achievements | `screens/history.js` (~103 lines) |
| Arrow cells, numpad, match scene layout | `match/score-input.js` (~268 lines) |
| Set resolution, tiebreak | `match/set-mode.js` (~187 lines) |
| Total score, polling | `match/total-mode.js` (~76 lines) |
| Match lifecycle (start/complete/forfeit) | `match/match-state.js` (~221 lines) |
| WebSocket, bot countdown, matchmaking | `match/websocket.js` (~326 lines) |
| Bot generation, mock data | `match/bot.js` (~68 lines) |
| Global state, config | `core/state.js` (~70 lines) |
| API layer, token management | `core/api.js` (~92 lines) |
| Toast, clipboard, helpers | `core/utils.js` (~103 lines) |
| Boot, session restore, navigation | `app-init.js` (~135 lines) |

---

## 4. Frontend — HTML / CSS

### 4.1 Design System

| Variable | Value | Purpose |
|---|---|---|
| `--bg` | `#0d1117` | Page background (dark forest) |
| `--bg-card` | `#161c26` | Card background |
| `--bg-raised` | `#1e2635` | Raised elements |
| `--accent` | `#e8a328` | Primary amber/gold accent |
| `--accent-dim` | `#b07e1e` | Darker accent (borders, hover) |
| `--accent-glow` | `rgba(232,163,40,0.18)` | Accent glow for active states |
| `--red` | `#f26060` | Error/danger color |
| `--green` | `#4caf8a` | Success/win color |
| `--border` | `rgba(255,255,255,0.08)` | Subtle border |
| `--text` | `#e8e8e8` | Primary text |
| `--text-muted` | `#7a8599` | Muted/secondary text |

**Fonts:** Archivo Black (display/headings) + Archivo (body, 300/400/500/600) + DM Mono (scores/IDs)

### 4.2 Scene System

The app has 7 scenes. Only one is `.active` at a time. Navigation is handled by `showScene(name)`.

| Scene ID | Tab | Description |
|---|---|---|
| `scene-entry` | (hidden when logged in) | Login / Register / Guest |
| `scene-settings` | ⚙ (top-right) | Profile form + account management |
| `scene-list-challenge` | ◎ Challenges | Public challenge board + Quick Match |
| `scene-new-challenge` | + New | Create challenge form |
| `scene-my-challenges` | ◈ Mine | Manage/delete own challenges; Copy Link for private |
| `scene-challenge` | 🏹 Match (resume) | Active match — arrow input numpad |
| `scene-history` | ◷ History | Win/loss log + stats + achievements |

**Bottom navigation (5 tabs):**
- Challenges (`list-challenge`) — always visible when logged in
- New (`new-challenge`) — always visible
- Match (`challenge`) — **hidden by default**, shown only when an active match exists; pulses amber
- Mine (`my-challenges`) — always visible
- History (`history`) — always visible

**Resume tab behavior:**
- Shown when `STATE.matchState && !STATE.matchState.complete`
- Hidden after match completes (`completeMatch()` hides it)
- `showScene()` evaluates this on every call

### 4.3 Key CSS Classes

| Class | Purpose |
|---|---|
| `.scene` | Full-screen section; `.scene.active` is visible |
| `.scene-scroll` | Scrollable content within a scene; `padding-top` accounts for top nav |
| `.card` | White-bordered dark card, `border-radius: 16px` |
| `.btn-primary` | Amber filled button |
| `.btn-secondary` | Outline button |
| `.btn-ghost` | Transparent with subtle border |
| `.btn-sm` | Small action button (Delete, Copy Link). **Must have `cursor:pointer`** |
| `.btn-danger` | Red-tinted small button (Delete) |
| `.btn-copy` | Amber-filled small button (Copy Link for private challenges). **Visually prominent.** |
| `.chip` | Selectable pill; `.chip.active` = amber/selected |
| `.arrow-cell` | Single arrow score cell; colored by value |
| `.arrow-cell.filled-10` | Gold — perfect score |
| `.arrow-cell.filled-9` | Amber |
| `.arrow-cell.filled-8` | Muted amber |
| `.arrow-cell.filled` | Default non-zero fill |
| `.arrow-cell.active` | Currently selected cell (pulsing border) |
| `.num-btn` | Numpad key |
| `.del-btn` | DEL key (right-aligned, danger-tinted) |

### 4.4 Requirements Per Element

**Entry scene:**
- Guest flow: `POST /api/guest` → store tokens → go to Settings
- Login: validate email format and non-empty password → `POST /api/auth/login`
- Register: validate email, password ≥ 8 chars → `POST /api/auth/register` with `existing_user_id` (guest upgrade)
- Animated concentric target rings in background (CSS only, no JS)

**Settings scene:**
- Required fields: Name (1–32 chars), Gender (radio), Age (select), Bow Type (chip), Skill Level (chip), Country (select)
- Country select populated by `loadCountries()` on `DOMContentLoaded`
- `saveSettings()` → `PUT /api/profile` → navigate to `list-challenge`
- Account section shows guest upgrade form OR email + Sign Out based on `STATE.user.isGuest`
- User ID displayed in monospace font at bottom

**Challenge list scene:**
- Loads on `showScene('list-challenge')`
- `GET /api/challenges?skill=&gender=&bow=&dist=&country=` with multi-value filter params
- Shows spinner while loading, empty-state if no results
- Challenge cards show: name, time-ago, distance tag, bow, skill, gender, age, optional invite message
- Clicking card or Join button → `joinChallenge(id)`
- Quick Match card with pulsing animation → `findOpponent()`
- Collapsible filter panel (`<details>`) with multi-select chips + country dropdown
- Filter badge shows "All" when all defaults selected, "Active" when filtered

**New Challenge scene:**
- Match Type: Live / Async / Scheduled / Private (4-button grid)
- Distance chips: 18m / 25m / 30m / 50m / 70m / 90m (default 30m)
- Scoring toggle: Total Score / Set System
- Total Score: arrow count stepper (3–36, step 3, default 18)
- Set System: info box showing rules (no arrow count)
- Deadline card: shown for Async and Scheduled types; hidden for Live and Private
- Invite message textarea: 200 char limit, live counter
- On Create: → `POST /api/challenges` → if Private: copy link + show My Challenges; if Live: start match; else show My Challenges

**My Challenges scene:**
- `GET /api/challenges/mine` on load
- Each card shows: distance · scoring, bow/skill tags, type badge
- **Copy Link button (amber, `.btn-copy`):** shown for every private challenge (`is_private === true`). Copies `?c={id}` URL to clipboard. Shows toast.
- Delete button (red, `.btn-danger`): optimistic removal then `DELETE /api/challenges/{id}`

**Challenge (Match) scene:**
- Match header: player names + VS + distance
- Total score UI: arrow grid (rows of 3), running row sums, total display
- Set system UI: score 0:0 display, set progress label, 3-cell arrow row
- Numpad: 0–10 + DEL, auto-advances active cell
- Opponent live indicator: shows real-time arrow broadcasts from WS
- Match status bar: shows "waiting for opponent…" messages
- Match complete overlay: result icon + title + score line + Rematch + New Challenge buttons
- Resume tab visible and pulsing while match is active

**History scene:**
- Stats row: Avg Score / Wins / Global Rank (last 10 matches)
- Achievements grid: 6 badges (5/10/25 win streak, 10/50/100 matches)
- Match history list: up to 30 entries; result icon (✓/✗/=) colored green/red/muted; opponent name, distance, scoring, date

---

## 5. Frontend — JavaScript Modules

The JS codebase is split across 14 focused files (all global-scope, no ES modules, so HTML `onclick=` attributes work unchanged). Each file has a comment header listing its dependencies.

### 5.0 Module Map

| Module | File | Key exports |
|---|---|---|
| State & Config | `core/state.js` | `STATE`, `matchSockets`, `API_BASE`, `WS_BASE`, `arrowValues`, `activeArrowIndex`, `mmSocket` |
| API Layer | `core/api.js` | `api()`, `ApiError`, `_storeTokens`, `_clearSession` |
| Utilities | `core/utils.js` | `showToast`, `copyToClipboard`, `escHtml`, `getTimeAgo`, `formatDate`, `loadCountries`, `validateEmail`, `_generateLocalId`, `_serverProfileToLocal` |
| Bot | `match/bot.js` | `_genBotArrow`, `_genBotTotal`, `generateBotOpponent`, `generateMockChallenges` |
| Score Input | `match/score-input.js` | `renderMatchScene`, `buildArrowRows`, `numInput`, `numDel`, `refreshArrowCells`, `refreshSetScore`, `_setStatus`, `_setNumpadDisabled`, `_submitScoreToServer` |
| Set Mode | `match/set-mode.js` | `resolveSet`, `_applySetResult`, `_nextSet`, `_startTiebreak`, `resolveTiebreak` |
| Total Mode | `match/total-mode.js` | `checkTotalComplete`, `_pollForResult`, `_startTotalTiebreak`, `_pollInterval` |
| Match State | `match/match-state.js` | `startMatch`, `completeMatch`, `forfeitMatch`, `saveMatchState`, `restoreMatch`, `startRematch`, `_removeActiveMatch`, `_updateResumeTab`, `switchToMatch`, `_botFallbackTimers` |
| WebSocket | `match/websocket.js` | `_connectMatchSocket`, `_scheduleBotFallback`, `findOpponent`, `_connectMatchmaking`, `_onOpponentArrow`, `_showOppSetArrows` |
| Auth | `screens/auth.js` | `handleGuest`, `handleLogin`, `handleRegister`, `handleCreateAccount`, `handleLogout`, `toggleRegister` |
| Settings | `screens/settings.js` | `refreshSettings`, `saveSettings`, `updateSettingsAccountSection`, `selectChip` |
| Challenges | `screens/challenges.js` | `refreshChallengeList`, `joinChallenge`, `createChallenge`, `refreshMyChallenges`, `deleteChallenge`, `handleChallengeLink`, `toggleFilter`, `findOpponent` |
| History | `screens/history.js` | `saveToHistory`, `refreshHistory`, `renderStats`, `renderAchievements`, `renderHistoryList` |
| App Init | `app-init.js` | `init`, `restoreSession`, `showUI`, `showScene`, `goBack`, `updateNavTitle` |

### 5.1 State Object

```javascript
STATE = {
  userId,          // server-issued AM-xxx-xxx
  accessToken,     // JWT bearer token
  refreshToken,    // JWT refresh token
  user,            // { email, isGuest }
  profile,         // { name, gender, age, bowType, skillLevel, country }
  currentScene,    // active scene name
  activeChallengeId,
  currentMatchType,  // 'live' | 'async' | 'scheduled' | 'private'
  currentScoring,    // 'total' | 'sets'
  arrowCount,        // 3–36
  matchState,        // full match state (persisted to localStorage)
  challenges,        // current public challenge list
  myChallenges,      // my challenges from server
  history,           // match history entries
  filters,           // { skill[], gender[], bow[], dist[], country }
}
```

### 5.2 localStorage Keys

| Key | Value |
|---|---|
| `arrowmatch_userid` | User ID string |
| `arrowmatch_access_token` | JWT access token |
| `arrowmatch_refresh_token` | JWT refresh token |
| `arrowmatch_user` | JSON `{ email, isGuest }` |
| `arrowmatch_profile` | JSON profile object |
| `arrowmatch_my_challenges` | JSON array of user's challenges |
| `arrowmatch_history` | JSON array of history entries |
| `arrowmatch_active_matches` | JSON map `{ [matchId]: matchState }` — all non-complete matches |

> **Note:** The legacy key `arrowmatch_match_state` (single match) is migrated to `arrowmatch_active_matches` on first load and then deleted.

### 5.3 API Helper

```javascript
api(method, path, body, { skipAuth })
```
- Adds `Authorization: Bearer {token}` header automatically
- On 401: attempts token refresh once via `POST /api/auth/refresh`, retries original request
- On failed refresh: clears session, redirects to Entry
- On network error: returns `null` (callers fall back to cached data)
- Throws `ApiError(message, status)` on non-ok responses

### 5.4 Session Restore

On `DOMContentLoaded`, `restoreSession()`:
1. Reads localStorage tokens/profile
2. If tokens present: verifies with `GET /api/profile`
3. If valid: shows UI + navigates (challenge link → match; match state → match; else list)
4. If 401: clears session, shows Entry

### 5.5 Key Functions

| Function | Purpose |
|---|---|
| `handleGuest()` | `POST /api/guest` → store tokens → Settings |
| `handleLogin()` | `POST /api/auth/login` → fetch profile → list-challenge |
| `handleRegister()` | `POST /api/auth/register` → Settings |
| `refreshChallengeList()` | `GET /api/challenges?{filters}` → render cards |
| `joinChallenge(id)` | `POST /api/challenges/{id}/join` → `startMatch()` |
| `findOpponent()` | WS matchmaking → `startMatch()` on match; falls back to bot |
| `createChallenge()` | `POST /api/challenges` → private: copy link + mine; live: start match; else mine |
| `refreshMyChallenges()` | `GET /api/challenges/mine` → render cards with Copy Link / Delete |
| `copyPrivateLink(id)` | Builds `?c={id}` URL → `copyToClipboard()` → toast |
| `startMatch(challenge)` | Initializes `STATE.matchState` → connects WS → `showScene('challenge')` |
| `numInput(val)` | Routes to `numInputTotal` or `numInputSet` → broadcasts via WS |
| `checkTotalComplete()` | **async** — fires when all arrows filled; submits to server; polls for result |
| `resolveSet()` | Submits set arrows to server; handles both-submitted and waiting states |
| `resolveTiebreak()` | Handles set-system and total sudden-death tiebreak |
| `completeMatch(myScore, oppScore)` | Renders result overlay; saves history; clears match state; hides resume tab |
| `refreshHistory()` | `GET /api/history` + `GET /api/achievements` in parallel |
| `handleChallengeLink(code)` | Fetches challenge by ID, joins it, starts match |
| `saveMatchState()` | Persists `STATE.matchState` to localStorage (only if not complete) |
| `showToast(msg, type)` | Creates floating toast (info/success/error), auto-removes after 3s |

### 5.6 Critical Rules

- `checkTotalComplete` is defined **exactly once** (async version). The duplicate sync stub was a bug — removed.
- `numInputTotal` calls `checkTotalComplete()` after each arrow (async, fire-and-forget OK)
- All WS sends are guarded: `if (matchSocket?.readyState === WebSocket.OPEN)`
- Bot matches use local resolution only — never POST to server
- Private link detection: `ch.is_private === true || ch.isPrivate === true || ch.match_type === 'private'` (handles both server snake_case and local camelCase)

---

## 6. Backend — Data Models

### 6.1 Enums

| Enum | Values |
|---|---|
| `GenderEnum` | Male, Female |
| `AgeEnum` | Under 18, 18–20, 21–49, 50+ |
| `BowTypeEnum` | Recurve, Compound, Barebow |
| `SkillLevelEnum` | Beginner, Skilled, Master |
| `MatchTypeEnum` | live, async, scheduled, private |
| `ScoringEnum` | total, sets |
| `MatchResultEnum` | win, loss, draw, pending |

### 6.2 Tables

**users**
- `id` (PK, String) — server-issued `AM-{base36ts}-{8rand}`
- `email` (unique, nullable) — null for guests
- `hashed_password` (nullable)
- `is_guest` (Boolean)
- `created_at`, `last_seen` (DateTime)

**profiles**
- `user_id` (PK, FK→users)
- `name` (String 64)
- `gender`, `age`, `bow_type`, `skill_level` (Enum columns)
- `country` (String 64)
- `updated_at`

**challenges**
- `id` (PK, String UUID)
- `creator_id` (FK→users)
- `match_type`, `scoring` (Enum)
- `distance` (String 8, e.g. "30m")
- `arrow_count` (Integer, nullable — null for set system)
- `invite_message` (Text, nullable, max 200)
- `deadline` (DateTime, nullable — required for async/scheduled, optional for private, absent for live)
- `is_private` (Boolean) — True for match_type=private
- `is_active` (Boolean)

**matches**
- `id` (PK, String UUID)
- `challenge_id` (FK→challenges, nullable=True, ondelete="SET NULL") — **NULLABLE** to allow challenge deletion without losing match history
- `status` (String: waiting / active / complete)
- `created_at`, `completed_at`

**match_participants**
- `id` (PK, Integer autoincrement)
- `match_id` (FK→matches)
- `user_id` (FK→users)
- `is_creator` (Boolean)
- `is_bot` (Boolean)
- `final_score` (Integer, nullable) — total arrows sum OR accumulated set points (set system)
- `result` (MatchResultEnum, default pending)
- `submitted_at` (DateTime, nullable)

**arrow_scores**
- `id` (PK, Integer autoincrement)
- `participant_id` (FK→match_participants)
- `arrow_index` (Integer) — global 0-based index; for sets: `set_number * 10 + position`
- `value` (Integer, 0–10)
- `set_number` (Integer, nullable) — set number (1-based); 0 = tiebreak

---

## 7. Backend — API Routes

### 7.1 Auth Routes (`/api`, prefix from `auth.py`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/guest` | None | Issue guest account + tokens |
| POST | `/api/auth/register` | None (rate limited) | Register email + password; reuses existing_user_id for guest upgrade |
| POST | `/api/auth/login` | None (rate limited) | Login; returns tokens + user_id + is_guest |
| POST | `/api/auth/refresh` | None | Exchange refresh token for new access + refresh tokens |
| GET | `/api/auth/me` | Bearer | Return user_id, email, is_guest, created_at |

### 7.2 Profile Routes (`/api/profile`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/profile` | Bearer | Get my profile |
| PUT | `/api/profile` | Bearer | Create or update my profile |
| GET | `/api/profile/{user_id}` | None | Get any user's public profile |

### 7.3 Challenge Routes (`/api/challenges`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/challenges` | Bearer | List active public challenges (excludes own, excludes private) |
| GET | `/api/challenges/mine` | Bearer | List my challenges (all types including private) |
| GET | `/api/challenges/{id}` | None | Get single challenge (used for private link resolution — no auth) |
| POST | `/api/challenges` | Bearer | Create challenge |
| DELETE | `/api/challenges/{id}` | Bearer | Delete my challenge (nulls challenge_id on linked matches first) |
| POST | `/api/challenges/{id}/join` | Bearer | Join challenge; creates Match + 2 MatchParticipants |

**Challenge creation rules:**
- Deadline REQUIRED for async and scheduled types
- Deadline OPTIONAL for private type (link is the access control)
- Deadline NOT sent for live type
- `is_private = (match_type == 'private')`
- Private and live challenges stay active after join; async/scheduled become inactive

### 7.4 Score Routes (`/api`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/matches/{match_id}/set` | Bearer | Submit 3 arrows for one set (or 1 for tiebreak, set_number=0) |
| POST | `/api/matches/{match_id}/score` | Bearer | Submit all arrows for total scoring mode |
| GET | `/api/matches/{match_id}/status` | Bearer | Poll match state (result revealed when both submit) |
| GET | `/api/matches/{match_id}` | Bearer | Full match details |
| GET | `/api/history` | Bearer | My match history (up to 30 by default) |
| GET | `/api/ranking` | None | Global leaderboard (by wins) |
| GET | `/api/achievements` | Bearer | My achievement badges |

### 7.5 WebSocket Routes (`/ws`)

| Method | Path | Auth | Description |
|---|---|---|---|
| WS | `/ws/match/{match_id}?token=...` | Token in query | Live match real-time updates |
| WS | `/ws/matchmaking?token=...` | Token in query | Matchmaking queue |

**WebSocket accept pattern:** `ws.accept()` is called in the route handler BEFORE token validation. This is required by the ASGI WebSocket spec.

### 7.6 Other Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | None | Serve `static/index.html` |
| GET | `/index.html` | None | Serve `static/index.html` |
| GET | `/health` | None | `{"status": "ok", "version": "..."}` |
| GET | `/static/*` | None | Static files (CSS, JS) |

---

## 8. Backend — WebSocket Protocols

### 8.1 Live Match WS (`/ws/match/{match_id}`)

**Client → Server:**
```json
{"type": "ping"}
{"type": "arrow", "arrow_index": 5, "value": 9}
{"type": "set_submitted", "set_number": 3}
{"type": "score_submitted"}
{"type": "tiebreak_submitted", "set_number": 0}
```

**Server → Client (broadcast to opponent):**
```json
{"type": "pong"}
{"type": "opp_arrow", "arrow_index": 5, "value": 9}
{"type": "opp_set_done", "set_number": 3}
{"type": "opp_score_done"}
{"type": "opp_tiebreak_done"}
{"type": "opponent_disconnected"}
```

**Keepalive:** Client sends ping every 20 seconds to keep connection alive.

### 8.2 Matchmaking WS (`/ws/matchmaking`)

**Client → Server:**
```json
{"type": "find", "filters": {...}, "profile": {...}}
{"type": "cancel"}
{"type": "ping"}
```

**Server → Client:**
```json
{"type": "status", "message": "Searching for opponent…"}
{"type": "matched", "match_id": "uuid", "opponent": {...}}
{"type": "cancelled"}
{"type": "pong"}
```

**Bot fallback:** After `BOT_WAIT_SECONDS` (configurable, default 8) of no human match, server sends `matched` with a bot profile.

---

## 9. Match Scoring Logic

### 9.1 Total Score Mode

**Flow:**
1. Archer enters all arrows via numpad → `numInputTotal(val)` → `checkTotalComplete()`
2. When all arrows filled: `POST /api/matches/{id}/score` with `{arrows: [{arrow_index, value}, ...]}`
3. Server saves arrows; computes `final_score = sum(values)`
4. If both participants submitted: server resolves. Winner = higher total. Tie stays `active`.
5. Client shows "waiting" + polls `GET /api/matches/{id}/status` every 2s
6. WS `opp_score_done` triggers immediate re-poll
7. On poll response: if `status === 'complete'`: show result; if `tiebreak_required`: start tiebreak
8. **Tiebreak (total mode):** switches to set-score UI with 1 cell; uses `set_number: 0` sentinel

**Arrow count:** 3–36, step 3, default 18

### 9.2 Set System Mode

**Flow:**
1. Archer enters 3 arrows → `resolveSet()` called automatically (400ms delay after last arrow)
2. `POST /api/matches/{id}/set` with `{set_number, arrows: [v1, v2, v3]}`
3. Server response:
   - `both_submitted: false` → show "waiting for opponent"; store `_pendingSetNumber`; WS `opp_set_done` → re-submit to get result
   - `both_submitted: true` → `_applySetResult()` → update scoreboard, show toast, advance
4. Winner of set: higher 3-arrow total gets 2pts; tie gets 1pt each
5. Match ends: first to 6 set-points. At 6:6 → `tiebreak_required: true` → `_startTiebreak()`
6. **Tiebreak (set mode):** 1-arrow sudden death; highest score wins; exact tie → shoot again

**Set points encoding:** Server stores running set-points in `MatchParticipant.final_score` field (reused for set-point accumulation).

### 9.3 Bot Matches (Local Resolution)

Bot matches never POST to server. Resolution is entirely local:
- Set mode: `_genBotArrows(skill, 3)` generates skill-calibrated arrows; `_resolveSetLocally()`
- Total mode: `_genBotTotal(myScore, skill)` generates a plausible total; `completeMatch()` directly
- Tiebreak: random 0–10 arrow; exact tie → shoot again

**Bot skill table:**
| Skill Level | Mean | StdDev |
|---|---|---|
| Beginner | 5 | 2 |
| Skilled | 8 | 1 |
| Master | 9.5 | 0.5 |

---

## 10. Authentication & Session Management

### 10.1 Tokens

- **Access token:** JWT, short-lived (default 60 min). Claims: `sub` (user_id), `type: "access"`.
- **Refresh token:** JWT, long-lived (default 30 days). Claims: `sub`, `type: "refresh"`.
- Stored in `localStorage`. Sent as `Authorization: Bearer {token}` header.

### 10.2 Guest Upgrade

- Guest user gets a server-issued ID (e.g. `AM-KQ4P9J-ABCD1234`) and JWT tokens.
- To upgrade: `POST /api/auth/register` with `existing_user_id` → server reuses the same ID, sets email + password, flips `is_guest = false`.
- All match history + profile associated with the ID is preserved.

### 10.3 Rate Limiting

- `POST /api/auth/register` and `POST /api/auth/login` are rate-limited.
- Default: 5 requests per 15 minutes per IP.
- Configured via `AUTH_RATE_LIMIT` and `AUTH_RATE_WINDOW` env vars.

### 10.4 Password Hashing

- Uses `bcrypt` library directly (NOT `passlib`).
- Passwords pre-truncated to 72 bytes before hashing (bcrypt hard limit).

---

## 11. Private Challenges

- Created when `match_type = 'private'`.
- NOT shown in `GET /api/challenges` (public list).
- Accessible via `GET /api/challenges/{id}` (no auth required, for recipients before they have an account).
- `is_private = True` set automatically on creation.
- Deadline is OPTIONAL (link is the access control mechanism).
- Private challenges stay `is_active = True` after join (can be reshared).
- **Private link format:** `{origin}?c={challenge_id}` — built by `buildChallengeLink(id)`
- **Copy Link button:** rendered in My Challenges for every challenge where `is_private === true`. Button uses `.btn-copy` class (amber, prominent, visually distinct from Delete).
- On page load: if `?c=` param in URL, `handleChallengeLink(code)` fetches and joins the challenge.

---

## 12. Bot Fallback System

### Live Challenge Creator (waiting for opponent)

1. Creator creates Live challenge → `startMatch()` called with `isCreator=true`
2. `_scheduleBotFallback()` starts a 2-minute countdown
3. Countdown shown in opponent name slot: `Waiting for opponent (1:47)`
4. WS message from opponent cancels the timer (`STATE.matchState._opponentJoined = true`)
5. After 2 minutes with no opponent: bot takes over (same match ID, `isBot=true`)

### Quick Match / Find Opponent

1. WS matchmaking attempted
2. Server tries to pair with a human for `BOT_WAIT_SECONDS` (default 8)
3. Server sends `matched` with bot profile → frontend `startMatch()` with `isBot=true`
4. Frontend fallback if WS unavailable: progress messages → `generateBotOpponent()` after ~4.5s

---

## 13. Filters & Matchmaking

### Frontend Filters (STATE.filters)

| Filter | Type | Options |
|---|---|---|
| skill | multi | Beginner, Skilled, Master |
| gender | multi | Male, Female |
| bow | multi | Recurve, Compound, Barebow |
| dist | multi | 18m, 25m, 30m, 50m, 70m, 90m |
| country | single | Any country string |

Defaults: all options selected (no filtering). Filter badge shows "All" vs "Active".

### Backend Filtering (`GET /api/challenges`)

- `skill`, `bow`, `dist` filtered at SQL level
- `gender`, `country` filtered in Python (post-query) — acceptable for ≤50 challenges
- Own challenges always excluded
- Private challenges always excluded
- Inactive challenges excluded

### Matchmaking Compatibility

Two users are compatible if each user's profile satisfies the other's filter set (bidirectional).

---

## 14. History, Stats & Achievements

### History

- `GET /api/history?limit=30` — returns last 30 completed matches for current user
- Each entry: `match_id, opponent_name, distance, scoring, my_score, opponent_score, result, date`
- Displayed as scrollable list: result icon (✓/✗/=), opponent name, distance + scoring + date, score

### Stats

Computed client-side from last 10 history entries:
- **Avg Score:** mean of `myScore` values
- **Wins (last 10):** count of `result === 'win'`
- **Global Rank:** estimated from wins (placeholder formula: `max(1, 1000 - wins * 50)`)

### Achievements (6 badges)

Computed server-side from match history:
| Badge | Condition |
|---|---|
| 🔥 5 Win Streak | 5+ consecutive wins (most recent first) |
| ⚡ 10 Win Streak | 10+ consecutive wins |
| 👑 25 Win Streak | 25+ consecutive wins |
| 🎯 10 Matches | 10+ total completed matches |
| 🏹 50 Matches | 50+ total completed matches |
| 🌟 100 Matches | 100+ total completed matches |

---

## 15. Deployment & Configuration

### Environment Variables (`.env`)

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | (required) | JWT signing secret |
| `DATABASE_URL` | `sqlite:///./arrowmatch.db` | Database connection string |
| `CORS_ORIGINS` | `http://localhost:3000,...` | Comma-separated allowed origins |
| `AUTH_RATE_LIMIT` | `5` | Max auth attempts per window |
| `AUTH_RATE_WINDOW` | `900` | Rate limit window in seconds (15 min) |
| `BOT_WAIT_SECONDS` | `8` | Seconds before bot spawns in matchmaking |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | Access token lifetime |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | Refresh token lifetime |
| `DEBUG` | `true` | Enables /docs and /redoc; disables in production |

### Quick Start

```bash
cd arrowmatch-backend
cp .env.example .env        # set SECRET_KEY
pip install -r requirements.txt
uvicorn main:app --reload   # → http://localhost:8000
```

### SQLite → PostgreSQL Migration Note

`Match.challenge_id` is nullable (for safe challenge deletion). If migrating from SQLite to PostgreSQL:
```sql
ALTER TABLE matches ALTER COLUMN challenge_id DROP NOT NULL;
```

### Static Asset Build

After editing frontend source files in `archery/`:
```bash
# Rewrite paths for /static/ prefix, mirror full module tree
sed 's|href="css/styles.css"|href="/static/css/styles.css"|g;
     s|src="js/core/|src="/static/js/core/|g;
     s|src="js/match/|src="/static/js/match/|g;
     s|src="js/screens/|src="/static/js/screens/|g;
     s|src="js/app-init.js"|src="/static/js/app-init.js"|g' \
    ../archery/index.html > static/index.html

cp ../archery/css/styles.css   static/css/styles.css
cp ../archery/js/core/*.js     static/js/core/
cp ../archery/js/match/*.js    static/js/match/
cp ../archery/js/screens/*.js  static/js/screens/
cp ../archery/js/app-init.js   static/js/app-init.js
```

---

## 16. Regression Review Checklist

Use this checklist after every change to verify no regressions.

### Authentication & Session
- [ ] Guest login → receives tokens → stored in localStorage → Settings shown
- [ ] Guest upgrade (register with `existing_user_id`) → same user ID preserved
- [ ] Email login → tokens stored → profile fetched → list-challenge shown
- [ ] Session restore on reload: token verified via `GET /api/profile`
- [ ] 401 → auto-refresh → retry → on failure clear session + show Entry
- [ ] Sign Out → clears localStorage + reloads

### Profile
- [ ] All fields required: name, gender, age, bow type, skill level, country
- [ ] `PUT /api/profile` called on save → success toast → list-challenge
- [ ] Profile restored to form fields correctly on `refreshSettings()`
- [ ] Enum values match: Gender (Male/Female), Age (Under 18/18–20/21–49/50+), Bow (Recurve/Compound/Barebow), Skill (Beginner/Skilled/Master)

### Challenge List
- [ ] Public challenges loaded from server on scene show
- [ ] Own challenges NOT in list
- [ ] Private challenges NOT in list
- [ ] Filters applied correctly (multi-select)
- [ ] Challenge cards show name, time-ago, distance, bow, skill, gender, age, message
- [ ] Join → `POST /api/challenges/{id}/join` → match starts

### New Challenge
- [ ] Match type selection (Live/Async/Scheduled/Private)
- [ ] Deadline shown for Async and Scheduled; hidden for Live and Private
- [ ] Distance chip selection required
- [ ] Arrow count stepper works (3–36, step 3)
- [ ] Private → link auto-copied → My Challenges shown
- [ ] Live → match starts immediately
- [ ] Async/Scheduled → My Challenges shown

### My Challenges
- [ ] `GET /api/challenges/mine` loaded on scene show
- [ ] **Copy Link button VISIBLE for every private challenge** (amber `.btn-copy`)
- [ ] Copy Link → correct `?c={id}` URL copied → toast shown
- [ ] Delete → optimistic removal → `DELETE /api/challenges/{id}`

### Match Scene — Total Score
- [ ] Arrow cells colored correctly (10=gold, 9=amber, 8=muted, else default)
- [ ] Row sums shown when row complete
- [ ] Running total shown
- [ ] When all arrows filled: `POST /api/matches/{id}/score` for real matches
- [ ] Bot match: local resolution, no server call
- [ ] Real match: waiting status + polling `GET /api/matches/{id}/status`
- [ ] WS `opp_score_done` triggers immediate re-poll
- [ ] Tie → total tiebreak (1 arrow, set-score UI)
- [ ] Match complete → overlay shown with correct result

### Match Scene — Set System
- [ ] 3 arrows per set, auto-resolves when complete
- [ ] `POST /api/matches/{id}/set` → handles both_submitted=false (wait) and true (apply)
- [ ] WS `opp_set_done` triggers re-fetch of set result
- [ ] Set scoreboard updates after each set
- [ ] Toast shows set result (my_total vs opp_total)
- [ ] First to 6 set-points → match complete
- [ ] 6:6 tie → sudden death tiebreak (1 arrow, set_number=0)
- [ ] Bot set match: local resolution via `_resolveSetLocally()`

### WebSocket
- [ ] Match WS connects on real match start
- [ ] Ping sent every 20s
- [ ] `opp_arrow` updates live indicator
- [ ] `opp_set_done` triggers result fetch
- [ ] `opp_score_done` speeds up polling
- [ ] `opponent_disconnected` shows toast
- [ ] WS unavailable → graceful fallback
- [ ] **Creator flow:** creator connects WS on `challengeId`; when opponent joins, server pushes `opponent_joined` with real `match_id`; creator's socket migrates to `match_id`, UI shows opponent name, bot fallback cancelled
- [ ] **Score submission after join:** creator can `POST /api/matches/{realMatchId}/set` and `/score` after `opponent_joined` received

### Private Challenge Flow
- [ ] `?c={id}` URL on load → `handleChallengeLink()` → fetches challenge → joins → match starts
- [ ] Link shared by creator → recipient can load challenge without account

### History & Achievements
- [ ] `GET /api/history` and `GET /api/achievements` loaded in parallel
- [ ] Stats computed from last 10 entries
- [ ] 6 achievement badges shown (earned state from server)
- [ ] History list shows correct icon, opponent, distance/scoring, date

### Resume Tab
- [ ] Hidden by default
- [ ] Shown when active (incomplete) match exists
- [ ] Hidden after match completes
- [ ] Clicking it navigates to match scene
- [ ] Pulsing animation active when visible

---

## 17. Known Issues & Fixes Log

### Fix 2025-03 — Duplicate `checkTotalComplete` function
- **Issue:** `checkTotalComplete` defined twice — sync stub (dead code) + async real version.
- **Fix:** Removed duplicate sync stub. Only `async function checkTotalComplete()` remains.
- **Status:** ✅ Fixed

### Fix 2025-03 — Copy Link button invisible
- **Issue:** `.btn-sm` missing `cursor: pointer`. `.btn-copy` used low-contrast muted colors, appeared non-clickable.
- **Fix:** `.btn-sm` gets `cursor: pointer; border: none; transition: opacity .15s`. `.btn-copy` uses amber accent background (`--accent`, `#000` text, bold).
- **Status:** ✅ Fixed

### Fix 2025-03 — Static file separation
- **Issue:** Backend served a single 3,100-line `index.html` with inline style + script. Not cacheable.
- **Fix:** Separated into `static/css/styles.css` + `static/js/` modules + lean `index.html` (496 lines).
- **Status:** ✅ Fixed

### Fix 2025-03 — Missing `refreshSetScore` function
- **Issue:** `refreshSetScore()` called in 3 places but never defined. Set scoreboard always showed 0:0.
- **Fix:** Added `refreshSetScore()` in `match/score-input.js` — reads `STATE.matchState.setMyScore/setOppScore`, updates `#set-my-score` / `#set-opp-score`.
- **Status:** ✅ Fixed

### Fix 2025-03 — Wrong element ID `opp-name` → `ch-opp-name`
- **Issue:** `_scheduleBotFallback()` and WS handler used `getElementById('opp-name')` but HTML has `id="ch-opp-name"`. Countdown and opponent name were invisible.
- **Fix:** All 3 occurrences changed to `getElementById('ch-opp-name')`.
- **Status:** ✅ Fixed

### Refactor 2025-03 — JS split into 14 modules
- **Change:** Monolithic `archery/js/app.js` (2,249 lines) split into 14 files in `core/`, `match/`, `screens/`.
- **Motivation:** Each bug-fix required reading/writing the full file. Modules are 68–326 lines, enabling surgical edits.
- **Details:** 101 functions, all global-scope (no ES modules — HTML `onclick=` still works). Load order: `core/*` → `match/*` → `screens/*` → `app-init.js`.
- **Status:** ✅ Complete

### Fix 2025-03 — Creator 404 on score submit + no opponent-joined UI update

**Bug 1 — `POST /api/matches/{id}/set` → 404 for challenge creator**
- **Root cause:** Creator's `startMatch()` used `challenge.id` as `matchId`. No `Match` DB row exists until the opponent calls `join_challenge`. Every score submit hit a UUID that didn't exist.
- **Fix — `ws/manager.py`:** Added `_user_sockets: Dict[str, WebSocket]` (user_id → ws). `register_match` now stores this. New `notify_user(user_id, msg)` sends to that socket. `disconnect_match` cleans it up.
- **Fix — `routers/challenges.py`:** `join_challenge` made `async`. After `db.commit()`, calls `await manager.notify_user(creator_id, { "type": "opponent_joined", "match_id": ..., "opponent_name": ... })`.
- **Fix — `match/websocket.js`:** Added `case 'opponent_joined'`: cancels bot fallback, re-keys `STATE.activeMatches[challengeId → realMatchId]`, closes old socket, opens `_connectMatchSocket(realMatchId)`, updates UI.

**Bug 2 — Creator UI frozen on "Waiting for opponent…"**
- **Root cause:** Server never broadcast anything when the second player's WS connected. The bot-fallback cancellation block only fired on incoming messages — which never came.
- **Fix:** Resolved by Bug 1 fix — `opponent_joined` is now the authoritative signal.

**Status:** ✅ Fixed

---

### Pending / Known Limitations
- **Global Rank** is a client-side placeholder (`max(1, 1000 - wins * 50)`). A real leaderboard would use `GET /api/ranking` and compute rank position server-side.
- **Matchmaking WS** generates match_id in-memory — not persisted to DB. Score submission requires a DB-backed match. Matchmaking is best-effort for the prototype.
- **Offline mode** falls back to mock/local data. No sync queue for deferred submissions.
- **Rate limiting** is in-memory (resets on server restart). Use Redis in production.

---

## Feature 1 — Forfeit Match

### Backend
- `POST /api/matches/{match_id}/forfeit` added to `routers/scores.py`
- Caller gets `MatchResultEnum.loss`, opponent gets `MatchResultEnum.win`
- `match.status = "complete"`, `match.completed_at = utcnow()`
- Returns `{"status": "forfeited", "match_id": match_id}`
- 400 if match already complete

### Frontend
- **Forfeit button** rendered inside `.match-vs` in `scene-challenge`
  - ID: `forfeit-btn`, class: `btn-forfeit` (red, small, subtle)
  - Two-click confirmation pattern: first click changes label to "Confirm forfeit?", second click executes
  - Auto-resets to original label after 4 s if user changes mind
  - Hidden when match is complete (via `renderMatchScene` + `completeMatch`)
- Bot matches: forfeit resolved locally (no API call), user scores 0 vs 1
- WS `opponent_forfeited` message: handled in `_connectMatchSocket` — current match shows overlay, background match silently marked complete

---

## Feature 2 — Multiple Active Challenges

### State Model
- `STATE.activeMatches: { [matchId]: matchState }` — map of all in-progress matches
- `STATE.currentMatchId: string | null` — which match is shown in scene-challenge
- `STATE.matchState` — backwards-compatible property (get/set via currentMatchId)
- `matchSockets: { [matchId]: WebSocket }` — per-match WS map
- `window.matchSocket` — backwards-compatible alias (get/set via matchSockets[currentMatchId])
- `_botFallbackTimers: { [matchId]: timerId }` — per-match bot timers (replaces `_botFallbackTimer`)

### Persistence
- `localStorage.arrowmatch_active_matches` — JSON map of all active match states (replaces single `arrowmatch_match_state`)
- On restore: all non-complete matches loaded; most recent auto-resumed
- Legacy `arrowmatch_match_state` key migrated on first load

### My Challenges — Active Match Rows
- Each challenge card checks `STATE.activeMatches` for a matching `challengeId`
- If found: amber pulsing "Live vs {oppName}" row + "Resume →" button appear above the card tags
- Card border highlighted with `--accent` when has active match
- CSS: `.active-match-row`, `.active-match-label` (pulsing dot), `.active-match-resume`, `.has-active-match`

### Resume Tab Badge
- Badge `#match-count-badge` on `🏹` icon shows count when >1 active match
- Hidden when 0 or 1 match
- Managed by `_updateResumeTab()` — called from `showScene`, `startMatch`, `completeMatch`, `_removeActiveMatch`

### Key New Functions
| Function | Purpose |
|---|---|
| `_updateResumeTab()` | Sync resume tab visibility + badge count |
| `_removeActiveMatch(id)` | Close WS + timer, remove from map, persist, update tab |
| `switchToMatch(id)` | Save current arrow state, switch currentMatchId, re-render scene |
| `forfeitMatch()` | Two-click confirm → API call → completeMatch(0,1,ms.id) |
| `escHtml(str)` | XSS-safe HTML escaping for user names in innerHTML |

### WS Event Routing
- All WS handlers inside `_connectMatchSocket(matchId)` capture `matchId` in closure
- `const targetMs = STATE.activeMatches[matchId]` — routes to correct state
- `const isActive = STATE.currentMatchId === matchId` — gates UI updates
- Background match events: score submissions trigger toast notification only
- `opp_score_done` on background match: toast "X submitted score in another match"
- `opponent_forfeited` on background match: auto-resolves silently + toast
