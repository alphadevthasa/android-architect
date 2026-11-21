# M5 follow-ups (not blocking 0.5.0)

## Documented limits

Shipped and documented; revisit only if a user hits them.

- Build-code gate is a heuristic (Rulings 20-22): includeBuild in applied scripts or other settings files, build files in a gitignored nested repo, non-ASCII uppercase includeBuild dirs under icase file systems, NUL-density and UTF-16-no-BOM secret-scan skips, agent-written sources, annotation processors and node_modules content. The recommended control stays a container or VM.
- Consent is per clone and applies to any non-interactive process in that clone, including an agent's shell.
- Default `claude` and `codex` argv are unverified and carry no permission profile; the user supplies it via agent.command / requireArgs.
- Token budget is charged from reported usage or an estimate (usageFloor); the codex default reports no usage.
- STOP kills the running agent within about 1 s instead of waiting for the iteration to end (stricter than spec 5.15).

## Backlog (small, low risk)

- Task 1: replaceEmptyTable adds an extra blank line on re-run; attached-value Gradle forms (-g/tmp/x, --project-dir=../x) bypass the path check; script symlinks pointing outside are not checked; same-ids-different-deps plan.json change is silent when only .new is produced.
- Task 2: redact has no pair-wise fuzz; the jwt lookbehind skips a JWT glued to a preceding token character; a key cut mid-body with no END and under 64 lines is kept; per-line log-prefixed PEM bodies end the scan; generic config.worktree refusal message.
- Task 4: see the build-gate limits above.
- Task 5: buildAgentEnv could re-enforce the env allowlist as defense in depth (done in Task 9: verify and drop this line if so).
- Task 8: replace workflow action tags with verified commit SHAs (release blocker, tracked in CONTRIBUTING); create the `release` environment and NPM_TOKEN; verify the npm package name.
- Test hygiene: a CPU-time based assertion helper for linear-time tests; give every test its own cleaned temp dir prefix.
- 1.x: `run --dry-run` token estimate; metrics history (spec 5.17).

## Pre-1.0.0 data audit (maintainer)

Playbooks (verified: false), catalog/versions.json, compliance dates and links, Gson CVE-2022-25647 data, default agent CLI command lines, GitHub Action pins.
