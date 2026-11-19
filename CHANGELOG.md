# Changelog

## [0.2.0] - Unreleased

### Tool

- `android-architect init`: creates `.ai/` (generated profile and module map, local BM25 search index, candidates snapshot, workflows, starter knowledge files) in committed or `--local` mode, with `AGENTS.md`/`CLAUDE.md` pointers added only with `--append-pointers`. Vendored scripts in `.ai/tools/` with recorded hashes, reported by `ai-status.js`.
- Workspace mode: `init --workspace` links a hub and member repos, with `repos.json` and cross-repo artifact links. Orchestration moved into `skill/scripts/lib/init.js`, shared by `init-ai.js` and the CLI.
- ADR-based rejections: rejected recommendations are remembered and enforced by guardrail R7 until a `reopenIf` condition holds.
- `android-architect refresh`: regenerates `.ai/`, keeps user-owned files, and reports catalog, candidate, recommendation and rejection changes (`.ai/refresh-report.md`).
- `android-architect update`: reinstalls the skill only into harnesses that already have it and reports version and catalog changes.
- CLI rejects unknown flags with a usage error.

### Catalog

- No catalog changes.

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
