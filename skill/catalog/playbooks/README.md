# Migration playbooks

A playbook describes how to move one dimension of an Android project from one catalog entry to another (for example `okhttp-retrofit` to `ktor-client`). `node scripts/playbook.js apply <from> <to> <root>` checks whether the source is present in a project, lists the files to cut over and the tags (`irreversible`, `decision`) that gate the step.

Playbooks are public documentation: write them generically, without employer or private project names. Facts written from memory stay `verified: false` until a maintainer confirms them.

## File

`<from>--to--<to>.md`, where `from` and `to` are catalog entry ids of the same dimension and `to` is reachable from `from` through catalog `successors`. Files starting with `_` and this README are not loaded. `_example-seam.md` shows the format.

## Front matter

Strict scalars only (the same restricted grammar as ADRs; no anchors, tags, block scalars, flow collections, single quotes or inline comments).

| Key | Value |
| --- | --- |
| `id` | `<from>--to--<to>` |
| `dimension` | catalog dimension id |
| `from`, `to` | catalog entry ids, different |
| `title` | short title |
| `irreversible` | `true` or `false` (bare words); true when on-device data moves |
| `kmpOnly` | `true` or `false` |
| `worthIf` | list of `present:<id>` or `absent:<id>`; may be empty (omit the items) |
| `asOf` | `YYYY-MM-DD` |
| `verified` | `false` until a maintainer confirms the facts |

## Body

`## ` headings, exactly these, in this order: `When it is worth it`, `When not to`, `Preconditions`, `Steps`, `Pitfalls`, `Tests`, `Security checklist`, `Rollback`. No section may be empty. `Steps` must mention the seam, running both implementations side by side, per-unit cutover and deleting the old implementation. `Security checklist` is a `- ` list with at least 2 items.

## Adding a pair

1. Make sure both entries exist in `catalog/dimensions/<dimension>.json` (add a minimal entry and bump `catalogVersion` if not).
2. Copy `_example-seam.md` to `<from>--to--<to>.md` and edit it.
3. Add a fixture test: `test/playbooks.test.js` must load the file, pass `validatePlaybooks`, and apply it to a fixture project that has the `from` entry (and to one that does not).
