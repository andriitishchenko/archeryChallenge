# Behavior records

Behavior records describe current verified expectations and protect them from regressions. They are not a change log. The status index is [FUNCTIONAL_NOTES.md](../../FUNCTIONAL_NOTES.md); planned requirements remain in [`app_spec.txt`](../../app_spec.txt). Architecture rationale belongs in [`DOCS/decisions/`](../decisions/architecture.md).

## Before changing behavior

Search for the relevant component record and update it with the proposed expected behavior and regression scenario before implementing a bug fix or feature. After implementation, record the resulting status, existing or added regression coverage, and any remaining verification limits. Do not claim tests exist unless they are present in the repository.

Keep related bugs and features together in the component record; do not create a record for every code change. Give each durable requirement a stable ID. Use `BUG-<COMPONENT>-001` for a defect or `FEAT-<COMPONENT>-001` for a feature. Do not recycle IDs.

## Record template

```markdown
## FEAT-COMPONENT-001 — Short behavior name

- Status: Implemented | Partial | Planned
- Scope: Routes, services, frontend area, or other confirmed boundary.
- Goal / reproduction: Feature goal and acceptance criteria; for a bug, observed behavior and reproduction.
- Expected behavior and invariants: Observable result and conditions that must remain true.
- Enforcement and current behavior: Authoritative code boundary and concise `Trigger → automatic behavior → result/guard` description.
- Regression coverage: Test names/paths, or `None committed; ...` with the applicable manual verification boundary.
- Remaining limits: Only known, confirmed gaps; otherwise `None known`.
```

Only include fields applicable to the record type. Keep statements factual and short. A source-code path can identify an enforcement boundary; it is not a substitute for describing expected behavior.

## Component records

- [Authentication, profile, and challenges](auth-challenges.md)
- [Match scoring and lifecycle](matches.md)
- [Realtime, matchmaking, rematch, and client recovery](realtime.md)
- [History, ranking, achievements, and client presentation](stats-client.md)
