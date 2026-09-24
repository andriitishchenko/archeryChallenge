# Current architecture

This document describes the architecture present in the repository. Setup, environment variables, endpoint summaries, WebSocket message summaries, and verification commands remain canonical in the root [README](../README.md). Durable design constraints are in [architecture decisions](decisions/architecture.md); verified behavior is in [behavior records](behavior/README.md).

## Runtime and components

- **Backend:** Python application built with FastAPI, SQLAlchemy 2, Pydantic, and Uvicorn. `backend/main.py` creates the app, mounts routers, serves the SPA, and starts/stops expiry processing.
- **HTTP layer:** `backend/routers/` handles auth, profiles, challenges, matches, rematches, statistics, and expiry operations. Request/response models are in `backend/schemas/`.
- **Domain services:** `backend/services/` centralizes challenge creation/serialization and match, scoring, and tiebreak rules shared by routes.
- **Persistence:** `backend/models/` defines SQLAlchemy models. `backend/models/database.py` creates tables and checks `SCHEMA_VERSION`; the guard's destructive reset constraint is recorded in [architecture decisions](decisions/architecture.md).
- **Realtime:** `backend/ws/` maintains per-user WebSocket connections at `/ws/user`, routes events, and queues bounded offline notifications. Matchmaking fallback logic is not persisted as a server match.
- **Frontend:** `frontend/index.html` is the SPA shell and declares classic script load order. `frontend/js/core/` contains API access, shared `STATE`, WebSocket translation, and `EventBus`; `match/` contains scoring state/rendering; `screens/` contains auth, challenge, history, and settings flows. CSS is in `frontend/css/`.
- **Serving:** FastAPI serves the root HTML page and mounts `frontend/` at `/static`.

## Main request and event paths

```text
HTTP request -> router -> shared service -> SQLAlchemy model/database
                         |                    |
                         +-> WebSocket manager <-+

/ws/user -> frontend/js/core/ws.js -> EventBus -> state/match/screen handlers -> DOM
```

The backend validates permissions and owns persisted match and challenge state. The frontend renders server state and holds transient session/cache state. A local shadow bot can simulate a fallback match in the browser; it is not submitted as persisted server match data.

## State ownership

- Database rows are authoritative for persisted users, profiles, challenges, matches, participants, and scores.
- `STATE.activeMatches[matchId]` is the frontend registry for active matches; `STATE.matchState` aliases the currently displayed match.
- `localStorage` supports client session recovery and caching, but does not replace backend validation or authoritative status recovery.
- Server WebSocket events are translated to frontend event types in `frontend/js/core/ws.js`; modules communicate through the shared `EventBus`.

## Dependency and startup shape

Backend dependencies are declared in `backend/requirements.txt`. The root `start.sh` creates/uses `backend/venv`, installs those requirements, and starts Uvicorn. There is no frontend package manifest or build configuration; the browser loads the checked-in scripts directly. Exact commands and the separate server deployment script are documented in the root README.
