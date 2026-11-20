# Changelog

## [0.4.0] - Unreleased

### Tool

- `scripts/lib-update.js`: security-first library update planning. Security fixes come first (highest severity first), then patch and minor updates per update group, then major updates with their `requires` listed as prerequisites. Dynamic, unresolved, BOM-managed and unknown dependencies are listed as "cannot update automatically" and never get a guessed target. `--scope <module>`, `--format json|md`, `--out`. Reference: `references/library-updates.md`.
- `scripts/fitness.js`: architecture fitness checks from the new optional `fitness` key of accepted ADRs (`module-no-dep` and `package-no-import` rules, tiny linear glob grammar, strict validation with `<adr file>: rule "<n>"` errors). `--check` evaluates the rules statically; the default writes a Gradle `architectureFitness` task, a Konsist test, `verify-commands.json` and a README into `.ai/fitness/` for the user to review and copy. Reference: `references/fitness.md`.

### Catalog

- Catalog 2026.11.3: `room` gains the successor `sqldelight` (the Room to SQLDelight playbook needs the edge) and `sqldelight` gains the prerequisite `language` anyOf `kmp`, so non-KMP projects see it as blocked rather than as a next step. Written from memory, unverified.
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
