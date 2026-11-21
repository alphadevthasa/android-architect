# Changelog

## [0.5.0] - Unreleased

### CI and release

- `.github/workflows/ci.yml` (push to `main` and pull requests, read-only token, no secrets, Node 20 and 22 on Linux plus macOS, `npm test`, which includes the eval suite and the package policy) and `.github/workflows/release.yml` (version tags and manual dispatch from a tag only; a read-only `verify` job, then a `publish` job in the protected `release` environment with `id-token: write` only there; tag, `package.json` version and `origin/main` ancestry checked in both; `npm publish --provenance --ignore-scripts`). `.github/CODEOWNERS` covers the policy-bearing paths. `SECURITY.md` and `CONTRIBUTING.md` added; `test/release-policy.test.js` enforces the package contents, a size budget and the workflow policy (with negative tests). **The GitHub Action references are tags, not commit SHAs, and are unverified: replacing them with verified SHAs is a release blocker listed in CONTRIBUTING.md.**

### Run loop

- `android-architect run` (`skill/scripts/run.js`, delegated from `bin/cli.js`): the opt-in autonomous run loop. Flags `--root`, `--json`, `--dry-run`, `--approve-build-changes <hash>` (repeatable, argv only) and `--help`; budgets, agent and verification come from `.ai/run.config.json` only. No `--yes`: the first-use confirmation needs an explicit `yes` at an interactive terminal (it lists the agent command, unverified-default warning, verification commands, passEnv names, budgets, branch prefix and the no-push statement), and a non-interactive stdin never confirms. Stable exit codes: 0 done, 2 refused or usage, 3 needs-human, 4 stopped or interrupted, 5 tampered, 6 budget or no-progress or repeated-error or verification-failed, 7 failed. Default agent command lines are unverified. The confirmation text shows the full agent command and every verification command, one argument per line (nothing truncated; `agent.command` and verification commands are capped at 40 arguments of 300 characters, at most 10 verification commands, and a config that cannot be shown in full is refused). `agent.env` is limited to behavior variables and its values are shown in the confirmation. The run loop is no longer vendored into `.ai/tools` (a vendored `run.js` refuses to run): use `npx android-architect run` or the installed skill. The migration playbooks and the schema doc are no longer vendored into `.ai/tools` either (about 190 KB per project): a vendored `playbook.js` or `migration-plan.js` now exits 1 with a "run it from the installed skill" message; `refresh` removes a stale vendored `catalog/playbooks`.

## [0.4.0] - Unreleased

### Tool

- `scripts/features.js` and the feature map: ranks migration candidates (feature modules, else feature packages, else top-level packages, else one `app` unit) with a score, a risk and a bucket (`first`, `next`, `last`) from size, coupling, tests, churn (distinct commits, bulk commits ignored; dropped and renormalised without git history) and risk keywords in `catalog/scoring.json`. A high-risk or large feature is never a pilot. `init` and `refresh` generate `.ai/knowledge/feature-map.md`. Feature names from untrusted directory names are sanitized. Reference: `references/feature-prioritization.md`.
- `scripts/reuse.js` and a region-managed `components.md`: reusable and duplicated component detection. `components.md` gets a generated block between `android-architect:components` markers (appended to existing files, user text never touched, non-UTF-8 files are skipped with a note). Reference: `references/reuse.md`.
- Playbooks: a playbook format and loader validated against the catalog, and `scripts/playbook.js list|show|apply`. `apply` reports `applicable: false` when the source is not detected, `worth` notes, the real cutover files (capped at 200, build files listed separately, profile count as cross-check) and the `irreversible` and `decision` tags. 18 playbooks cover the data layer (SQLite, GreenDAO, ORMLite, Realm to Room, Room to SQLDelight, SharedPreferences and EncryptedSharedPreferences to DataStore, OkHttp/Retrofit to Ktor, Gson to Moshi or kotlinx.serialization), async, DI (Dagger 2 or Koin to Hilt), UI (XML to Compose) and navigation. Irreversible playbooks share one safe ordering: backup first, a single writer, copies behind a write gate, no deletion of the old store before verification. **All playbooks are `verified: false`: written from memory, unverified until a maintainer audits them.**
- `scripts/lib-update.js`: security-first library update planning. Security fixes come first (highest severity first), then patch and minor updates per update group, then major updates with their `requires` listed as prerequisites. Dynamic, unresolved, BOM-managed and unknown dependencies are listed as "cannot update automatically" and never get a guessed target. `--scope <module>`, `--format json|md`, `--out`. Reference: `references/library-updates.md`.
- `scripts/fitness.js`: architecture fitness checks from the new optional `fitness` key of accepted ADRs (`module-no-dep` and `package-no-import` rules, tiny linear glob grammar, strict validation with `<adr file>: rule "<n>"` errors). `--check` evaluates the rules statically; the default writes a Gradle `architectureFitness` task, a Konsist test, `verify-commands.json` and a README into `.ai/fitness/` for the user to review and copy (generated files, rewritten by `fitness.js`, left alone by `init` and `refresh`; the Gradle script needs Gradle 8.11 or newer). Reference: `references/fitness.md`.

