# ArrowMatch — shared agent rules

These rules apply to every coding, review, and maintenance agent working in this repository, regardless of model or tool.

## Branch policy

- Start every new task on a new branch automatically, unless the user explicitly names an existing branch or asks to work directly on the current branch.
- Use the `codex/<short-task-name>` prefix by default.
- Check `git status --short` before creating the branch and preserve pre-existing changes; do not silently include unrelated work in the task commit.
- Keep all changes for one task on its task branch so the work can be reviewed or discarded independently.

## Requirements are part of the implementation

- Read `FUNCTIONAL_NOTES.md` before changing an existing feature.
- Treat `FUNCTIONAL_NOTES.md` as the ledger of verified, implemented behavior.
- Whenever a change affects user-visible behavior, automatic behavior, persistence, recovery, API validation, WebSocket events, state transitions, or fallback paths, update the relevant note in the same change.
- Use the format `Trigger → automatic behavior → result/guard` and keep entries factual.
- Update the status snapshot when a feature changes between `Implemented`, `Partial`, and `Planned`.
- Keep planned requirements in `app_spec.txt`; do not mark a feature implemented without code-level evidence.
- A code change is incomplete until its functional documentation and affected API/event documentation are synchronized.

## Safe change workflow

- Inspect `git status --short` before editing and preserve unrelated user changes.
- Search callers, routes, schemas, events, persistence, and UI consumers before changing a contract.
- Make the smallest coherent change in the correct layer; keep backend validation authoritative.
- Verify the affected behavior with targeted checks and report anything not verified, especially browser or end-to-end behavior.
- Review `git diff --check` and the final diff before handoff.
- Never reset, discard, overwrite, or delete unrelated files, databases, or user changes.

For the repository architecture, commands, and detailed conventions, read `CLAUDE.md` and `README.md`.
