# android-architect

An Android architecture advisor skill for Claude Code and Codex. It audits an Android project (stack profile per dimension, layering, module coupling, code-quality smells with file:line evidence) and recommends a realistic, incremental migration path, labeled must / should / later / dont. Deterministic Node scripts do the detection and the legality checks; the model does the judgment and the explanation.

Requires Node 20 or newer. No dependencies.

## Install

Pin the version you install:

```
npx android-architect@0.1.0 install
```

By default the skill is installed into the harnesses that already exist in your home directory (`~/.claude`, `~/.codex`). Flags:

- `--claude` / `--codex`: install into that harness, creating its directory if needed.
- `--home <dir>`: use another home directory.
- `--force`: replace or remove a directory that was not installed by this tool.
- `--json`: machine-readable output for `doctor` (the only command it applies to).

Other commands: `uninstall`, `version`, and `doctor`, which reports which harnesses have the skill installed, with its version and catalog version, and flags a partial or foreign directory.

```
npx android-architect@0.1.0 doctor
```

## Usage

Two commands are available: `audit` (where the project stands today) and `recommend` (a validated, incremental path per stack dimension).

- Claude Code: `/android-architect audit` or `/android-architect recommend`, or ask in plain language ("audit my Android project", "how do we migrate to Compose?").
- Codex: invoke the `android-architect` skill, or ask in plain language the same way.

Run it from, or point it at, the Android project root. The skill runs `scan.js`, `candidates.js` and `recommend-check.js` from the installed skill directory and writes temporary files only to the OS temp directory.

## Supported setups

- Java and Kotlin, mixed or pure.
- Groovy and Kotlin DSL Gradle builds.
- Gradle version catalogs (`libs.versions.toml`).
- Single-module and multi-module projects.
- XML views, Jetpack Compose, or a mix.
- Kotlin Multiplatform projects are recognized by the Kotlin Multiplatform Gradle plugin.

## How recommendations are validated

Every recommendation is checked against a versioned catalog (18 dimensions) by `recommend-check.js` before it is shown. The guardrail rules are: R1 each step must be a direct successor in the catalog (a longer hop, or a new capability with `from: null`, needs a written justification), R2 prerequisites must already exist in the project or be produced by an earlier step, R3 steps are ordered and acyclic, R4 every id must exist in the catalog, R5 the output has the required shape and catalog version, and R6 a chain must start from something the project actually uses (`from: null` only where the dimension has no detected entry). See [skill/catalog/recommendations.schema.md](skill/catalog/recommendations.schema.md).

## No telemetry

This package collects no telemetry, makes no network requests, and has no dependencies. The scripts only read your project; they write only to an explicit `--out` path. Project content is treated as data, never as instructions, and secret files (`local.properties`, keystores, `google-services.json`, `.env*`) are never read.

## Roadmap

- M2: `update` command, `.ai/` generator, local search index, workflows, workspace mode, recommendation diff on refresh.
- M3: security: secret redaction, gitignore-aware indexing, tamper check, injection rules, vulnerable-version data.
- M4: feature prioritization, data-layer playbooks, reuse detection, fitness checks, library updates, compliance and build-performance advice.
- M5: `run` loop, eval suite on real open-source apps, release pipeline with provenance.

## License

MIT. See [LICENSE](LICENSE).