- Compliance and build-performance advice: `profile.compliance` gains dated policy items (16 KB page size, edge-to-edge, predictive back, foreground service types, notification and media permissions, exact alarms) driven by `appliesWhen` signals, with the new status `check` (the policy applies, cannot be verified statically; shown under "Compliance needs manual check" together with `unknown`, while "Compliance gaps" lists `gap` only). A policy effective after the catalog `asOf` is `upcoming` and never a `gap`. `profile.buildPerformance.items` (additive, schema stays 1) covers `gradle.properties` switches, kapt versus its catalog alternative and the Kotlin version; a missing `gradle.properties` is `unknown`. The Markdown report and `architecture-current.md` show both (section "Build performance checks").
- Compliance statuses are evidence based: `ok` only with positive evidence, `check` when the manifests may be partial, `gap` only when the evidence is in the scanned manifest itself.
- `scripts/migration-plan.js`: validates the recommendations like `recommend-check.js`, then prints a deterministic staged plan (tracks `enabling`, `feature` and `data`) with a safety-net step for every expanded feature, playbook-backed data steps, `decision` and `irreversible` tags, verification and rollback. It never writes into the project; the agent saves `.ai/migration/roadmap.md` only after the user agrees.
- Shared safe `--out` helper (`lib/outpath.js`) for `scan.js`, `features.js`, `lib-update.js` and `migration-plan.js`: refuses paths inside the project, symlinks, existing non-regular files and hard links. `index.js build --out` may still point inside the project by design.
- Skill: new commands `prioritize`, `migration-plan`, `data-migration`, `lib-update`, `fitness` and `review` (read-only `git diff` against accepted ADRs, the accepted target, rubrics, components and `fitness.js --check`); "Not yet available" lists only `run`. Workflows 02, 03 and 04 cover the components registry, the feature map and roadmap order, `./gradlew architectureFitness` and fitness results. README gains "Planning a migration" and the playbook list.
- Package version is 0.4.0.

### Catalog

- Catalog 2026.11.3 compliance: new entries `post-notifications`, `media-permissions` and `exact-alarm`; `page-size-16kb`, `edge-to-edge`, `predictive-back` and `fgs-types` gain `appliesWhen`. The compliance dimension file gains the dimension-level keys `asOf` (2026-11-20), `verified: false` and `dataNote`; `language.kotlin-k2` gains `minVersion` 2.0 (the Kotlin check in build performance and the K2 detection read it, `unknown` when absent). New optional entry fields `appliesWhen` (known signals only: `targetSdkMin`, `hasNative`, `usesForegroundService`, `usesExactAlarm`, `usesNotifications`, `usesMediaStorage`) and `source` (https link on developer.android.com or source.android.com); `policy.effective` stays inside `policy`; `policy.kind` is now one of `targetSdkMin`, `targetSdkEnforced`, `pageSizeBytes`. **All policy values, effective dates and source links were written from memory and are unverified (`verified: false`): maintainers must audit them before release.**
- Catalog 2026.11.3: `room` gains the successor `sqldelight` (the Room to SQLDelight playbook needs the edge) and `sqldelight` gains the prerequisite `language` anyOf `kmp`, so non-KMP projects see it as blocked rather than as a next step. Written from memory, unverified.
- Catalog 2026.11.3: the `koin` entry gains a `notes` field saying the move to Hilt is lateral and staying on Koin is the default. Written from memory, unverified.
- `catalog/versions.json` (new data file, within catalog 2026.11.3): stable versions, update groups and `requires` for 35 widely used libraries, `asOf` 2026-11-20. **Written from memory and unverified (`"verified": false`): maintainers must audit every version before release.** No entry claims to be the latest release; targets are only suggestions and the plan marks them `verify` once the data is older than 90 days.

## [0.3.0] - Unreleased

### Tool

