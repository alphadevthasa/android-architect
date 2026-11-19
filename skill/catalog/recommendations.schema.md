# Recommendations format (schemaVersion 1)

The advisor writes a JSON file that `skill/scripts/recommend-check.js` validates against the catalog and the scanned profile.

```json
{
  "schemaVersion": 1,
  "catalogVersion": "<meta.catalogVersion of the catalog, or <meta.catalogVersion>+overrides when the project has catalog overrides>",
  "generatedAt": "2026-11-19",
  "dimensions": [
    { "dimension": "presentation", "current": ["mvp"], "target": "mvvm-livedata",
      "label": "must", "rationale": "Why this target fits this project." }
  ],
  "steps": [
    { "id": "s1", "dimension": "language", "from": "java", "to": "java8-desugar",
      "dependsOn": [], "justification": "optional unless the hop skips entries", "tags": ["irreversible"] }
  ]
}
```

Fields:
- `dimensions[].label`: one of `must`, `should`, `later`, `dont`. `target` may be `null`. For `dont`, `target` is the current entry or `null`, never a new entry.
- `steps[].from`: the entry the step starts from, or `null` for a new capability.
- `from: null` only when the dimension has no detected entry in the profile and no step in `dependsOn` already targets that dimension; `to` must then have status `current`, and a `justification` of at least 20 characters is required.
- `steps[].tags` (optional): only `irreversible` or `decision`.

Rules enforced:
- R1-hop: `to` must be a direct successor of `from`. A transitive hop needs a `justification` of at least 20 characters. An unreachable `to` is always rejected. A `from: null` step needs a `to` with status `current` and a `justification` of at least 20 characters.
- R2-prereq: every prerequisite of `to` must be present in the profile (share > 0, or a computed flag) or be produced (same dimension, `to` in `anyOf`) by a step reachable through `dependsOn`, transitively.
- R3-order: `dependsOn` ids must exist, point to earlier steps, and form no cycles.
- R4-unknown-id: dimension and entry ids must exist in the catalog.
- R6-anchor: `from` must be present in the profile or be the `to` of a step reachable through `dependsOn` (same dimension), so chains cannot start from an entry the project does not use. A `from: null` step is rejected when the dimension already has a detected entry in the profile, or when a step in `dependsOn` already targets that dimension (chain from that step instead). Every `dimensions[].current` id must be present in the profile. A `target` (for labels `must`/`should`) must be present or be the `to` of some step in that dimension; `later`/`dont` need no step.
- R7-rejected: a `dimensions[]` row with label `must` or `should` whose `target` is blocked, or a step whose `to` is blocked in that dimension, is rejected. A target is blocked by an ADR with `status: rejected` (matching `dimension` and `target`) unless one of its `reopenIf` conditions holds. Pass ADRs with `recommend-check.js --adr-dir <dir>`; the file `0000-template.md` is ignored.
- R5-shape: required fields present, valid label and tags, matching `catalogVersion`.

Use `node skill/scripts/candidates.js <projectRoot>` to list legal targets (`current`, `next`, `reachable`, `blockedBy`) before proposing steps.

## ADR front matter

ADR files (`.ai/knowledge/adr/*.md`) start with a front matter block between two `---` lines. Only `key: value` lines and `key:` followed by `- item` lines are supported (no anchors, tags, block scalars or flow collections). Values may be bare or in double quotes.

```
---
id: "0001"
title: Keep OkHttp and Retrofit
status: rejected
date: 2026-11-19
dimension: networking
target: ktor-client
reopenIf:
  - present:kmp
reason: "Why it was rejected."
---
```

- `status` is one of `proposed`, `accepted`, `superseded`, `rejected`.
- `dimension` and `target` are required (non-blank) when `status` is `rejected`.
- No inline comments; values are bare or double-quoted; single quotes are rejected.

`reopenIf` conditions use `present:<entryId>` or `absent:<entryId>`, checked across all profile dimensions (an entry is present when `units > 0`, `share > 0`, or `share` is null). Any other text is a human note and never reopens the ADR.

## Catalog field: `vulnerableVersions`

An entry may list known-vulnerable dependency versions. Every field is required:

```json
"vulnerableVersions": [
  { "coord": "com.google.code.gson:gson", "range": "<2.8.9", "id": "CVE-2022-25647",
    "severity": "high", "summary": "One-line description.", "source": "https://nvd.nist.gov/vuln/detail/CVE-2022-25647" }
]
```

- `coord` is `group:name` and must equal one of the entry's `detect.gradle` coords (or fall under a prefix coord ending in `:`).
- `severity` is `critical`, `high`, `medium` or `low`; `source` must start with `https://`.
- `range` is one or more comparators (`<X`, `<=X`, `>X`, `>=X`, `=X`, X numeric dotted) separated by spaces (AND); `||` separates OR groups. Segments compare numerically. Pre-release qualifiers (`alpha`, `beta`, `rc`, `cr`, `mN`, `milestone`, `snapshot`, `dev`, `preview`, `ea`; separator `-`, `.` or none, case-insensitive) sort strictly below the same release, so `2.8.9-rc1` matches `<2.8.9`; other qualifiers (`-android`, `-jre`, `.Final`) equal the release. Anything else is rejected.
- `scan.js` reports matches in `profile.security.vulnerable`; dependencies whose version cannot be resolved are listed in `profile.security.unresolvedChecks` instead of being treated as safe.
- One finding row per build file per dependency (modules and the root build file, including `buildscript` classpath).
- Dynamic or unusable versions (`latest.release`, `2.+`, `[2.8,3.0)`, leftover `$`) go to `unresolvedChecks`; alias/bundle dependencies whose coordinates cannot be resolved go to `profile.security.unresolvedAliases` (`{ alias, file, line }`).
