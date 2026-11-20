# android-architect M5 (Autonomous run loop, eval suite, release) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `npx android-architect run`, an external runner that executes one roadmap step per fresh agent process with hard budgets, runner-checked exit conditions and human gates. Also ship the tool's own eval suite and a release pipeline (CI plus `npm publish --provenance`), so v1 can be published.

**Architecture:** The runner is plain Node libraries in `skill/scripts/lib/` (config, roadmap/plan state, git safety, verification, agent adapter, step brief, loop engine, run reports) behind a thin `skill/scripts/run.js` entry that `bin/cli.js` forwards to. Every decision that ends or pauses the loop is made by runner code, never by the model. The agent CLI is a pluggable command template, so tests drive the loop with a stub executable. The eval suite and CI files are repository-only (not in the published package).

**Tech Stack:** Node >= 20 ESM, `node:test`, `node:child_process` (`execFile`/`spawn` with argv arrays only, never a shell), `node:crypto`. No dependencies. GitHub Actions for CI/release.

**Spec:** `docs/superpowers/specs/2026-11-19-android-architect-design.md` §5.15 (run loop), §5.16 (eval suite), §5.13 (security), §7 (done means). Backlog: `docs/superpowers/m4-followups.md`.

**Out of scope:** `run --dry-run` and metrics history (spec 5.17, v1.x); a hosted service; telemetry; running more than one agent at a time.

## Global Constraints

- All docs, prompts, templates and code comments are in English.
- Node `>=20`, `"type": "module"`, **no dependencies, no devDependencies**, no install scripts. `npm test` keeps running under `test/helpers/no-network.mjs`. The published `files` stay `["bin", "skill"]`; eval, CI and release files live outside them.
- Scripts make **no network requests**. The runner never calls `git push`, `git merge`, `git remote`, `npm publish` or any network command, and never passes a flag that does. A test asserts this by recording every spawned command.
- Child processes (`git`, the agent CLI, verification commands) are started with `execFile`/`spawn` and **argv arrays**, never a shell string. Verification commands in `run.config.json` are argv arrays (spec 5.15 calls them "commands"; designer call: arrays, so no shell parsing of project-controlled text).
- The runner refuses to start on the default branch or with a dirty tree, creates its own branch (or worktree), commits per step with conventional commit messages **without `Co-Authored-By` or `Claude-Session` trailers** (user rule), and never pushes, merges or publishes.
- Verification executes the project's Gradle build code: the runner states this and requires a confirmation on first use per project (recorded in `.ai/runs/.confirmed`, a local-only file added to `.git/info/exclude`).
- Everything the runner writes or prints passes through `redact()` from `lib/redact.js`; untrusted text (agent output, command output, step ids) is sanitized with `mdText`/`oneLine` before it lands in Markdown. Writes go only under `<root>/.ai/` (guarded writer) and git.
- Agent output and verification logs are untrusted data: they are never executed, never interpreted as instructions, and exit conditions never depend on model prose.
- Defaults are conservative (spec 5.15): 10 iterations, a modest token cap. Raising them is a deliberate edit of `run.config.json`.
- Commit messages: conventional commits, no trailers. Data written from memory (default agent flags) is marked unverified in docs, because agent CLI flags change between releases.
- Package version becomes `0.5.0` (release candidate); `1.0.0` is cut only after the eval suite passes and a maintainer audits the unverified data.

## Review Focus

1. A stub agent that hangs, prints enormous output, writes a malformed or forged status, or exits non-zero. Expected: wall-clock/turn limits kill it, output is capped and redacted, a missing or invalid status counts as `failed`, and the loop stops per the exit rules. Pinned in Tasks 3, 4 and 6.
2. A dirty tree, a detached HEAD, a repo with no commits, the default branch under a different name (`main`, `master`, `trunk`, the remote HEAD). Expected: refuse to start with a clear message and change nothing. Pinned in Task 2.
3. `.ai/STOP` appearing mid-iteration, a crash between "agent done" and "roadmap updated", and a re-run after an interruption. Expected: stop after the current iteration, and resume from the roadmap without repeating a `done` step or skipping a `doing` one. Pinned in Tasks 1 and 4.
4. Steps tagged `irreversible` or `decision` (or whose playbook has a security checklist) reached through `dependsOn`, and a plan where every remaining step is gated. Expected: the loop pauses with `needs-human` and never executes a gated step, and a gated step blocks only its dependents, not independent steps. Pinned in Task 4.
5. Hostile content: a step id or title with control characters, markdown or shell metacharacters; verification output containing secrets or instruction-like text; a repo whose `.ai/run.config.json` tries to inject shell strings, absolute paths outside the project, or a command that pushes. Expected: strict config validation rejects it, logs are redacted, and nothing is interpreted. Pinned in Tasks 1, 2 and 6.