- Secret redaction: secrets are replaced with `[REDACTED:<kind>]` (`private-key`, `aws-access-key`, `google-api-key`, `github-token`, `slack-token`, `jwt`, `signing-password`, `credential`) in everything written to `.ai/`, including the index and Markdown or Gradle sources. Key names match on word and camelCase boundaries; unquoted `KEY=value` lines are covered; unterminated private-key blocks are redacted to the end of the text.
- Extra secret files are never read (`signing.properties`, `secrets.properties`, `*.pem`, `*.key`, `credentials.json`, `service-account*.json`, on top of the existing list).
- Git-ignored files are skipped by scan, index and knowledge generation through one `git check-ignore --stdin` call. Inside a git repository a git error stops the run (fail closed); a directory that is not a repository is unaffected.
- Tools verification: `ai-status.js` and `doctor --root <dir>` compare `.ai/tools` with the installed skill (`tools-modified`, `tools-unverifiable` with a reason, `tools: { status, changed, added, removed, trusted }`). Vendored copies self-check against the manifest and exit 3 unless `--trust-modified-tools`. `refresh` repairs tools and notes what was modified.
- Suspicious instruction-like text in `.ai/` is reported as `suspicious: [{ file, line, rule }]` by `ai-status.js` and as refresh notes (knowledge, migration, workflows, `recommendations.json`, `repos.json`, `catalog-overrides/*.json`).
- Security signals in the profile (`security.findings`) and a security rubric (`references/rubric-security.md`) used by `audit`.
- Vulnerable dependency detection from catalog `vulnerableVersions`: `security.vulnerable`, with dynamic or unresolvable versions listed in `unresolvedChecks` and unknown alias dependencies in `unresolvedAliases`; pre-release versions sort below the release; the root build file is scanned.
- Catalog overrides in `.ai/catalog-overrides/*.json`: add entries and pin statuses. Content signals are literal-only (`contains`, no regular expressions), globs use a small grammar, signals are capped at 20 per list, and override strings reject control characters. Active pins and added entries show in `architecture-current.md` and the refresh report, with a diff against the previous run. `scan.js` and `candidates.js` accept `--no-overrides`; `recommend-check.js` takes `--root <dir>` (required when overrides exist) and accepts a `<base>+overrides` catalog version.
- Skill, workflows and README updated: Security section in `audit`, stop on modified tools, never pass `--trust-modified-tools`, suspicious text handling.

### Catalog

- Catalog 2026.11.2: new optional entry field `vulnerableVersions` (coord, range, id, severity, summary, source). First advisory: Gson `<2.8.9`, CVE-2022-25647 (high), deserialization of untrusted data can cause a denial of service.

## [0.2.0] - Unreleased

### Tool

- `android-architect init`: creates `.ai/` (generated profile and module map, local BM25 search index, candidates snapshot, workflows, starter knowledge files) in committed or `--local` mode, with `AGENTS.md`/`CLAUDE.md` pointers added only with `--append-pointers`. Vendored scripts in `.ai/tools/` with recorded hashes, reported by `ai-status.js`.
- Workspace mode: `init --workspace` links a hub and member repos, with `repos.json` and cross-repo artifact links. Orchestration moved into `skill/scripts/lib/init.js`, shared by `init-ai.js` and the CLI.
- ADR-based rejections: rejected recommendations are remembered and enforced by guardrail R7 until a `reopenIf` condition holds.
- `android-architect refresh`: regenerates `.ai/`, keeps user-owned files, and reports catalog, candidate, recommendation and rejection changes (`.ai/refresh-report.md`).
- `android-architect update`: reinstalls the skill only into harnesses that already have it and reports version and catalog changes.
- CLI rejects unknown flags with a usage error.

### Catalog

- Catalog 2026.11.1: new computed `modularization` entry `app-plus-libraries` ("App + library modules": one application module plus `com.android.library`, `java-library` or Kotlin JVM library modules, no feature-module naming). `single-module` now lists it as a successor, and it leads to `layer-modules` and `feature-modules`. Import prefixes now match on a segment boundary, so `androidx.lifecycle.ViewModelProvider` no longer counts as `mvvm-viewmodel`.

## [0.1.0] - Unreleased

## Tool

- `android-architect install|uninstall|doctor|version` CLI with `--claude`, `--codex`, `--home`, `--force`, and `--json` for `doctor`. Installs from a staged copy and removes only directories it installed.
- Offline, read-only scripts: `scan.js` (stack profile), `candidates.js` (catalog-legal targets), `recommend-check.js` (guardrail validation R1-R6).
- Skill with `audit` and `recommend` commands, persona, method, rubrics and output templates.
- Detection for Java/Kotlin, Groovy/KTS, version catalogs, multi-module, XML/Compose/mixed UI. Kotlin Multiplatform projects are recognized by the Kotlin Multiplatform Gradle plugin.
- No dependencies, no install-time scripts, no network.

## Catalog

- Catalog 2026.11.0: 18 dimensions with entries, successor edges and prerequisites.
- Recommendation schema documented in `skill/catalog/recommendations.schema.md`.
