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

## Schema version guard is not a migration system

The startup schema-version guard recreates an older database when `SCHEMA_VERSION` is behind. It is a development mechanism and can destroy persisted data; it does not provide production migrations. Do not describe it as a migration system or bump its version without addressing the destructive behavior.

## Local bot fallback is transient

The matchmaking bot fallback is a browser-side shadow simulation and is not persisted as a server match. Keep this compatibility boundary clear in server persistence and client recovery paths.
