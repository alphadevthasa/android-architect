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
of `gradle` (`{ "coord": "group:artifact" }`), `plugins`, `imports`, `files` (path globs, see below), `content` or `manifest`.
A `content` signal is `{ "contains": "<literal text>" }` (a case-sensitive substring, 1 to 200 characters, matched per
line in `.kt` and `.java` files); add `"glob"` (same grammar as `files`) to look in other files.

## Safety rules

Override files are untrusted text, so they are checked before anything is read or written. A file that breaks a rule makes
`init`, `refresh`, `scan` and `candidates` stop with an error that names the file.

- Strict JSON, `schemaVersion` 1. Strings are at most 500 characters.
- An entry id must not already exist in its dimension (status pins are the way to change an existing entry).
- `detect.computed` is not allowed.
- Regular expressions are not allowed: a `regex` key in an override entry is rejected. Use `contains` for text.
- Globs (`detect.files`, `detect.content[].glob`) use a small grammar: literal path segments, an optional single leading
  `**/`, at most one `*` per segment, at most 2 `*` in total (a `**` counts as one), no `?`, braces or classes, at most 200
  characters. `**/Network*.kt` and `app/src/main/AndroidManifest.xml` are fine; `*a*a*b` and `**/*Net*.kt` are not.
- `successors` and `prerequisites` may reference base or override entries only; successors must not form a cycle.

Active pins (with their reasons) and added entries are listed in `knowledge/architecture-current.md` and in the refresh
report, which also reports pins and entries added, removed or changed since the previous run (`overrides` in the JSON
report). They do not appear under the catalog status changes. Pass `--no-overrides` to `scan.js` or `candidates.js` to ignore this folder.

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
