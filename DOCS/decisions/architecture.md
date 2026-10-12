# Durable architecture decisions

These are current constraints that guide future changes. Component responsibilities are mapped in [architecture](../architecture.md); behavior and recovery scenarios are in [behavior records](../behavior/README.md).

## Server authority for persisted state

Authorization, API validation, match outcomes, and persisted challenge/match state remain server-owned. The browser may manage presentation, transient inputs, and recoverable cache state, but cached values cannot authorize an operation or override server status.

## Shared domain rules

Match, tiebreak, challenge, and serialization rules belong in shared backend services, not duplicated across route handlers. Keep request/response validation in schemas and authorization authoritative in backend routes/services.

## One user socket with event translation

The frontend uses one authenticated `/ws/user` connection per user session. Backend events are translated by `frontend/js/core/ws.js`; frontend cross-module communication uses `EVENT_TYPES` and `EventBus`.

## Directly served classic frontend

The SPA uses vanilla JavaScript and CSS, served by FastAPI. `frontend/index.html` declares classic script order. Do not add a framework, bundler, or build step without an explicit product/architecture need.

## Alembic owns database schema changes

Deployment entry points apply Alembic revisions before starting the application, and runtime startup verifies `schema_version`, the Alembic head, and table/index metadata. The baseline migration creates an empty database or adopts the existing version-5 schema only after its structure matches SQLAlchemy metadata. Unknown, older, newer, or structurally different databases must fail without destructive recreation; prepare a reviewed migration and backup before deployment. The initial baseline cannot be downgraded safely.

## Process-local realtime state requires one worker

WebSocket connections, matchmaking queues, offline notifications, rate-limit counters, and the expiry loop are process-local. Run one application worker until these stateful components use shared coordination and a single-owner expiry strategy. Increasing Uvicorn workers can split users and events across isolated managers and can run duplicate expiry loops.

## Local bot fallback is transient

The matchmaking bot fallback is a browser-side shadow simulation and is not persisted as a server match. Keep this compatibility boundary clear in server persistence and client recovery paths.
