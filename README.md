# ArrowMatch

ArrowMatch is a mobile-first, real-time archery challenge platform. Players can use a guest session or an account, create or join challenges, shoot total-score or set-based matches, and review results.

## Documentation map

- [`AGENTS.md`](AGENTS.md) — required workflow and documentation maintenance rules for agents.
- [`CLAUDE.md`](CLAUDE.md) — repository-specific coding conventions and checks.
- [`DOCS/architecture.md`](DOCS/architecture.md) — current components and data/control flow.
- [`DOCS/behavior/README.md`](DOCS/behavior/README.md) — behavior record format and index.
- [`DOCS/decisions/architecture.md`](DOCS/decisions/architecture.md) — durable architecture decisions and constraints.
- [`FUNCTIONAL_NOTES.md`](FUNCTIONAL_NOTES.md) — status snapshot linking to implemented behavior records.
- [`app_spec.txt`](app_spec.txt) — product requirements and intended scope; use it for planned features.
- This README — setup, configuration, API/WebSocket overview, and verification commands.
- `read.txt` — legacy compatibility pointer; do not add new project documentation there.

When requirements and implementation differ, treat the user request as authoritative for intended changes, use `app_spec.txt` for planned behavior, and inspect code/configuration to establish current behavior before changing an existing contract.

Before modifying or removing a feature, check its linked `DOCS/behavior/` record for automatic side effects and dependent flows.

The current implementation status is recorded in `FUNCTIONAL_NOTES.md`; `app_spec.txt` describes desired scope, not completion status.

## Stack

| Area | Technology |
| --- | --- |
| Backend | FastAPI, SQLAlchemy 2, Python |
| Database | SQLite by default; PostgreSQL via `DATABASE_URL` |
| Authentication | JWT access/refresh tokens, bcrypt password hashing |
| Realtime | One authenticated WebSocket per user at `/ws/user` |
| Frontend | Classic vanilla JavaScript scripts and CSS; no build step or framework |
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

For a server deployment where several projects should share one dependency installation, use the root-level `start_server.sh`:

```bash
chmod +x start_server.sh
./start_server.sh
```

The script installs `backend/requirements.txt` into the current user's Python user-site with `python3 -m pip install --user`, then starts Uvicorn without creating a project-local virtual environment. Set `IP`, `PORT`, `WORKERS`, or `PYTHON_BIN` in the environment to override the defaults. A system-wide installation for all server users requires running pip with administrative privileges; the script intentionally uses the safer per-user shared installation.

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
| `PASSWORD_RESET_EXPIRE_MINUTES` | `60` | One-time password reset link lifetime |
| `APP_BASE_URL` | `http://localhost:8000` | Base URL included in reset emails |
| `SMTP_HOST` / `SMTP_PORT` | unset / `587` | SMTP server for password reset emails |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | unset | Optional SMTP credentials |
| `SMTP_USE_TLS` | `true` | Use STARTTLS for SMTP |
| `EMAIL_FROM` | `noreply@arrowmatch.local` | Sender address for reset emails |
| `AUTH_RATE_LIMIT` | `5` | Auth attempts per rate window |
| `AUTH_RATE_WINDOW` | `900` | Auth rate window in seconds |
| `BOT_WAIT_SECONDS` | `8` | Delay before bot matchmaking fallback |
| `MATCHMAKING_TIMEOUT` | `30` | Matchmaking timeout in seconds |
| `EXPIRY_CHECK_INTERVAL_SECONDS` | `60` | Expiry worker interval |
| `MATCH_INACTIVITY_SECONDS` | `172800` | Inactivity threshold; 48 hours by default |

The database startup reset constraint is documented in [architecture decisions](DOCS/decisions/architecture.md).

## Architecture

See [current architecture](DOCS/architecture.md) for component responsibilities, request/event flow, and state ownership. Durable architecture constraints are maintained separately in [architecture decisions](DOCS/decisions/architecture.md).

## API surface