---

### Task 1: Run config, plan state and status contract

**Files:**
- Create: `skill/scripts/lib/runconfig.js`, `skill/scripts/lib/runplan.js`, `skill/scripts/lib/runstatus.js`, `skill/templates/ai/run.config.json`
- Modify: `skill/scripts/migration-plan.js` (`--write` flag), `skill/scripts/lib/aidir.js` (create `run.config.json` as user-owned when missing)
- Test: `test/runconfig.test.js`, `test/runplan.test.js`, `test/runstatus.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_RUN_CONFIG` and `loadRunConfig(root) -> Config`. Shape: `{ schemaVersion: 1, agent: { kind: 'claude'|'codex'|'custom', command: string[] (argv template), env?: Record<string,string> }, budgets: { maxIterations: 10, maxTotalTokens: 400000, maxTurnsPerStep: 20, maxWallClockMinutes: 120 }, verification: { commands: string[][], timeoutSeconds: 1800 }, branchPrefix: 'android-architect/run' }`. Strict validation with file-prefixed errors (`.ai/run.config.json: ...`): unknown keys, non-array argv, empty argv, argv items longer than 500 chars or containing NUL/newlines, absolute-path or `..` arguments only in the executable position when it is a bare name (no path separators allowed in `agent.command[0]` unless `kind: custom`), budgets must be positive integers capped at hard maximums (200 iterations, 20 million tokens, 200 turns, 24 hours), `env` keys/values restricted to `[A-Z0-9_]` names and printable values, and a denylist of verification/agent argv tokens: `push`, `publish`, `remote`, `merge`, `curl`, `wget`, `ssh`, `scp`, `nc` as any element of `git`/`npm`-style argv or as the executable. The default `verification.commands` is `[["./gradlew","assembleDebug","testDebugUnitTest","lint"]]`.
  - `parseRoadmap(markdown) -> { steps: { id, title, tags: string[], status: 'todo'|'doing'|'done', line: number }[], errors: string[] }`. It reads the table that `renderRoadmap` writes (`| \`id\` | description | status |`), takes tags from `[irreversible]`/`[decision]` in the description, and ignores everything outside the table. Rows that do not match are reported in `errors` and never guessed.
  - `loadPlan(root) -> Plan`: reads `.ai/migration/plan.json` (the full `buildPlan` output with `dependsOn`, `playbook`, `feature`, `tags`, `verification`; written by `migration-plan.js --write`) and the roadmap, and joins them by step id. A roadmap row without a plan step, or a plan step without a row, is an error. Statuses come from the roadmap (the source of truth the user also edits).
  - `nextRunnable(plan, { skip: Set<string> }) -> { step, reason } | { gated: Step[] } | { done: true } | { blocked: Step[] }`: the first `todo` step in plan order whose dependencies are all `done` and that is not gated. `gated` = tags include `irreversible` or `decision`. When no runnable step exists but gated or blocked steps remain, say which (`gated` first). Steps whose dependencies include a gated or failed step are blocked, independent steps still run.
  - `setStatus(root, id, status)`: rewrites only the Status cell of that row in `.ai/migration/roadmap.md` (atomic write through the guarded writer, exact row match on the backticked id, refuses if the row's current status is not the expected previous one via an optional `expect` argument).
  - `parseStatus(raw: string) -> { ok: true, status } | { ok: false, reason }`: the agent's final status JSON `{ step: string, status: 'done'|'blocked'|'needs-human'|'failed', summary: string, filesChanged: string[], verification: string }`. It extracts the LAST JSON object in the output between `<<<STATUS` and `STATUS>>>` markers (designer call: explicit markers so prose cannot forge it), validates shape and lengths (summary <= 2000 chars), and requires `step` to equal the expected step id. Anything else is `{ ok: false }`.
  - `migration-plan.js --write` (after the user agrees): writes `.ai/migration/plan.json` and, only when `roadmap.md` still contains the template line `TODO: run "setup"`, replaces the table region of `roadmap.md`; otherwise it writes `roadmap.md.new` and says so. Writes go through the guarded `.ai/` writer. Exit codes as before.
  - `templates/ai/run.config.json` is created by init as a user-owned file (never overwritten), equal to the default config.

- [ ] **Step 1: Write failing tests.** Config: each rejection case (unknown key, string instead of array, shell metacharacter string as one argv element is allowed as data but an element `push` after `git` is rejected, budget over the hard max, `env` key `PATH ` with a space, `agent.command[0]` with a slash for kind `claude`) throws a file-prefixed error; the default config loads when the file is missing; a written default round-trips. Roadmap: parse the exact output of `renderRoadmap` for a plan with tags and `(after: ...)`; a malformed row lands in `errors`; hostile titles do not break parsing. `nextRunnable`: dependency order, gated step skipped with its dependents blocked while an independent step still runs, all-done, only-gated. `setStatus`: changes one cell, leaves every other byte identical, refuses a symlinked file. `parseStatus`: valid, forged status in prose without markers, two blocks (last wins), wrong step id, 3 MB output (bounded, linear).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: add run config, plan state and status contract`

---

### Task 2: Git safety and verification runner

**Files:**
- Create: `skill/scripts/lib/rungit.js`, `skill/scripts/lib/runverify.js`
- Test: `test/rungit.test.js`, `test/runverify.test.js`

**Interfaces:**
- Consumes: `gitEnv()` helper pattern from `lib/git.js` (LC_ALL=C), `redact()`, `Config`.
- Produces:
  - `startRunBranch(root, { branchPrefix, now }) -> { branch, baseBranch, baseCommit }`: refuses (throws `RunRefusal` with a plain message) when: not a git repo, no commits, detached HEAD, the current branch is the default branch (detected as `refs/remotes/origin/HEAD` target, else any of `main`, `master`, `trunk`, `develop`), the tree is dirty (`git status --porcelain` non-empty, untracked files included except `.ai/runs/`), or `.git/info/exclude` cannot be updated. It creates `<branchPrefix>-<YYYYMMDD-HHMMSS>` from HEAD and checks it out. A re-run on an existing runner branch (name starts with the prefix) resumes without creating a new one.
  - `commitStep(root, step, message) -> { commit, filesChanged: string[] }`: stages with `git add -A -- . ':(exclude).ai/runs'` and commits with `-c user.useConfigOnly=true`; message `feat(migration): <step id>: <title (oneLine, max 72)>` with no trailers; refuses when nothing is staged (returns `null`, the loop treats it as "no diff").
  - `diffSince(root, commit) -> { files: string[], insertions, deletions }` and `hasChanges(root) -> boolean`.
  - `RunRefusal` class and a guard `assertNeverNetwork(argv)` used by the runner's single spawn wrapper: throws if an argv contains `push`, `fetch`, `pull`, `clone`, `remote`, `merge`, `rebase` for `git`, or the executable is `curl`/`wget`/`ssh`/`scp`/`nc`/`npm publish`. Every git call in the runner goes through one wrapper `runGit(root, args)` that applies it.
  - `runVerification(root, config, { timeoutMs, now }) -> { ok: boolean, results: { argv, exitCode, timedOut, tail: string, signature: string }[] }`. Each command runs with `spawn(argv[0], argv.slice(1), { cwd: root, shell: false })`, a hard timeout (SIGTERM then SIGKILL after 5 s), stdout+stderr merged into a ring buffer of the last 20 KB, redacted. `signature` is the error signature (spec 5.15 "normalized error hash"): the first 5 lines containing `error`, `FAILED` or `Exception` (case-insensitive), with absolute paths, numbers, hex ids, timestamps and temp dirs normalized, joined and SHA-256'd (first 16 hex chars); empty when ok.
  - `confirmFirstUse(root, { confirm: () => boolean, say })`: prints the statement "verification runs your project's Gradle build code and may reach the network" and returns whether `.ai/runs/.confirmed` exists or `confirm()` returned true (then writes it, and adds `.ai/runs/` to `.git/info/exclude`).

- [ ] **Step 1: Write failing tests** with temp git repos: clean repo on `main` -> refused (default branch); a repo on a feature branch with a dirty tracked file and with an untracked file -> refused; detached HEAD, no commits, not a repo -> refused with distinct messages and the tree untouched; success creates the branch and resume reuses it; `commitStep` makes one commit without trailers and `null` on an empty diff; `assertNeverNetwork` rejects each forbidden argv; every git call recorded by a PATH shim for `git` (a script that logs argv then delegates to the real git) never includes `push`/`fetch`/`remote`/`merge`. Verification: a passing and a failing command (small node scripts), a command exceeding the timeout is killed and `timedOut`, 5 MB of output is bounded to 20 KB, a secret printed by the command is redacted in `tail`, signature equality for two failures differing only in numbers/paths and inequality for different errors, `shell: false` (an argv element `; touch x` is data and creates nothing).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: add run branch safety and verification runner`

---

### Task 3: Agent adapter and step brief

**Files:**
- Create: `skill/scripts/lib/agent.js`, `skill/scripts/lib/stepbrief.js`
- Test: `test/agent.test.js`, `test/stepbrief.test.js`, test helper `test/helpers/stub-agent.mjs` (a configurable stub CLI)

**Interfaces:**
- Consumes: `Config`, `parseStatus` (Task 1), `queryIndex`/index file, `loadAdrs`, `loadPlaybooks`, `redact`, `mdText`.
- Produces:
  - `runAgent(root, config, { brief, step, turns, timeoutMs, now }) -> { status: ParsedStatus, usage: { inputTokens, outputTokens, totalTokens }, exitCode, timedOut, outputTail: string, logPath? }`. It spawns `config.agent.command` (argv template with placeholders `{brief}` (a path to the brief file, written under `.ai/runs/<ts>/brief-N.md`), `{maxTurns}`, `{step}`) with `shell: false`, cwd `root`, a sanitized environment (only `PATH`, `HOME`, `LANG` and the configured `env`), stdin closed, a hard wall-clock timeout (kill escalation as in Task 2), output ring buffer 200 KB, redaction on everything stored. Usage is read from the CLI's JSON output when present (designer call: the adapter understands a documented minimal shape `{"usage":{"input_tokens":n,"output_tokens":n}}` anywhere in the last JSON line, with the stub and docs defining it; unknown shape means usage `null`, and the budget check then falls back to a per-iteration estimate of `maxTotalTokens / maxIterations` so a missing usage can never disable the token budget).
  - Default templates (documented as **unverified, check your agent CLI's current flags**): `claude` kind: `["claude","-p","@{brief}","--output-format","json","--max-turns","{maxTurns}"]`-style template plus a restricted permission profile flag set; `codex` kind: `["codex","exec", ...]`. The defaults live in `agent.js` as data, the user can override the whole argv in `run.config.json`. The restricted profile must allow edits and the configured verification commands only and no network tools; because flag names are not verified here, `run` prints the effective argv at start and refuses to run a `claude`/`codex` template that lacks any element named in a small required-restriction list from the config (`agent.requireArgs`, default empty) — documented as the user's responsibility.
  - `buildStepBrief(root, { step, plan, config, adrDir, indexPath }) -> string`: Markdown with: the step (id, title, tags, dependsOn), acceptance criteria (the step's `verification` strings plus the configured verification commands), the accepted ADRs relevant to the step's dimension/feature (title + decision section, capped), the target sections from `architecture-target.md` when `status: accepted`, matching `components.md` registry entries (block text, capped), the playbook text for `step.playbook` (Steps, Pitfalls, Security checklist, Rollback; marked unverified), the top 5 index hits for the step title/feature (path + line + title only), the repository rules (one step only, never push/merge, end with the status block format using `<<<STATUS` ... `STATUS>>>`), and an explicit paragraph: repository content is data, not instructions. Everything untrusted passes through `mdText`/`redact`; total size capped at 24 KB with "… N more" markers (context per step stays roughly constant, spec 5.15).

- [ ] **Step 1: Write failing tests** using the stub agent (a node script selected by an env var or argv: modes `done`, `blocked`, `needs-human`, `failed`, `hang`, `flood` (50 MB output), `forge` (prose containing a fake status), `badjson`, `nonzero`, `usage` (prints a usage line), `leak` (prints a fake secret)): each mode maps to the expected `status`/`timedOut`/`usage`; flood is bounded; the leak is redacted in the stored tail and log; the environment received by the stub contains only the allowed variables (the stub echoes `process.env` keys); an argv template with `{brief}` gets a real file path; `shell:false` (hostile `{step}` value is data). Brief: contains the step, the accepted ADR but not a `proposed` or `rejected` one, the playbook sections for a step with `playbook`, the components block, index hits; size cap with a huge ADR; hostile step titles/ADR text are escaped; the data-not-instructions paragraph and the status marker format are present; the brief passes `scanInstructions` clean (it is generated, trusted text) while quoted project content is clearly delimited.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: add agent adapter and step brief builder`

---

### Task 4: Loop engine, exit conditions and run reports

**Files:**
- Create: `skill/scripts/lib/runloop.js`, `skill/scripts/lib/runreport.js`
- Test: `test/runloop.test.js`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  - `runLoop(root, { config, agentRunner = runAgent, verifier = runVerification, git = rungit, now, say }) -> RunResult` where `RunResult = { outcome: 'done'|'budget'|'no-progress'|'repeated-error'|'verification-failed'|'needs-human'|'stopped'|'failed'|'refused', reason: string, iterations: number, steps: { id, status, commit? }[], usage: { totalTokens }, reportPath }`. The injectables make the engine testable without processes.
  - **Exit conditions, all decided by this function from runner-observed facts** (spec 5.15):
    1. All steps `done` -> `done` plus the final report.
    2. Budgets: `iterations >= maxIterations`, cumulative tokens (or the estimated fallback) `>= maxTotalTokens`, wall-clock since start `>= maxWallClockMinutes`; `maxTurnsPerStep` is passed to the agent and enforced by the agent timeout/kill. Any budget stops with `budget` and names which.
    3. No progress: the same step failed twice (`failed` status, invalid/missing status, or non-zero exit), an iteration ended with no diff (`hasChanges` false after a `done` claim), or the same error signature repeats in two consecutive iterations -> `no-progress`/`repeated-error`.
    4. Verification fails twice for the same step after the agent's fix attempt: after a `done` claim the runner verifies; on failure it re-runs the agent once with the failure tail added to the brief, verifies again, and a second failure stops with `verification-failed`. The step stays `doing` and the uncommitted changes are left in the tree for the human (never reset/cleaned by the runner).
    5. Human gates: a step tagged `irreversible`/`decision` is never executed (`nextRunnable` skips it); when only gated or blocked steps remain the outcome is `needs-human` with each gated step's id and why.
    6. `.ai/STOP` (a regular file, checked with lstat; a symlink is ignored with a warning) is checked before each iteration and after the agent returns: the loop stops after the current iteration finishes with `stopped`.
  - On `done` + verification ok + diff: `commitStep` then `setStatus(done)`; the commit happens BEFORE the roadmap edit and the roadmap file is committed in the same commit (designer call: one commit per step contains the roadmap status change), so a crash in between leaves a `doing` step with a commit that the next run detects (`git log` message match) and then only marks `done` without re-running (resume rule). A step the agent reports `blocked` or `needs-human` stops the loop (`needs-human` outcome) with the agent's summary (sanitized).
  - Status transitions: `todo -> doing` before the agent runs (committed with the step), `doing -> done` only by the runner.
  - Every iteration writes `.ai/runs/<timestamp>/iteration-<n>.json` (`{ step, status, exitCode, durationMs, usage, verification: {ok, signatures}, commit, diffFiles }`) and a redacted log; the final `report.md` (sanitized Markdown) lists completed steps, pauses with reasons, total usage, the branch name, and how to resume (`run` again continues from the roadmap). Reports and logs are written through the guarded writer.
  - Resume: an interrupted run (crash, kill) is safe to re-run: `todo`/`doing`/`done` statuses plus the commit-message marker decide what remains.

- [ ] **Step 1: Write failing tests** with injected fake `agentRunner`, `verifier` and an in-memory or temp-dir git (Task 2 helpers): one test per exit condition (done; each of the three budgets, including an agent that reports no usage so the estimate trips the token budget; same step failed twice; empty diff after a `done` claim; repeated error signature; verification failing twice leaves the tree untouched and the step `doing`; human gate with an independent runnable step still executed first and a gated dependent blocked; all remaining gated -> `needs-human`; STOP file before and during an iteration; STOP symlink ignored; missing/invalid status counts as `failed`); resume after a simulated crash between commit and status update does not re-run the step; roadmap edits only touch status cells; reports contain no secrets and no raw control characters; never calls `git push` (the `git` double records calls).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The engine is a plain loop over `nextRunnable`; keep exit-condition checks in one small function so each is unit-tested.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: add run loop engine with exit conditions and reports`

---

### Task 5: `run` command, CLI wiring and docs

**Files:**
- Create: `skill/scripts/run.js`
- Modify: `bin/cli.js` (new `run` command), `skill/SKILL.md` (new "Not available to the agent" note and a `run` section), `skill/templates/ai/workflows/03-implement.md` (mention that the runner uses the same step boundaries), `README.md`, `CHANGELOG.md`
- Test: `test/run-cli.test.js`, additions to `test/skill-docs.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces:
  - CLI `android-architect run [--root <dir>] [--agent claude|codex] [--max-iterations N] [--max-tokens N] [--max-minutes N] [--yes]`: loads the config (flags only lower or set within hard maximums, and a flag raising above the config value requires the flag to be explicit — designer call: flags override config in either direction but never above the hard maximums), prints the effective plan before starting (branch to create, agent argv with the brief path placeholder, budgets, verification commands, the steps that will run, the gated steps that will be skipped), asks for first-use confirmation (`--yes` skips only the confirmation prompt, never the git safety checks), runs `runLoop`, prints the outcome and report path, and exits 0 for `done`, 1 for any stop that needs attention (`budget`, `no-progress`, `repeated-error`, `verification-failed`, `stopped`, `needs-human`, `failed`), 2 when it refuses to start (`RunRefusal`, not a Gradle project, no `.ai/`, no plan). `needs-human` and `stopped` are exit 1 with a distinct message.
  - The agent-facing skill never runs `run`: SKILL.md says the user starts it from a terminal, because it is long-running and spawns agent processes; the agent may help edit `run.config.json` and explain the report.
  - README "Autonomous runs" section: how it works, the exit conditions, the safety model (own branch, no push/merge/publish, human gates, verification executes project build code), how to resume and stop (`.ai/STOP`), and that default agent flags are unverified.

- [ ] **Step 1: Write failing tests**: with the stub agent configured in a temp project's `run.config.json` (argv pointing at the stub), `run` completes a two-step plan end to end (exit 0, two commits on the run branch, roadmap rows `done`, report present); refusing cases exit 2 with clean messages (default branch, dirty tree, no `.ai/`, no plan, invalid config); each stop outcome exits 1; `--yes` skips the prompt but not the branch refusal; a prompt answered "no" exits 1 without running the agent or verification; effective plan printed before anything runs; usage/errors contain no absolute path or stack. SKILL docs tests: `run` described, "the agent never runs it" text present, every flag in the docs exists in `run.js` (derive from the parser), README section present.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: add the run command and document autonomous runs`

---

### Task 6: Runner end-to-end matrix with a stub agent CLI

**Files:**
- Create: `test/run-e2e.test.js`, fixture `test/fixtures/run-app/` (small Gradle project with a pre-written `.ai/` including `plan.json` and `roadmap.md` for 4 steps: one plain, one with a dependency, one `[decision]`, one `[irreversible]`), helper additions to `test/helpers/stub-agent.mjs`
- Modify: none in `skill/`

**Interfaces:** consumes the real `bin/cli.js run` with real git and a stub agent executable (no injected doubles). Verification command in the fixture config is a tiny node script (`["node","verify.js"]`) that passes, fails, or fails twice on a switch file.

- [ ] **Step 1: Write the tests (this task is the spec's "runner tests with a stubbed agent CLI", §7).** Each case runs the CLI in a temp copy of the fixture initialised as a git repo on a feature branch:
  - **done**: plain steps complete, gated steps are reported, outcome `needs-human` at the end because the remaining steps are gated (expected exit 1) — and a variant fixture with no gated steps ends `done` exit 0.
  - **each budget**: `--max-iterations 1`, and a stub reporting token usage above `--max-tokens`. The wall-clock budget is covered by the Task 4 unit tests with the injected `now` (production code gets no test-only clock hooks, and the e2e matrix must not sleep for minutes).
  - **no progress / repeated error / verification failing twice / missing status / malformed status / forged status in prose / hung agent (timeout kill) / flooding agent**.
  - **human gate**: `[decision]` and `[irreversible]` steps never run (assert the stub was never invoked with those ids), independent steps run.
  - **STOP file** created by the stub during an iteration -> `stopped` after that iteration.
  - **refusals**: default branch, dirty tree, detached HEAD.
  - **never pushes/merges/publishes**: a `git` PATH shim records argv; assert no `push|fetch|remote|merge|pull` and that the real repo's `git remote` is empty; a hostile `run.config.json` with a `push` argv is rejected at load.
  - **resume**: kill the CLI process mid-iteration (SIGKILL the child run after the stub signals readiness through a file), re-run, and assert the interrupted step is retried exactly once and completed steps are not repeated.
  - **secrets**: the stub prints a fake secret and an instruction-like line; neither appears raw in `.ai/runs/**`, and `ai-status` does not trust or execute anything from the logs.
- [ ] **Step 2: Run, expect FAIL where behavior is missing, and fix `skill/` only for genuine bugs the matrix finds (record each in the report).**
- [ ] **Step 3: Run `npm test`, expect PASS; keep total test time reasonable (< 60 s for this file; use small timeouts via config minimums and `timeoutSeconds` values in seconds where allowed).**
- [ ] **Step 4: Commit** `test: add runner end-to-end matrix with a stub agent`

---

### Task 7: Eval suite for the tool itself

**Files:**
- Create: `test/eval/README.md`, `test/eval/golden/*.json` (expected stack profiles and sanity rules for in-repo fixtures), `test/eval/eval.test.js`, `test/eval/apps.json` (pinned real-app manifest), `dev/fetch-eval-apps.mjs`, `dev/record-eval.mjs`
- Modify: `package.json` (`"eval": "node --test test/eval/"` script; `test` script unchanged), `.gitignore` (`test/eval/apps/`)
- Test: `test/eval/eval.test.js` is the suite

**Interfaces:**
- `golden/<fixture>.json`: `{ fixture, profile: <expected scan profile subset asserted EXACTLY: dimensions -> entry ids and shares, modules, sdk>, rules: [{ id, kind: 'guardrail'|'must-not-recommend'|'must-recommend', ... }] }`.
- `apps.json`: `{ schemaVersion: 1, apps: [{ id, era: 'legacy-java-mvp'|'mvvm-rxjava'|'modern-compose', repo: 'https://…', commit: '<40-hex>', license, notes }] }` — **the pinned commits and repository choices are decisions for a maintainer**: ship the file with `apps: []` and the documented format, and a README that tells a maintainer how to add apps (spec 5.16 names Now in Android as the modern example; do not invent commit hashes). `dev/fetch-eval-apps.mjs` (maintainer-only, uses `git` with network, never part of `npm test`, excluded from the package by `files`) clones each pinned commit into `test/eval/apps/<id>`; `dev/record-eval.mjs` runs `scan.js` and writes a golden file for human review.
- `eval.test.js` has two parts: (1) **deterministic, always runs in CI**: for every in-repo fixture with a golden file, assert the exact profile; run the guardrail on a canned set of recommendations per fixture (recorded JSON in `golden/recs/`) and assert pass/fail as expected; assert the "must not recommend X" rules (for example the legacy Java+MVP fixture must not receive a step that jumps to Compose+MVI without justification; guardrail catches it); assert candidate paths for each fixture are stable (golden). (2) **real apps**: for each app in `apps.json` whose folder exists, assert its golden profile; skipped with a printed notice when the folder is absent. A third, **model-dependent part is documentation only** (`test/eval/README.md`: how a maintainer runs the model flow before each release and on every catalog or prompt change, and records the result in the release notes) — it is never run by CI.

- [ ] **Step 1: Write failing tests** (golden files for the existing fixtures `legacy-java-mvp`, `modern-compose`, `mixed`, `feature-app`, `reuse-app`, `secrets`, `insecure-app`; recs for at least three of them; one deliberately violating recs file per rule kind).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the dev scripts and record the goldens (reviewed by diffing against `scan.js` output once).**
- [ ] **Step 4: Run `npm run eval` and `npm test`, expect PASS.**
- [ ] **Step 5: Commit** `test: add the eval suite with golden profiles and recommendation rules`

---

### Task 8: CI and release pipeline

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `SECURITY.md`, `CONTRIBUTING.md`, `test/release-policy.test.js`
- Modify: `README.md` (release and contributor sections), `CHANGELOG.md`

**Interfaces:**
- `ci.yml`: on push and pull request, a Node matrix (20 and 22) running `npm test`, `npm run eval`, and a package-policy job (`npm pack --dry-run --json` listing, verified by `test/release-policy.test.js` logic too). Pinned action versions by full commit SHA with a comment naming the version (written from memory: **mark as unverified in the PR/notes and require a maintainer to refresh the SHAs**; do not invent SHAs: use tag references with a TODO-free comment `# pin to a commit SHA before the first release` ONLY if no SHA can be known, and make `test/release-policy.test.js` report unpinned actions as a warning-level assertion that the release workflow, which is the sensitive one, must pass).
- `release.yml`: manual `workflow_dispatch` plus tag `v*`; permissions `contents: read` and `id-token: write`; steps: checkout, setup-node with `registry-url`, `npm ci`-free (no dependencies: `npm test`), verify the tag equals `package.json` version, `npm publish --provenance --access public` using `NODE_AUTH_TOKEN` from a repository secret, and a job environment named `release` (protected, 2FA-enforced publishing is configured on npm and documented in `CONTRIBUTING.md`). No other secrets, no third-party actions beyond `actions/checkout` and `actions/setup-node`.
- `test/release-policy.test.js` (runs in `npm test`): `package.json` has `files` equal to `['bin','skill']`, no `scripts` named `preinstall|install|postinstall|prepare|prepublishOnly` (spec 5.13 A), no dependencies, `engines.node` `>=20`, `repository` set; the workflows exist; `release.yml` contains `--provenance`, `id-token: write`, no `pull_request` trigger, only the two allowed actions; `npm pack --dry-run --json` (offline) lists only `bin/**`, `skill/**`, `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and no test, dev, eval, `.ai`, `.superpowers` or fixture files and no file over 1 MB; the packed size is under a stated budget (record the current size and allow 25% growth); the CHANGELOG has an entry for the package version.
- `SECURITY.md`: how to report a vulnerability (GitHub private advisory), supported versions, the tool's threat model in brief (reads untrusted repositories, never sends data anywhere, writes only under `.ai/`), and a statement that the repository has no telemetry.
- `CONTRIBUTING.md`: how to add a dimension entry, a playbook (format and the safe-ordering rule), a catalog data change (bump rules, unverified-data marking), run the eval suite, and cut a release (tag, the protected `release` environment, `npm view` name check before the first publish).

- [ ] **Step 1: Write failing tests (`release-policy.test.js`).**
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Write the files.**
- [ ] **Step 4: Run `npm test`, expect PASS.**
- [ ] **Step 5: Commit** `ci: add CI, release workflow with provenance and project policy docs`

---

### Task 9: M4 follow-ups worth doing now

Source: `docs/superpowers/m4-followups.md`. Remove each fixed line from that file.

**Files:** `skill/scripts/lib/integrity.js`, `skill/scripts/lib/aidir.js` (vendoring), `skill/scripts/playbook.js`, `test/manifest-cli.test.js`, tests in the matching files, `docs/superpowers/m4-followups.md`.

Items:
1. Stop vendoring `catalog/playbooks/` into `.ai/tools/catalog` (about 190 KB per project in committed mode): vendored workflow scripts do not use playbooks. Keep `catalog/versions.json` and `scoring.json` only if a vendored script reads them (check; vendor nothing else). `expectedToolHashes`/`verifyTools` follow the same list. The installed `playbook.js` keeps reading the installed catalog. Tests: vendored folder has no playbooks; hashes still verify; `playbook.js` still works from the installed skill; a 0.4.0 `.ai/` with vendored playbooks verifies as `modified`/`unverifiable` with a clear reason until `refresh`, and `refresh` removes the stale folder.
2. Pin the exemptions in `test/manifest-cli.test.js` to concrete expected exit codes instead of no-op comments.
3. `fitness.js` with a corrupt manifest: decide and test (it must not write `.ai/fitness` when the manifest is unreadable and the project might be a workspace member).
4. Redundant manifest error text ("cannot read ...: invalid manifest ...") and duplicated newer-schema advice become one clear message.

- [ ] **Step 1: Write failing tests for items 1 to 4.**
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`, expect PASS.**
- [ ] **Step 5: Commit** `fix: slimmer vendored tools, pinned manifest exit codes, clearer manifest errors`

---

### Task 10: Documentation and release notes for M5

**Files:** `README.md`, `CHANGELOG.md`, `skill/SKILL.md`, `skill/references/output-templates.md`, `package.json` (version `0.5.0`), `test/skill-docs.test.js`.

Content decisions:
- SKILL: the "Not yet available" section is removed (nothing remains unavailable); `run` is documented as a terminal command the agent explains but does not start (Task 5 text is the base). `setup` step list mentions `migration-plan.js --write` after the user agrees and that `.ai/run.config.json` exists.
- README: roadmap section becomes "Status" (v1 feature-complete candidate; what is still unverified: playbooks, versions, compliance dates, CVE data, default agent flags, GitHub Action pins); install/update examples use `0.5.0`; the release process is linked to `CONTRIBUTING.md`; the eval suite is mentioned; "No telemetry" stays accurate (the runner spawns only the user's own agent CLI, git and the user's configured verification commands).
- CHANGELOG `[0.5.0]`: Tool entries for Tasks 1 to 9, noting the unverified data (agent flag defaults).
- Docs tests derive facts from code: every `run` flag documented exists in `run.js`, the exit-code table matches `run.js`, `package.json` version `0.5.0`, CHANGELOG has `[0.5.0]` and `unverified`.

- [ ] **Step 1: Write failing doc tests.**
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Edit the docs.**
- [ ] **Step 4: Run `npm test`, expect PASS.**
- [ ] **Step 5: Commit** `docs: document the run loop, eval suite and release process for 0.5.0`
