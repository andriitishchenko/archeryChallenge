# ArrowMatch — agent instructions

These instructions apply to coding and review agents working in this repository.

`AGENTS.md` contains the shared rules for every agent. Read and follow it first; this file adds the repository-specific architecture, workflow, and safety details.

## Source of truth and scope

- Follow the user's request first.
- Use `app_spec.txt` for planned product requirements, `README.md` for overview and setup, and `DOCS/architecture.md` for current architecture.
- Inspect the current implementation before changing an existing API, event, or data shape.
- Treat current code and configuration as factual truth when they disagree with documentation. Inspect the mismatch, preserve the current runtime contract unless the task explicitly changes it, and update relevant docs and schemas together.
- `backend/` contains the server and persistence logic; `frontend/` is a vanilla-JS mobile-first SPA.

## Non-negotiable project conventions

- UI text and code comments are English.
- Do not add a frontend framework, bundler, or unnecessary build step.
- Keep business rules and authorization on the backend. The client may manage presentation, transient input, and cache state, but never becomes the authority for match results or permissions.
- Use the existing `EventBus` for cross-module frontend communication. Avoid direct imports or DOM access from state-only modules.
- Keep one user WebSocket connection at `/ws/user`; route server events through `frontend/js/core/ws.js` and `EVENT_TYPES`.
- Reuse shared backend services and serializers instead of duplicating match/tiebreak/challenge logic in routers.
- Never add fake persisted data, hardcoded API responses, or test fixtures to production paths. Existing bot/offline fallback code is a known compatibility path; do not expand it silently.

## Documentation and behavior records

- Follow the documentation process in `AGENTS.md`. Component behavior and regression scenarios are recorded in `DOCS/behavior/`; `FUNCTIONAL_NOTES.md` indexes their current status. Read the relevant record before changing or removing existing behavior.
- Record expected behavior before a bug fix or feature implementation. After work, update status, regression coverage, and remaining limits using code and test evidence.
- Keep verified behavior factual and concise, using `Trigger → automatic behavior → result/guard` for automatic flows. Treat persistence, recovery, notifications, validation, events, state transitions, and fallback paths as behavior.
- Keep durable design rationale in `DOCS/decisions/`, not in behavior records. Keep unimplemented requirements in `app_spec.txt`.
- Never remove an implemented behavior without an explicit user request. Search its routes, schemas, events, background tasks, callers, and dependent UI flows first.

## Working procedure

1. Start with `git status --short`, `rg --files`, these agent instructions, `README.md`, the relevant `DOCS/` records, source/configuration, and `app_spec.txt` when requirements matter.
2. Search before editing: use `rg` to find routes, schemas, event names, localStorage keys, background tasks, and call sites.
3. Make the smallest coherent change. Keep API, schema, service, frontend, behavior records, and other affected canonical documentation in sync.
4. Verify the changed behavior at the narrowest useful level, then exercise the affected UI flow when the change is user-facing.
5. Review `git diff`, run the checks below, and report any unverified assumption or pre-existing failure.

For status reviews, compare the behavior records with routes, schemas, events, background tasks, and UI call sites. Record evidence and distinguish code-level confirmation from full end-to-end verification.

Do not reset, discard, or overwrite unrelated user changes. Do not delete databases or other material data unless the user explicitly asks and the exact target is confirmed.

## Local commands

From the repository root:

```bash
./start.sh
```

For a manual server run:

```bash
cd backend
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Useful checks:

```bash
python3 -m compileall backend
git diff --check
curl -fsS http://localhost:8000/health
```

Use browser automation when available for UI verification. If it is unavailable, use the health endpoint and targeted API checks, and state that UI verification was not run. Do not claim a feature is verified from static inspection alone.

## High-risk contracts

- `backend/models/database.py`: schema-version mismatch recreates the development database; `SCHEMA_VERSION` changes are destructive.
- `backend/services/match.py`, `backend/services/tiebreak.py`, `backend/services/challenges.py`: shared match/tiebreak/challenge rules and serialization.
- `frontend/js/core/state.js`: `STATE.activeMatches[matchId]` is the client registry for active matches; `STATE.matchState` aliases the current match.
- `frontend/js/core/event-bus.js`: `EVENT_TYPES` is the cross-module event contract.
- `frontend/index.html`: classic scripts depend on their declared load order; preserve it when adding scripts.
- `frontend/js/core/api.js`: token refresh and authenticated request behavior live here.

## Definition of done

- The requested behavior is implemented in the correct layer.
- Authorization, validation, error states, and duplicate actions are considered.
- Existing automatic side effects and dependent flows are preserved or explicitly documented as changed.
- No unrelated files or generated runtime data are included.
- Relevant checks pass and the result is summarized with file paths.
- Relevant `DOCS/behavior/` records and the status index are updated when behavior, automation, events, state transitions, or fallback paths changed.
- Documentation is updated when setup, API, events, configuration, or agent workflow changed.

Do not invent feature-management tools or mark backlog items complete unless those tools are actually available in the current agent session.
