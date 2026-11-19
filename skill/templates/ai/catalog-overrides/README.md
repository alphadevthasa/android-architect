# Catalog overrides

Project-specific additions to the android-architect catalog. Put one or more `*.json` files in this folder (at most 20
files, 50 entries each). This README is yours: init and refresh never overwrite it.

Use overrides for:

- internal libraries the shared catalog does not know, such as your company's AARs, so they are detected and take part in
  migration candidates;
- status pins, when your organization treats a catalog entry as `legacy` or `deprecated` (or `current`) regardless of the
  shared catalog.

Overrides can only add new entries to existing dimensions and pin the status of existing ones. They cannot replace or
remove catalog entries and cannot add dimensions. The base catalog vendored into `.ai/tools/catalog` is not changed.

## Shape

```json
{
  "schemaVersion": 1,
  "entries": [{ "dimension": "<dimension id>", "entry": { "...a full catalog entry..." } }],
  "status": [{ "dimension": "<dimension id>", "id": "<entry id>", "status": "current|legacy|deprecated", "reason": "why" }]
}
```

An entry has `id`, `name`, `era` (integer >= 1), `status`, `successors` (ids, may be empty) and `detect` with at least one
of `gradle` (`{ "coord": "group:artifact" }`), `plugins`, `imports`, `files`, `content` (`{ "glob", "regex" }`) or `manifest`.

## Safety rules

Override files are untrusted text, so they are checked before anything is read or written. A file that breaks a rule makes
`init`, `refresh`, `scan` and `candidates` stop with an error that names the file.

- Strict JSON, `schemaVersion` 1. Strings are at most 500 characters.
- An entry id must not already exist in its dimension (status pins are the way to change an existing entry).
- `detect.computed` is not allowed.
- Every `detect.content[].regex` is at most 200 characters, compiles without flags and has no nested quantifier such as
  `(a+)+`. Globs in `detect.files` and `detect.content[].glob` are at most 200 characters.
- `successors` and `prerequisites` may reference base or override entries only; successors must not form a cycle.

A status pin shows up as a status change in the refresh report the first time it is applied, because the previous
catalog (the vendored base) did not have it. Pass `--no-overrides` to `scan.js` or `candidates.js` to ignore this folder.

## Example

`company.json`, adding an internal networking library to the `networking` dimension:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "dimension": "networking",
      "entry": {
        "id": "internal-net",
        "name": "Company network-core",
        "era": 3,
        "status": "current",
        "successors": [],
        "detect": { "gradle": [{ "coord": "com.company:network-core" }] }
      }
    }
  ]
}
```
