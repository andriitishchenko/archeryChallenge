# ArrowMatch — shared agent rules

These rules apply to every coding, review, and maintenance agent working in this repository, regardless of model or tool.

## Branch policy

- Start every new task on a new branch automatically, unless the user explicitly names an existing branch or asks to work directly on the current branch.
- Use the `codex/<short-task-name>` prefix by default.
- Check `git status --short` before creating the branch and preserve pre-existing changes; do not silently include unrelated work in the task commit.
- Keep all changes for one task on its task branch until the task is verified and ready to merge.

## Mandatory task lifecycle

- Create a dedicated feature branch before making task changes.
- Complete the requested implementation on that feature branch.
- Run every test explicitly specified by the task; when no tests are specified, run the narrowest relevant checks and record what was verified.
- Run regression testing for the affected area and confirm that existing functionality still passes.
- Commit all task changes after the checks pass, keeping unrelated worktree changes out of the commit.
- Merge the verified feature branch into `main`.
- Delete the feature branch only after the merge succeeds; do not delete unrelated branches.
- Never delete the `main` branch.
- Never delete, rewrite, reset, or force-update history already present on `main`.

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

## Commit policy

- After completing a task and its checks, commit the task changes automatically unless the user explicitly asks to leave them uncommitted.
- When the definition of done is satisfied and the relevant checks pass, the agent must run `git add` for the task files and create the commit without asking for an additional confirmation.
- Pre-existing or unrelated worktree changes must remain untouched and outside the automatic commit; report them separately if present.
- Keep unrelated pre-existing changes out of the automatic commit.

For the repository architecture, commands, and detailed conventions, read `CLAUDE.md` and `README.md`.
