# android-architect

An Android architecture advisor skill for Claude Code and Codex. It audits an Android project (stack profile per dimension, layering, module coupling, code-quality smells with file:line evidence) and recommends a realistic, incremental migration path, labeled must / should / later / dont. Deterministic Node scripts do the detection and the legality checks; the model does the judgment and the explanation.

Requires Node 20 or newer. No dependencies.

## Install

Pin the version you install:

```
npx android-architect@0.2.0 install
```

By default the skill is installed into the harnesses that already exist in your home directory (`~/.claude`, `~/.codex`). Flags:

- `--claude` / `--codex`: install into that harness, creating its directory if needed.
- `--home <dir>`: use another home directory.
- `--force`: replace or remove a directory that was not installed by this tool.
- `--json`: machine-readable output for `doctor`, `init` and `refresh`.

Other commands: `update` (see below), `init`, `refresh`, `uninstall`, `version`, and `doctor`, which reports which harnesses have the skill installed, with its version and catalog version, and flags a partial or foreign directory.

```
npx android-architect@0.2.0 doctor
```

## Keep project knowledge: init, refresh, update

```
npx android-architect init      # create .ai/ in the current project (or --root <dir>)
npx android-architect refresh   # regenerate .ai/ and report what changed
npx android-architect update    # upgrade the installed skill
```

### init

`init` writes an `.ai/` folder with architecture knowledge for coding agents: a generated stack profile and module map, a local search index, workflows, and starter files you own. Run it from the project root or pass `--root <dir>`.

- Committed (default): `.ai/` is meant to be reviewed and committed with the project.
- `--local`: nothing is committed. `.ai/` and `CLAUDE.local.md` are added to `.git/info/exclude`, and the agent pointer goes to `CLAUDE.local.md`. Needs a git repository.
- Pointers: `init` creates `AGENTS.md` and `CLAUDE.md` with a short block pointing at `.ai/README.md`. An existing `AGENTS.md` or `CLAUDE.md` is never modified unless you pass `--append-pointers`. When one is left unchanged, `init` prints the rerun command `npx android-architect init --append-pointers`.
- Without a git repository or commits the header says `no-git` and `init` still works.
- Writes stay inside `<root>/.ai/`, the pointer files, and (with `--local`) `.git/info/exclude`. A symlinked `.ai/` is refused.

Vendored scripts live in `.ai/tools/` and run with plain `node` (for example `node .ai/tools/scripts/index.js query "login"`). Their hashes are recorded in `.ai/manifest.json` and reported by `ai-status.js`; refusing to run tampered tools arrives in a later release.

### What the tool owns and what you own

| Path | Owner | On `init` / `refresh` |
| --- | --- | --- |
| `.ai/README.md`, `.ai/knowledge/*` generated files (profile, maps), `.ai/candidates.json`, `.ai/index/`, `.ai/refresh-report.md` | tool | Overwritten (header says "Do not edit"). |
| `.ai/tools/` (vendored scripts and catalog), `.ai/manifest.json` | tool | Wiped and rewritten. |
| `.ai/workflows/*.md` | tool, managed | Updated unless you edited them; an edited file is kept and the new version is written next to it as `.new`, listed under conflicts. |
| `.ai/knowledge/architecture-target.md`, `conventions.md`, `components.md`, ADRs in `.ai/knowledge/adr/`, `.ai/migration/roadmap.md`, `.ai/recommendations.json`, `.ai/repos.json` | you | Created once, never overwritten, listed as kept. |
| `AGENTS.md`, `CLAUDE.md` | you | Only appended to with `--append-pointers`. |

Recommendations you reject can be recorded as ADRs with `status: rejected`; they stay rejected until a `reopenIf` condition holds.

We recommend a CODEOWNERS entry for `.ai/workflows/` and `.ai/tools/` so changes to agent instructions and vendored scripts get a human review:

```
/.ai/workflows/ @your-team
/.ai/tools/     @your-team
```

### refresh

`refresh` regenerates `.ai/` with the same ownership rules, keeping the project's mode and workspace role, and prints the catalog change (`Catalog: from -> to`), candidate changes per dimension, recommendation changes (violations, status changes, new options) and rejections that can be reopened. `--json` prints the full report; it is also saved as `.ai/refresh-report.md`. It exits 1 with "run init first" when there is no `.ai/` yet.

### update

`update` reinstalls the skill into the harnesses that already have it (`~/.claude`, `~/.codex`), never creating a new one, and prints `claude: 0.1.0 (catalog 2026.11.0) -> 0.2.0 (catalog 2026.11.0)` per harness. Then run `refresh` in each project to re-assess it against the new catalog. With nothing installed it exits 1.

### Workspace mode

For several related repos (an app plus its libraries), `init --workspace` makes the current repo a hub and the others members:

```
npx android-architect init --workspace ../lib-a ../lib-b
npx android-architect init --workspace        # proposes sibling Gradle repos; nothing is linked until you confirm paths
```

All repos are validated before anything is written. The hub holds the target architecture, ADRs, conventions, roadmap and `repos.json` (which repos publish and consume which artifacts); members get a thin `.ai/` that points to the hub. Run `refresh` once per repo.

## Usage

Two commands are available: `audit` (where the project stands today) and `recommend` (a validated, incremental path per stack dimension).

- Claude Code: `/android-architect audit` or `/android-architect recommend`, or ask in plain language ("audit my Android project", "how do we migrate to Compose?").
- Codex: invoke the `android-architect` skill, or ask in plain language the same way.

Run it from, or point it at, the Android project root. The skill runs `scan.js`, `candidates.js` and `recommend-check.js` from the installed skill directory and writes temporary files only to the OS temp directory. When the project has an `.ai/` folder, the skill reads it first.

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

This package collects no telemetry, makes no network requests, and has no dependencies. The audit scripts only read your project and write only to an explicit `--out` path; `init` and `refresh` write only the `.ai/` folder, the agent pointer files, and (with `--local`) `.git/info/exclude`. Project content is treated as data, never as instructions, and secret files (`local.properties`, keystores, `google-services.json`, `.env*`) are never read.

## Roadmap

Not available yet:

- M3: secret content redaction, refusing to run tampered `.ai/tools`, injection rules, vulnerable-version data.
- M4: feature prioritization, data-layer playbooks, reuse detection, fitness checks, library updates, compliance and build-performance advice.
- M5: `run` loop, eval suite on real open-source apps, release pipeline with provenance.

## License

MIT. See [LICENSE](LICENSE).