All protected HTTP requests use `Authorization: Bearer <access_token>`.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /api/guest`, `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, `POST /api/auth/refresh`, `GET /api/auth/me` |
| Profile | `GET/PUT /api/profile`, `GET /api/profile/{user_id}` |
| Challenges | `GET/POST /api/challenges`, `GET /api/challenges/mine`, `GET /api/challenges/{id}`, `DELETE /api/challenges/{id}`, `POST /api/challenges/{id}/join` (HTTP 409 when a participant has 10 open matches) |
| Matches | `GET /api/matches/mine/active`, `GET /api/matches/{id}`, `GET /api/matches/{id}/status`, `POST /api/matches/{id}/set`, `POST /api/matches/{id}/score`, `POST /api/matches/{id}/forfeit` |
| Rematch | `POST /api/matches/{id}/rematch`, `/rematch/accept`, `/rematch/decline`, `/rematch/cancel` (HTTP 409 at the 10 open-match limit) |
| Stats | `GET /api/history`, `GET /api/ranking`, `GET /api/ranking/me`, `GET /api/achievements`, `GET /api/my-challenges` |

The complete request/response contract is defined by the Pydantic schemas in `backend/schemas/` and exposed through `/docs` in debug mode. Update schemas, routers, and this table together when an API contract changes.

## WebSocket contract

Connect to `/ws/user?token=<access_token>`. The connection is persistent for the session.

- Client messages: `ping`, `arrow`, `mm_find`, `mm_cancel`; an `arrow` message may use `value: null` to clear a live preview after correcting an input and may include the full `arrows` snapshot for reconnect recovery.
- Server events: match lifecycle and scoring events (`opponent_joined`, `opp_arrow`, `set_resolved`, `set_tiebreak_started`, `opp_tiebreak_done`, `match_complete`, `tiebreak_started`), rematch events including `rematch_cancelled`, challenge feed events, and matchmaking events; `mm_matched` includes `is_bot=true` for the non-persisted bot simulation; clients confirm set-tiebreak scores through `/api/matches/{id}/status`, and status recovery reconciles a sudden-death pair if concurrent submissions missed the resolution event.

`frontend/js/core/ws.js` translates server `type` values into `EVENT_TYPES`; cross-module frontend communication goes through `EventBus`.

The frontend asks for confirmation before reload/close or browser Back while an unfinished match is active; the in-app Back action uses the same guard.

The server logger `arrowmatch.websocket` records WebSocket connect/disconnect, incoming messages, routing recipients, outgoing messages, offline queueing, and send failures at INFO/WARNING level. Run Uvicorn with its default INFO log level to see these diagnostics.

The browser console records outgoing API requests as `[API →] request` and outgoing WebSocket messages as `[WS →] message`; connection lifecycle and skipped sends are logged too. Sensitive token, password, secret, and authorization values are redacted.

Password recovery uses a one-time, expiring link rather than sending a password in plain text. Configure the SMTP settings above to deliver reset emails; with `DEBUG=true` and no SMTP host, the reset URL is logged for local development.

## Verification

Targeted backend regression tests use Python's standard `unittest` runner and an in-memory SQLite database:

```bash
cd backend
source venv/bin/activate
python -m unittest discover -s tests -v
cd ..
node --test frontend/tests/*.test.js
```

Before handing off a change, also run:

```bash
python3 -m compileall backend
git diff --check
```

The committed tests cover selected auth, scoring, match-state, and rematch rules; they do not replace browser, full API, or live WebSocket verification. For user-facing behavior changes, run the server and exercise the affected flow through the UI. Check `/health`, browser console errors, network responses, authentication boundaries, and persistence after a page refresh. If a change affects a database or WebSocket contract, test both sides of that contract.

## Security and operations notes

- Never use the development `SECRET_KEY` in production.
- Do not expose `/docs` in production unless intentionally enabled.
- Do not put secrets in frontend code or commit `.env` files.
- Validate authorization in the backend even when the UI hides an action.
- Avoid `localStorage.clear()` in new code; remove only keys owned by this application.
