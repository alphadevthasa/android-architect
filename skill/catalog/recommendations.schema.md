# Recommendations format (schemaVersion 1)

The advisor writes a JSON file that `skill/scripts/recommend-check.js` validates against the catalog and the scanned profile.

```json
{
  "schemaVersion": 1,
  "catalogVersion": "<must equal meta.catalogVersion of the loaded catalog>",
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
- `dimensions[].label`: one of `must`, `should`, `later`, `dont`. `target` may be `null`.
- `steps[].from`: current entry id, or `null` for a new capability (then `to` must have status `current`).
- `steps[].tags` (optional): only `irreversible` or `decision`.

Rules enforced:
- R1-hop: `to` must be a direct successor of `from`. A transitive hop needs a `justification` of at least 20 characters. An unreachable `to` is always rejected.
- R2-prereq: every prerequisite of `to` must be present in the profile (share > 0, or a computed flag) or be produced (same dimension, `to` in `anyOf`) by a step reachable through `dependsOn`, transitively.
- R3-order: `dependsOn` ids must exist, point to earlier steps, and form no cycles.
- R4-unknown-id: dimension and entry ids must exist in the catalog.
- R5-shape: required fields present, valid label and tags, matching `catalogVersion`.

Use `node skill/scripts/candidates.js <projectRoot>` to list legal targets (`current`, `next`, `reachable`, `blockedBy`) before proposing steps.
