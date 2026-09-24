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

## Documentation and project memory

- Write project documentation in English.
- Before work, read this file, `README.md`, relevant docs, the source/configuration involved, and `git status --short`. Read `CLAUDE.md`, `FUNCTIONAL_NOTES.md`, and `app_spec.txt` when relevant to the task.
- Treat source code and configuration as the authority when they conflict with documentation. Verify the difference and update the affected documentation in the same task; keep intended future behavior in `app_spec.txt`.
- Before fixing a bug or implementing a feature, add or update its expected behavior in the relevant `DOCS/behavior/` component record. After the work, update its status, regression coverage, and remaining limits based on evidence.
- For bugs and features that can be covered by tests, add or update regression tests using the repository's existing test infrastructure. Do not invent or introduce a test framework just to satisfy documentation.
- After significant changes to behavior, architecture, components, commands, dependencies, or constraints, synchronize the canonical documentation in the same task.
- Before adding a fact to documentation, search for an existing canonical home. Keep each fact in one canonical place and link to it instead of copying it elsewhere.
- Keep durable architecture decisions and constraints in `DOCS/decisions/`, separate from behavior records.
- Do not turn documentation into a change log. Exclude changed-file lists, dates, temporary paths, routine build results, and details recoverable from Git.
- Document only facts confirmed in current code/configuration. Do not invent components, commands, tests, limits, or behavior. Never record secrets, tokens, keys, or user data.
- Before handoff, check documentation links and current accuracy, run `git diff --check`, and review the final diff.

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

For project overview and setup, read `README.md`. Architecture and durable constraints live in `DOCS/architecture.md` and `DOCS/decisions/`; implemented behavior lives in `DOCS/behavior/`. `FUNCTIONAL_NOTES.md` is the status index, and `app_spec.txt` is the requirements source for planned scope. `CLAUDE.md` adds coding conventions and high-risk implementation contracts.
