# ArrowMatch

ArrowMatch is a mobile-first, real-time archery challenge platform. Players can use a guest session or an account, create or join challenges, shoot total-score or set-based matches, and review results.

## Documentation map

- `README.md` — setup, architecture, API surface, and verification commands.
- `AGENTS.md` — shared rules for all coding and review agents.
- `CLAUDE.md` — rules and workflow for coding agents.
- `FUNCTIONAL_NOTES.md` — short ledger of implemented and automatic behavior; update it with behavior changes.
- `app_spec.txt` — product requirements and intended scope; use it for new features.
- `read.txt` — legacy compatibility pointer; do not add new project documentation there.

When requirements and implementation differ, treat the user request as authoritative, use `app_spec.txt` for the desired behavior, and inspect the code before changing an existing contract.

Before modifying or removing a feature, check `FUNCTIONAL_NOTES.md` for its automatic side effects and dependent flows.

The current implementation status is recorded in the status snapshot at the top of `FUNCTIONAL_NOTES.md`; `app_spec.txt` describes desired scope, not completion status.

## Stack

| Area | Technology |
| --- | --- |
| Backend | FastAPI, SQLAlchemy 2, Python |
| Database | SQLite by default; PostgreSQL via `DATABASE_URL` |
| Authentication | JWT access/refresh tokens, bcrypt password hashing |
| Realtime | One authenticated WebSocket per user at `/ws/user` |
| Frontend | Vanilla JavaScript and CSS; no build step or framework |
| Serving | FastAPI serves `/` and frontend assets under `/static` |

## Run locally

Prerequisite: Python 3 with `venv` and `pip` available.

```bash
./start.sh
```

The script creates `backend/venv` when needed, installs `backend/requirements.txt`, and starts Uvicorn with reload enabled.

- App: <http://localhost:8000/>
- Health: <http://localhost:8000/health>
- OpenAPI UI: <http://localhost:8000/docs> when `DEBUG=true`

Manual start, useful when dependencies are already installed:

```bash
cd backend
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

The SQLite database defaults to `backend/arrowmatch.db` because the server is started from `backend/`. Do not commit local database files.

## Configuration

Set variables in `backend/.env` or the process environment. Settings are read when the backend imports `core/config.py`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SECRET_KEY` | development placeholder | JWT signing key; replace in production |
| `DATABASE_URL` | `sqlite:///./arrowmatch.db` | SQLAlchemy database URL |
| `CORS_ORIGINS` | localhost origins | Comma-separated allowed origins |
| `DEBUG` | `false` | Enables `/docs` and `/redoc` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | Access-token lifetime |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` | Refresh-token lifetime |
| `AUTH_RATE_LIMIT` | `5` | Auth attempts per rate window |
| `AUTH_RATE_WINDOW` | `900` | Auth rate window in seconds |
| `BOT_WAIT_SECONDS` | `8` | Delay before bot matchmaking fallback |
| `MATCHMAKING_TIMEOUT` | `30` | Matchmaking timeout in seconds |
| `EXPIRY_CHECK_INTERVAL_SECONDS` | `60` | Expiry worker interval |
| `MATCH_INACTIVITY_SECONDS` | `172800` | Inactivity threshold; 48 hours by default |

Database startup uses a schema-version guard. If the stored version is older than `SCHEMA_VERSION`, the current implementation drops and recreates all tables. This is a development reset mechanism, not a production migration strategy.

## Architecture

```text
HTTP/WebSocket request
        |
        v
routers/  ->  services/  ->  SQLAlchemy models/database
    |             |
    +------ WebSocket manager notifications

