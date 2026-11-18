# Changelog

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
