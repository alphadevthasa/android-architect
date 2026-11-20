# Migration roadmap

TODO: run "setup" in your agent

One step per pull request. Update the status of each step when it ships.

The table is generated from the migration plan (`scripts/migration-plan.js --format md`) and written here after you agree to it. Columns:

- Step: the stable step id. `safety-net:<feature>` steps add tests before a feature migrates; `extract:design-system` extracts shared components; `<step>:<feature>` is one step expanded for one feature.
- Description: the title, its tags and the steps it comes after. `[irreversible]` marks a step that cannot be undone once released (take a backup first). `[decision]` marks a step that needs a human decision before it starts.
- Status: `todo`, then `doing`, then `done`.

| Step | Description | Status |
| --- | --- | --- |