WebSocket -> frontend/core/ws.js -> EventBus -> state/match/screen modules -> DOM
```

Backend responsibilities:

- `backend/main.py` creates the FastAPI app, mounts routers, serves the SPA, and starts expiry processing.
- `backend/routers/` exposes HTTP endpoints and performs request-level authorization.
- `backend/services/` contains shared match, tiebreak, and challenge serialization logic.
- `backend/ws/` owns the single-user socket and matchmaking notifications.
- `backend/models/` defines the schema and startup schema-version behavior.

Frontend responsibilities:

- `frontend/index.html` defines the SPA shell and script load order.
- `frontend/js/core/` owns shared state, API requests, WebSocket routing, and events.
- `frontend/js/match/` owns match state and scoring modes; `score-input.js` is the DOM-facing match renderer.
- `frontend/js/screens/` owns auth, settings, challenges, and history screens.

Persisted match and challenge state is authoritative on the server. `STATE` and `localStorage` are client-side session/cache state and must not replace backend validation. The current frontend also contains a bot/offline fallback; do not treat that fallback as persisted data or extend it when implementing server-backed features.

## API surface

All protected HTTP requests use `Authorization: Bearer <access_token>`.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /api/guest`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`, `GET /api/auth/me` |
| Profile | `GET/PUT /api/profile`, `GET /api/profile/{user_id}` |
| Challenges | `GET/POST /api/challenges`, `GET /api/challenges/mine`, `GET /api/challenges/{id}`, `DELETE /api/challenges/{id}`, `POST /api/challenges/{id}/join` |
| Matches | `GET /api/matches/mine/active`, `GET /api/matches/{id}`, `GET /api/matches/{id}/status`, `POST /api/matches/{id}/set`, `POST /api/matches/{id}/score`, `POST /api/matches/{id}/forfeit` |
| Rematch | `POST /api/matches/{id}/rematch`, `/rematch/accept`, `/rematch/decline` |
| Stats | `GET /api/history`, `GET /api/ranking`, `GET /api/ranking/me`, `GET /api/achievements`, `GET /api/my-challenges` |

The complete request/response contract is defined by the Pydantic schemas in `backend/schemas/` and exposed through `/docs` in debug mode. Update schemas, routers, and this table together when an API contract changes.

## WebSocket contract

Connect to `/ws/user?token=<access_token>`. The connection is persistent for the session.

- Client messages: `ping`, `arrow`, `mm_find`, `mm_cancel`; an `arrow` message may use `value: null` to clear a live preview after correcting an input and may include the full `arrows` snapshot for reconnect recovery.
- Server events: match lifecycle and scoring events (`opponent_joined`, `opp_arrow`, `set_resolved`, `set_tiebreak_started`, `opp_tiebreak_done`, `match_complete`, `tiebreak_started`), rematch events, challenge feed events, and matchmaking events; `mm_matched` includes `is_bot=true` for the non-persisted bot simulation; clients confirm set-tiebreak scores through `/api/matches/{id}/status`, and status recovery reconciles a sudden-death pair if concurrent submissions missed the resolution event.

`frontend/js/core/ws.js` translates server `type` values into `EVENT_TYPES`; cross-module frontend communication goes through `EventBus`.

The server logger `arrowmatch.websocket` records WebSocket connect/disconnect, incoming messages, routing recipients, outgoing messages, offline queueing, and send failures at INFO/WARNING level. Run Uvicorn with its default INFO log level to see these diagnostics.

The browser console records outgoing API requests as `[API →] request` and outgoing WebSocket messages as `[WS →] message`; connection lifecycle and skipped sends are logged too. Sensitive token, password, secret, and authorization values are redacted.

## Verification

There is currently no committed automated test suite. Before handing off a change:

```bash
python3 -m compileall backend
git diff --check
```

For behavior changes, run the server and exercise the affected flow through the UI. Check `/health`, browser console errors, network responses, authentication boundaries, and persistence after a page refresh. If a change affects a database or WebSocket contract, test both sides of that contract.

## Security and operations notes

- Never use the development `SECRET_KEY` in production.
- Do not expose `/docs` in production unless intentionally enabled.
- Do not put secrets in frontend code or commit `.env` files.
- Validate authorization in the backend even when the UI hides an action.
- Avoid `localStorage.clear()` in new code; remove only keys owned by this application.
