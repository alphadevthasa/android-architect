# android-architect M4 (Migration planning, playbooks, reuse, fitness, lib-update) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the advisor's per-dimension targets into an executable partial-migration plan. Concretely:
- Features ranked into "migrate first / next wave / leave as is".
- Data-layer migration playbooks, applied to the project.
- Reusable-component detection with a registry.
- Architecture fitness checks generated from accepted ADRs.
- Grouped, security-first library update plans.
- Compliance and build-performance advice.
- A `migration-plan` generator that ties these together.

**Architecture:** New single-purpose libraries in `skill/scripts/lib/` (`features.js`, `reuse.js`, `playbooks.js`, `libupdate.js`, `fitness.js`, `migplan.js`) with thin entry scripts that print JSON. Versioned data (scoring weights, playbooks, library versions) lives in `skill/catalog/` and ships with the package. Scripts stay deterministic and read-only. The model writes the prose, picks among catalog-legal options, and writes `.ai/` files only after the user agrees.

**Tech Stack:** Node >= 20 ESM, `node:test`, `node:assert/strict`, `git` via `execFileSync` only. No dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-android-architect-design.md` §5.5, §5.6, §5.11, §5.14, §5.15 (tags), §5.16, §7. Backlog: `docs/superpowers/m3-followups.md`.

**Out of scope (M5):** the `run` loop, the eval suite on real open-source apps, publishing. detekt rule generation from ADRs (spec 5.16 says "where they fit"; M4 generates Gradle module rules and Konsist tests only, and says so in the docs).

## Global Constraints

- All docs, prompts, templates, playbooks and code comments are in English. Playbooks and references are public documentation, written generically (no employer or private project names).
- Node `>=20`, `"type": "module"`, **no dependencies, no devDependencies**, no install scripts. `npm test` keeps running under `test/helpers/no-network.mjs`.
- Scripts make **no network requests**. No `eval`, `new Function`, or dynamic `import()` of computed paths. `git` only via `execFileSync('git', [fixed args], { cwd, env: LC_ALL=C })` (use the shared helpers in `lib/git.js`), never a shell.
- Scripts only read the project. They write only to stdout or an explicit `--out` path outside the project, except through the existing guarded writer in `lib/aidir.js` for generated `.ai/` files.
- Everything printed or written passes through `redact()` from `lib/redact.js`. Never print secret values.
- Project content (code, ADRs, overrides, `.ai/` text) is untrusted. Rule strings read from ADRs or overrides are matched with the tiny glob grammar from `lib/overrides.js` (no regexes), and any value emitted into generated code is validated against `^[A-Za-z0-9_.:\-/*]+$` and string-escaped. Hostile values are rejected, never emitted.
- Catalog data changes bump `catalogVersion` (this plan: `2026.11.3`) and add a `## Catalog` entry to `CHANGELOG.md`. Package version becomes `0.4.0`.
- `profile.schemaVersion` stays `1`; new profile fields are additive.
- Commit messages: conventional commits, **no `Co-Authored-By` or `Claude-Session` trailers** (user rule).
- Data written from memory (library versions, playbook facts) is marked unverified in the CHANGELOG and in the data file's `asOf` field, so a maintainer can audit it. Never present a version number as verified.

## Review Focus

1. A project without git history (not a repo, shallow clone, no commits). Expected: churn is `null`, features are still ranked, nothing throws. Pinned in Task 1.
2. A project with no feature structure (single module, God Activity, flat packages). Expected: a sensible fallback unit list (top-level packages, else one `app` unit), never an empty plan. Pinned in Task 1.
3. A playbook whose `from` entry is not detected in the project. Expected: `applicable: false` with the reason, and no invented cutover units. Pinned in Task 3.
4. Dependencies with unresolved or dynamic versions in `lib-update`, and a catalog older than 90 days. Expected: unresolved ones listed as "cannot update automatically", never a guessed target; stale data marked `verify`. Pinned in Task 6.
5. Hostile ADR rule text for `fitness` (quotes, `$`, newlines, catastrophic glob, shell/Kotlin injection through a module path). Expected: rejected with a rule-prefixed error before anything is generated. Pinned in Task 7.

---

### Task 1: Feature map and prioritization (`features.js`)

**Files:**
- Create: `skill/scripts/lib/features.js`, `skill/scripts/features.js`, `skill/catalog/scoring.json`
- Modify: `skill/scripts/lib/knowledge.js` (replace the `feature-map.md` stub), `skill/scripts/lib/aidir.js` (pass features into `renderKnowledge`), `skill/scripts/lib/git.js` (add `churnByPath`)
- Test: `test/features.test.js`, new fixtures `test/fixtures/feature-app/` (multi-module Compose + XML mix with `:feature:login`, `:feature:payment`, `:feature:profile`, `:feature:legacy-reports` plus `:core:data`; some with tests), and use the existing `legacy-java-mvp` fixture for the fallback case

**Interfaces:**
- Consumes: `discoverModules`, `listFiles(root, { gitignore: true })`, `detectStack` profile, `reuse` is not used here.
- Produces:
  - `scoring.json`: `{ schemaVersion: 1, asOf, weights: { isolation, size, tests, churn, risk, proximity }, riskKeywords: { high: string[], medium: string[] }, buckets: { first: number, next: number }, sizeBands: { smallLoc, mediumLoc, largeLoc } }`. Designer call (spec 6 leaves weights to the builder): weights sum to 1, `risk` is a penalty, `churn` favors higher churn (faster payoff), and buckets are score thresholds. All values live in this file, so they can be tuned without code changes.
  - `churnByPath(root, { sinceMonths = 6 } = {}) -> Record<relPath, number> | null`, in `git.js`. One `git log --since=<N>.months --name-only --pretty=format:` call, with counts per path. It returns `null` when git is missing, the dir is not a repo, there are no commits, or the clone is shallow with fewer than 2 commits. It never throws for those cases.
  - `buildFeatureMap(root, { profile, scoring, churn }) -> { features: Feature[], fallback: 'none'|'packages'|'app', churnAvailable: boolean }` where `Feature = { id, name, kind: 'module'|'package', paths: string[], files: number, loc: number, testFiles: number, fanIn: number, fanOut: number, churn: number|null, risk: 'high'|'medium'|'low', riskMatched: string[], proximity: number, score: number, bucket: 'first'|'next'|'last', reasons: string[] }`.
    - **Units:** a feature module (path segment matching `^features?([-_].+)?$`, name taken from the segment after `feature`), or a package directory `feature(s)/<name>` under a source root. When none exist, fall back to top-level packages with at least 3 source files (`fallback: 'packages'`), else a single unit `app` (`fallback: 'app'`).
    - **Isolation:** for module features, `fanOut` is the count of other feature modules it depends on and `fanIn` the count of feature modules depending on it, from `module.projectDeps`. For package features, count import references between the package prefixes. Fewer is better.
    - **Size:** `loc` counts non-blank lines, with bands from `scoring.json`. Small to medium scores best (pilot candidates). Very large scores lower.
    - **Tests:** `testFiles` is the number of files under `src/test` or `src/androidTest` in the module, or named `*Test.kt|java` whose package matches the feature.
    - **Risk:** the feature name is matched, case-insensitively and on word boundaries, against `riskKeywords`. Defaults: high = `auth, login, payment, onboarding, transfer, kyc, checkout, wallet`; medium = `profile, settings, notification, account`.
    - **Proximity:** the fraction of the feature's UI source files that already use the modern target (Compose composables over XML, ViewModel/StateFlow over callbacks). Use the profile entries' evidence files where possible, else a simple per-file import check. Range 0 to 1.
    - **Score and bucket:** `score = Σ weight × normalized input` in 0..100. Bucket `first` at or above `buckets.first`, `next` at or above `buckets.next`, otherwise `last`. A `high` risk feature is never in `first` (capped to `next`), and `reasons` says why. `reasons` is an array of short strings that cites the inputs (for example `isolated: fanIn 0, fanOut 1`, `no tests: write characterization tests first`).
  - CLI `node features.js <root> [--format json|md] [--out <file>]`. Exit codes: 0 ok, 1 usage error, 2 not a Gradle project. Output is redacted. `renderKnowledge` writes `knowledge/feature-map.md` (generated header, bucket tables, reasons), replacing the M2 stub.

- [ ] **Step 1: Write failing tests.**
  - Fixture `feature-app`: `login` and `payment` are `risk: high` and never land in `first`. `profile` (small, isolated, has tests, partly Compose) is bucketed `first`. `legacy-reports` (large, no tests) lands in `last` with the reason `no tests`. Scores are deterministic (run twice, deepEqual).
  - Churn: in a temp git repo with commits touching `feature/profile` 5 times and `feature/legacy-reports` once, churn values are 5 and 1. In a non-repo temp copy, and in a repo with zero commits, `churn` is `null`, `churnAvailable` is false, and all features are still ranked (Review Focus 1).
  - `legacy-java-mvp` (no feature structure) gives `fallback` equal to `packages` or `app` and a non-empty `features` array, never an empty array (Review Focus 2).
  - A weights override in a temp `scoring.json` changes bucket results (tunability).
  - `knowledge/feature-map.md` on `feature-app` contains each feature name and its bucket, starts with the generated header, and contains no `TODO`.
  - CLI exits: 0 on `feature-app`, 2 on a plain temp dir.
- [ ] **Step 2: Run `npm test`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Keep the per-file read linear and cap file reads at 1 MB like the indexer.
- [ ] **Step 4: Run `npm test`.** Expected: PASS, existing tests untouched.
- [ ] **Step 5: Commit** `feat: add feature map with tunable prioritization scoring`

---

### Task 2: Reusable-component detection and `components.md` registry (`reuse.js`)

**Files:**
- Create: `skill/scripts/lib/reuse.js`, `skill/scripts/reuse.js`, `skill/references/reuse.md` (content in Task 10, a stub is not allowed: write the real file here), fixture `test/fixtures/reuse-app/`
- Modify: `skill/scripts/lib/aidir.js` (new region-managed ownership for `knowledge/components.md`), `skill/templates/ai/knowledge/components.md`, `skill/scripts/lib/knowledge.js`
- Test: `test/reuse.test.js`

**Interfaces:**
- Consumes: `listFiles(root, { gitignore: true })`, `discoverModules`, `readLines`.
- Produces:
  - `detectReuse(root, { profile }) -> { duplicates: Duplicate[], baseClasses: BaseGroup[], boilerplate: Boilerplate[], tokens: TokenReport, sharedModules: string[], duplicationScore: 'low'|'medium'|'high' }`.
    - `Duplicate = { kind: 'layout'|'composable'|'util', signature: string, files: { file, line }[] }`. **Layouts:** a normalized structure signature (element names and `android:id`-free attribute names in order, text and resource values dropped); two or more layouts with the same signature and at least 4 elements are duplicates. **Composables:** the name-free signature of parameter types plus the ordered list of called composable names; at least 2 identical with at least 3 calls. **Utils:** identical function bodies after whitespace and comment normalization, at least 4 lines, across at least 2 files.
    - `BaseGroup = { role: 'activity'|'fragment'|'viewmodel', classes: { name, file, line }[] }`, reported when 2 or more competing `Base*` classes of the same role exist.
    - `Boilerplate`: repeated identical try/catch-and-map error handling blocks and repeated identical OkHttp/Retrofit builder blocks (same normalization, at least 3 occurrences).
    - `TokenReport = { colorsXml: number, dimensXml: number, hardcodedColors: number, hardcodedDp: number }`, counting hardcoded `Color(0x…)`, `#RRGGBB` and `\d+\.dp` in Compose and layout files outside token files.
    - `sharedModules`: existing design-system or shared modules, detected by name (`designsystem`, `design-system`, `ui`, `common`, `core-ui`, `shared`), used as the place where components belong.
    - `duplicationScore`: `high` at 5 or more duplicate groups or any base-class group with 3 or more members, `medium` at 2 to 4, otherwise `low`.
  - `renderComponents(reuse, existingText) -> string`. `knowledge/components.md` becomes **region-managed** (designer call): the file keeps user content, and the tool owns only the block between `<!-- android-architect:components:begin -->` and `<!-- android-architect:components:end -->`, which lists detected shared modules, duplicate groups (with `file:line`), base-class groups and token counts, under the generated header comment. A missing file gets the template with an empty curated section. A missing marker pair means the block is appended. Everything outside the markers is never touched. `writeAiDir` and `refresh` update only the block.
  - CLI `node reuse.js <root> [--format json|md]`. Exit codes as in Task 1.
- Fixture `reuse-app`: two identical XML layouts (`item_user.xml`, `item_account.xml`), two identical `@Composable` card functions, `BaseActivity` and `BaseScreenActivity`, a copied `formatMoney` util in two files, and 3 hardcoded colors. One `:core:designsystem` module exists.

- [ ] **Step 1: Write failing tests.**
  - On `reuse-app`: one layout duplicate group with both files, one composable group, one util group, one `activity` base group with both classes, token counts equal to the fixture (3 hardcoded colors), `sharedModules` containing `:core:designsystem`, `duplicationScore: 'medium'` or higher.
  - Layouts that differ only in text and ids are duplicates; layouts that differ in structure are not. A 3-element layout is below the minimum.
  - `renderComponents` on text that has user content plus a stale block replaces only the block (user bytes identical, before and after the markers); on text without markers it appends; running twice is a no-op.
  - End to end: `writeAiDir` on a temp copy of `reuse-app` with a hand-edited `components.md` keeps the edit and refreshes the block. `refresh` does the same. `.ai/` content passes through redaction (a fake secret placed in a util body does not appear in `components.md`).
  - `modern-compose` produces `duplicationScore: 'low'` with empty groups. A 1 MB single-line file does not stall detection (< 1 s).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Normalization must be linear (no nested quantifiers). Write `references/reuse.md` with the rules from spec 5.14: rule of three, no catch-all `common`, design system first with XML interop, `@Preview` plus a screenshot test per component, and the target shared-module set sized to the project.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: detect reusable components and maintain the components registry`

---

### Task 3: Playbook format, loader and `data-migration` script

**Files:**
- Create: `skill/scripts/lib/playbooks.js`, `skill/scripts/playbook.js`, `skill/catalog/playbooks/README.md` (the authoring guide), `skill/catalog/playbooks/_example-seam.md` (excluded from loading, documents the format)
- Modify: `skill/scripts/lib/catalog.js` (expose `playbooksDir`), `skill/scripts/lib/adr.js` (export `parseFrontMatter(text, file)`, shared by ADRs and playbooks, with ADR behavior unchanged), `package.json` `files` check in `test/package-policy.test.js` if needed
- Test: `test/playbooks.test.js`

**Interfaces:**
- Consumes: `loadCatalog` (`entry(dimId, id)`), `detectStack` profile, `presentEntries`, `reopenHolds` from `lib/adr.js`, `parseAdr`-style safe front matter parsing (reuse the strict parser; extend it only through an exported `parseFrontMatter(text, file)` that both ADRs and playbooks use).
- Produces:
  - Playbook file `skill/catalog/playbooks/<from>--to--<to>.md` with front matter keys: `id`, `dimension`, `from` (catalog entry id), `to` (catalog entry id), `title`, `irreversible` (`true|false`, true when on-device data moves), `kmpOnly` (`true|false`), `worthIf` (list of `present:<id>` / `absent:<id>` conditions, may be empty), `asOf` (date), `verified` (`false` until a maintainer confirms the facts; M4 ships everything `false`). Required body sections, as `## ` headings, in this order: `When it is worth it`, `When not to`, `Preconditions`, `Steps` (must mention the seam, running side by side, per-unit cutover, deleting the old implementation), `Pitfalls`, `Tests`, `Security checklist` (at least 2 list items), `Rollback`.
  - `loadPlaybooks(dir) -> Playbook[]`: `{ id, dimension, from, to, title, irreversible, kmpOnly, worthIf, asOf, verified, sections: Record<string,string>, securityChecklist: string[], file }`. A file that does not follow the format throws a file-prefixed error. Files starting with `_` and `README.md` are skipped.
  - `validatePlaybooks(playbooks, catalog) -> string[]`: `from` and `to` exist in the catalog in that dimension, `from` is not `to`, `to` is reachable from `from` by catalog successors (the playbook may cross entries within the same dimension only), all sections present in order, security checklist >= 2 items.
  - `applyPlaybook(playbook, profile, catalog) -> { applicable: boolean, reason?: string, worth: { ok: boolean, notes: string[] }, cutoverUnits: { file, line|null, module }[], gated: boolean, tags: string[], securityChecklist: string[] }`:
    - `applicable` is false with `reason` `"<from> not detected in this project"` when the `from` entry is absent from the profile (Review Focus 3). In that case `cutoverUnits` is empty.
    - `cutoverUnits` come from the profile evidence of the `from` entry (file and line from the evidence rows, with the owning module), sorted, capped at 200 with a count of the rest.
    - `worth.ok` evaluates `worthIf` with `reopenHolds`; `notes` explains a failed condition (for example `Retrofit to Ktor is worth it mainly with KMP; kmp not detected: do not migrate unless you plan to share networking`).
    - `tags`: `irreversible` when the front matter says so, and `decision` when `securityChecklist` is non-empty (the run loop gates these in M5).
  - CLI `node playbook.js list` (ids, titles, `from` to `to`), `node playbook.js show <id>`, and `node playbook.js apply <from> <to> <root> [--format json|md]`. Unknown pair: exit 1 with the list of known pairs. Not a Gradle project: exit 2. Output is redacted.

- [ ] **Step 1: Write failing tests.** Using temp playbook dirs plus one fixture playbook:
  - A well-formed playbook loads. Each malformed case throws a file-prefixed error: missing section, sections out of order, security checklist with 1 item, `from` equal to `to`, unknown front-matter key, `irreversible: maybe`.
  - `validatePlaybooks` rejects a `from` not in the dimension and a non-reachable `to`.
  - `applyPlaybook` on `legacy-java-mvp` for a networking pair whose `from` is present returns `applicable: true`, non-empty `cutoverUnits` with real files, `tags` containing `decision`. For a pair whose `from` is absent it returns `applicable: false`, the reason text, and empty units (Review Focus 3).
  - `worthIf: ['present:kmp']` gives `worth.ok` false with a note on a non-KMP project and true when the profile has `kmp`.
  - CLI: `list` exits 0, an unknown pair exits 1 and names the known pairs, `apply` on a non-Gradle dir exits 2.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The README for authors documents the format, how to add a pair, and the fixture test requirement. Do not add real playbooks here (Tasks 4 and 5).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: add playbook format, loader and data-migration apply script`

---

### Task 4: Playbook content A (data layer)

**Files:**
- Create: `skill/catalog/playbooks/` files for the six pairs below, `test/playbook-content.test.js`
- Modify: catalog dimension files only when a needed entry id is missing (check `persistence`, `keyvalue`, `networking`, `serialization`; if you add an entry, follow the existing schema and bump `catalogVersion` to `2026.11.3`)

**Interfaces:**
- Consumes: Task 3 format and `validatePlaybooks`.
- Produces six playbooks, one file each, ids equal to the file stem:
  1. Retrofit to Ktor client (`okhttp-retrofit` to `ktor-client`): `worthIf: [present:kmp]`, `irreversible: false`. Worth it mainly for KMP. Steps cover the Repository/DataSource seam, side by side, per-endpoint cutover behind a flag. Security checklist: re-implement certificate pinning, auth and signing interceptors, logging redaction, and cleartext policy.
  2. SQLiteOpenHelper/ContentProvider to Room (`sqlite-openhelper` or the catalog's id for it, to `room`): `irreversible: true`. Open the existing database file, map the schema 1:1 first, `MigrationTestHelper` against real old-version databases, backup plan. Security checklist: encryption (SQLCipher) carried over, exported ContentProvider permissions preserved, no plaintext export.
  3. GreenDAO/ORMLite/Realm to Room: `irreversible: true`. One-time copy with a "migrated" marker, then delete. Security checklist: encrypted Realm to Room encryption, key handling, leftover plaintext files wiped.
  4. SharedPreferences to DataStore: `irreversible: true`. `SharedPreferencesMigration`, one prefs file per step. Security checklist: EncryptedSharedPreferences to DataStore is **not encrypted by default** (Tink/Keystore needed), and the old file must be removed after migration.
  5. Gson to Moshi/kotlinx.serialization (two playbooks if the catalog has two target entries, else the one that exists): JSON contract tests, null and default handling, polymorphism. Security checklist: unsafe deserialization settings and reflection-based allow lists are not carried over, and untrusted-JSON size limits.
  6. Room to SQLDelight: `kmpOnly: true`, `worthIf: [present:kmp]`. Security checklist: encryption driver parity.
- Every playbook states `asOf: 2026-11` and `verified: false`.

- [ ] **Step 1: Write failing tests (`playbook-content.test.js`).** `loadPlaybooks(<shipped dir>)` loads without error. `validatePlaybooks` returns `[]` against the shipped catalog. The six expected ids exist, and each has at least 2 security checklist items. A table of expected keywords per playbook is asserted in its `Security checklist` section (for example `pinning` for Retrofit to Ktor, `not encrypted` for SharedPreferences to DataStore, `MigrationTestHelper` in the Room playbook's `Tests`). Every playbook mentions "seam" and "side by side" in `Steps`. No playbook text contains the project-private names, secrets, or URLs other than `https://developer.android.com` and `https://kotlinlang.org` and `https://ktor.io` and `https://square.github.io` documentation links. Playbooks pass the injection scanner (`scanInstructions`) with zero findings.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Write the playbooks** (real, useful content; practical steps and pitfalls from the Android docs). Add missing catalog entries only if truly needed.
- [ ] **Step 4: Run `npm test`, expect PASS.**
- [ ] **Step 5: Commit** `feat: add data-layer migration playbooks with security checklists`

---

### Task 5: Playbook content B (async, DI, UI, navigation)

**Files:**
- Create: `skill/catalog/playbooks/` files for the seven pairs below; extend `test/playbook-content.test.js`
- Modify: catalog dimension files only when a needed entry id is missing (same rule as Task 4)

**Interfaces:**
- Produces seven playbooks (ids equal to file stems), `asOf: 2026-11`, `verified: false`:
  1. RxJava to Coroutines/Flow: `kotlinx-coroutines-rx3` bridges, bottom-up conversion, schedulers to dispatchers, error semantics. Security checklist: error handlers that logged or swallowed, auth-token refresh interceptors keep working, no thread-confinement assumptions dropped.
  2. AsyncTask/Loader to Coroutines: lifecycle scopes, cancellation. Security checklist: work that outlived the screen (uploads) stays in a service or WorkManager.
  3. LiveData to StateFlow: `repeatOnLifecycle`, single-event handling. Security checklist: sensitive state not retained or logged longer than before.
  4. Dagger 2 to Hilt: component mapping, `@EntryPoint` for non-Android classes, scoping. Security checklist: no scope widening that keeps credentials alive.
  5. Koin to Hilt and when to stay: `worthIf` is empty, and `When not to` explains staying.
  6. XML Views to Compose, per screen with interop (`ComposeView`, `AndroidView`): `irreversible: false`. Security checklist: `FLAG_SECURE` and screenshot blocking preserved, WebView settings carried over, accessibility, input masking for password fields.
  7. Navigation XML to type-safe Navigation Compose: deep links, back stack, argument handling. Security checklist: exported deep-link activities and intent filters re-validated, argument validation, no untrusted URI parsing regressions.
- If the catalog lacks an entry for a pair, use the closest existing ids and note it in the report.

- [ ] **Step 1: Write failing tests.** Extend `playbook-content.test.js`: the seven ids exist and validate, each has at least 2 checklist items, per-playbook keyword assertions (for example `FLAG_SECURE` in the Compose playbook, `exported` in the navigation playbook, `Koin` and `stay` in `When not to` for Koin to Hilt), no injection findings, no private names.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Write the playbooks.**
- [ ] **Step 4: Run `npm test`, expect PASS.**
- [ ] **Step 5: Commit** `feat: add async, DI, UI and navigation migration playbooks`

---

### Task 6: Library update planning (`lib-update`)

**Files:**
- Create: `skill/scripts/lib/libupdate.js`, `skill/scripts/lib-update.js`, `skill/catalog/versions.json`, `skill/references/library-updates.md`
- Modify: `skill/scripts/lib/catalog.js` (expose and validate `versions.json`), `CHANGELOG.md`
- Test: `test/libupdate.test.js`

**Interfaces:**
- Consumes: `discoverModules` (dependencies with `group`, `name`, `version`, `unresolved`, `alias`, `line`), `vulnerableDependencies` and `parseRange` from `lib/vuln.js`, `compareVersions` from `lib/version.js`, the project `profile`.
- Produces:
  - `versions.json`: `{ schemaVersion: 1, asOf: "<YYYY-MM-DD>", libraries: [{ coord: "group:name", stable: "<version>", group: "<update-group id>", requires?: { kotlin?: ">=x.y", agp?: ">=x.y", minSdk?: n }, notes?: string }] }`. Initial set of 25 to 40 widely used libraries (AndroidX core/appcompat/activity/fragment/lifecycle/navigation/room/work/datastore/compose BOM, Kotlin coroutines, OkHttp, Retrofit, Moshi, kotlinx.serialization, Ktor, Coil, Glide, Hilt, Dagger, Koin, JUnit, MockK, Turbine, Espresso). The values are written from memory: the file header and CHANGELOG say **unverified, maintainers must audit before release**, and each row carries no claim of being the latest.
  - `planLibraryUpdates(profile, modules, catalog, versions, { today, staleDays = 90 }) -> { generatedAt, dataAsOf, stale: boolean, groups: Group[], cannotUpdate: Item[], notes: string[] }`:
    - `Item = { coord, module, file, line, current, target, kind: 'patch'|'minor'|'major', reason: 'security'|'routine', advisory?: { id, severity, summary, source }, requires?: object, verify: boolean }`.
    - **Order (designer call):** group 1 `security` (all items with an advisory covering the current version, highest severity first), then `patch/minor` routine updates grouped by `group` id (one group per update group, sorted by name), then `major` updates last, each major listing prerequisites from `requires` as prior steps. Within a group, items are sorted by coord. A `target` is only emitted when `versions.json` has the coord and the target is newer than `current`.
    - `verify: true` on every item when `stale` (dataAsOf older than `staleDays` before `today`), and on any item whose coord has no advisory data and whose row is a major jump.
    - **cannotUpdate:** dependencies with unresolved, dynamic or null versions (the same rules as `vuln.js`), alias or bundle dependencies that could not be resolved, and coords missing from `versions.json` are listed with a reason and are never given a guessed target (Review Focus 4).
    - Security items whose advisory has no fixed version in `versions.json` carry `target: null` and a note (`no fixed version known: check the advisory source`).
  - CLI `node lib-update.js <root> [--scope <module-path>] [--format json|md]`. `--scope` limits to one module. `--today` is accepted only for tests (`YYYY-MM-DD`). Exit codes 0, 1, 2 as before. Output is redacted.

- [ ] **Step 1: Write failing tests** with a temp project and a temp `versions.json`:
  - A vulnerable Gson (`2.8.6`) is the only item in group 1 with `reason: 'security'` and the advisory id, and it precedes everything else even when other updates exist.
  - Routine patch/minor updates are grouped by `group`. A major bump (for example Retrofit 2.x to 3.x) lands after them, with its `requires` listed.
  - An up-to-date or newer-than-catalog dependency produces no item.
  - `2.+`, `latest.release` and an unresolved alias appear in `cannotUpdate` with no `target` (Review Focus 4).
  - With `today` 100 days after `asOf`, `stale` is true and every item has `verify: true`. With 10 days, `verify` is false for routine patch updates.
  - Version-catalog aliases are resolved, and each item cites the file and line of its declaration.
  - `--scope :feature:home` limits items to that module. Output has no secret values (a fake secret placed in a dependency comment does not appear).
  - `catalog.js` rejects a malformed `versions.json` (missing `asOf`, bad coord, non-string `stable`) with a file-prefixed error.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Write `references/library-updates.md`: partial-update rules, the group order and why, how to read `verify`, compatibility matrices (Kotlin, AGP, Compose compiler, KSP), and how to treat a security update.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: add security-first library update planning`

---

### Task 7: `fitness`: architecture checks from accepted ADRs

**Files:**
- Create: `skill/scripts/lib/fitness.js`, `skill/scripts/fitness.js`, `skill/references/fitness.md`
- Modify: `skill/scripts/lib/adr.js` (accept an optional `fitness` list key), `skill/scripts/lib/overrides.js` (export `matchGlob`), `skill/templates/ai/knowledge/adr/0000-template.md` (document the key, commented), `skill/catalog/recommendations.schema.md` (ADR front matter docs)
- Test: `test/fitness.test.js`, fixture `test/fixtures/fitness-app/` (multi-module with `:feature:a`, `:feature:b`, `:core:data` and a forbidden dependency `:feature:a` to `:feature:b`)

**Interfaces:**
- Consumes: `loadAdrs`, `discoverModules`/`moduleGraph`, the tiny glob grammar (export `matchGlob(pattern, text)` from `lib/overrides.js`: segments with at most one `*` each, optional leading `**/`, linear matching, no regexes).
- Produces:
  - ADR front matter key `fitness: [ "<rule>", ... ]` on **accepted** ADRs only. Rule grammar (each rule is one string):
    - `module-no-dep: <fromGlob> -> <toGlob>`: no module whose path matches `fromGlob` may depend on a module matching `toGlob` (for example `:feature:* -> :feature:*` with the same-module self match excluded).
    - `package-no-import: <packageGlob> -> <importPrefix>`: no Kotlin/Java file in a package matching the glob may import a name starting with the prefix.
    - Limits: at most 20 rules per ADR, each at most 200 characters, values restricted to `^[A-Za-z0-9_.:\-/*]+$` plus the ` -> ` separator. Anything else is rejected with an `<adr file>: rule "<n>": <reason>` error before use (Review Focus 5).
  - `parseFitnessRules(adrs) -> { rules: Rule[], errors: string[] }` with `Rule = { id, adr, kind, from, to }`. Only `accepted` ADRs contribute. `proposed`, `rejected` and `superseded` ADRs with rules produce a note, not rules.
  - `checkFitness(root, rules, { profile? }) -> { ok: boolean, violations: { rule, from, to, file, line|null }[] }`. A static evaluation of the rules against the module graph (module rules) and the import lines of source files (package rules). This is the same check the generated artifacts perform, so it runs in tests and in the future `run` loop without Gradle.
  - `generateFitness(rules, modules) -> Record<relPath, string>` returning generated files under `.ai/fitness/`:
    - `architecture-fitness.gradle.kts`: a root-project script (apply with `apply(from = ".ai/fitness/architecture-fitness.gradle.kts")`) containing one task `architectureFitness` that fails the build with a message listing each forbidden project dependency, plus the wiring so `check` depends on it. It encodes the rules as Kotlin data with escaped string literals.
    - `ArchitectureFitnessTest.kt`: a Konsist test (package rules, and module rules via `Konsist.scopeFromModule`) with escaped literals, plus a comment header naming the ADR for each rule.
    - `verify-commands.json`: `{ schemaVersion: 1, commands: ["./gradlew architectureFitness", "./gradlew testDebugUnitTest --tests '*ArchitectureFitnessTest'"] }` for the run loop's verification (M5).
    - `README.md`: how to apply the files, and that they must be reviewed and copied into the project by the user, never auto-applied.
    - Generated files carry the generated header and pass through `redact()`. Every emitted rule value was validated; module paths from the project are validated with the same character set, and a module whose path fails it is skipped with a note.
  - CLI `node fitness.js <root> [--check] [--out <dir>]`: default prints the rules found and writes the generated files into `<root>/.ai/fitness/` through the guarded writer (`.ai/` must exist, else exit 2 with a message to run init); `--check` evaluates and exits 1 on violations (JSON on stdout), 0 when clean.

- [ ] **Step 1: Write failing tests.**
  - ADR `fitness: ["module-no-dep: :feature:* -> :feature:*"]`, accepted: `checkFitness` on `fitness-app` reports exactly one violation, `:feature:a` to `:feature:b`, with the `build.gradle` file and line. After removing that dependency in a temp copy it reports none. `--check` exits 1 and 0 accordingly.
  - A `proposed` ADR with rules contributes no rules and yields a note.
  - Package rule: a file importing `com.example.data.db.` from package `com.example.ui.*` is a violation with `file:line`.
  - Generated Gradle script and Konsist test contain the rule and parse as balanced (check bracket balance and that the strings contain no unescaped `"` or `$`). `verify-commands.json` is valid JSON.
  - **Hostile input (Review Focus 5):** rules containing `"`, `$`, a backtick, a newline, `; rm`, a 201-character value, `**/**/**`, `*a*a*a*a*a*a*a*b` and 21 rules in one ADR are each rejected with the rule-prefixed error and nothing is generated for them. A module path containing `"` is skipped with a note and never appears in generated code. Matching `*a*a*a*a*a*a*a*b` against a 1 MB path is not reached (rejected up front), and an allowed worst case matches in < 50 ms.
  - Generated files are written only under `.ai/fitness/`, and a symlinked `.ai/fitness` is refused. A fake secret placed in an ADR rule value never appears in output (rejected by the charset anyway).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `references/fitness.md` documents the rule grammar, the safety rules, why detekt is not generated in v1, and how teams apply the files.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: generate architecture fitness checks from accepted ADRs`

---

### Task 8: Compliance and build-performance advice

**Files:**
- Modify: `skill/catalog/dimensions/compliance.json`, `skill/catalog/dimensions/build-performance.json`, `skill/catalog/catalog.json` (`catalogVersion` `2026.11.3`), `skill/scripts/lib/detect.js` (`evaluateCompliance`, a `buildPerformance` summary), `skill/scripts/lib/report.js`, `skill/scripts/lib/knowledge.js`, `CHANGELOG.md`
- Test: `test/compliance.test.js` (extend), `test/buildperf.test.js`, fixtures extended with small variants

**Interfaces:**
- Consumes: existing `profile.compliance` (`{ id, status, detail }`, status `ok|gap|unknown`), `profile.sdk`, `buildUnits`, `gradle.properties` reading helpers already used for build-performance entries.
- Produces:
  - New dated **policy advice** entries in `compliance.json` (data, with `effective` dates and `source` links, all written from memory and marked `verified: false` in the CHANGELOG): 16 KB page size support, edge-to-edge enforcement, predictive back, foreground service types, notification and media permission changes, exact alarm permission. Each entry has `appliesWhen` machine-checkable signals (all optional): `targetSdkMin`, `hasNative` (`.so` under `jniLibs`, `externalNativeBuild`, `ndk {` in Gradle), `usesForegroundService` (`<service` with `foregroundServiceType` missing or `startForeground(` calls), `usesExactAlarm` (`SCHEDULE_EXACT_ALARM`, `setExact`), `usesNotifications` (`NotificationManager` or `POST_NOTIFICATIONS`).
  - `evaluateCompliance` emits, per applicable entry, `{ id, status: 'ok'|'gap'|'unknown'|'check', detail, source? }`. `check` means the policy applies and the project cannot be verified statically (for example native libraries present, so 16 KB alignment needs a manual check). A policy whose `effective` date is later than the catalog `asOf` is listed as `upcoming` in `detail` and never as `gap`.
  - `profile.buildPerformance: { items: { id, status: 'ok'|'gap'|'unknown', detail, file, line|null }[] }`, covering: `org.gradle.configuration-cache`, `org.gradle.caching`, `org.gradle.parallel`, `android.nonTransitiveRClass`, kapt use that has a KSP alternative in the catalog, and Gradle/AGP/Kotlin versions older than the catalog's `current` entries (use the existing build-performance entries and `minVersion` mechanism, no invented thresholds). Missing `gradle.properties` is `unknown`, never `gap`.
  - `renderProfileMarkdown` adds `## Compliance` details for the new statuses and `## Build performance`. `architecture-current.md` shows both.

- [ ] **Step 1: Write failing tests.**
  - A fixture with `jniLibs/arm64-v8a/libfoo.so` yields a `check` item for 16 KB page size. Without native code the item is absent.
  - A manifest with `<service android:name=".Sync"/>` plus a `startForeground(` call yields a foreground-service-type `gap` at `targetSdk >= 34`, and `ok` when `android:foregroundServiceType` is declared. Below the threshold it is `ok`, not `gap`.
  - A policy with an `effective` date after `asOf` is reported as upcoming, never `gap`.
  - `gradle.properties` with `org.gradle.caching=true` and without configuration cache gives caching `ok`, configuration cache `gap` with the file and line (`null` when the key is absent), and a project without `gradle.properties` gives `unknown`.
  - Kapt on a project whose catalog has a KSP alternative gives a `gap` item that names KSP. All new data passes `validateCatalog`.
  - Existing compliance and detection tests keep passing (the old `target-sdk-36` item is unchanged).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: add compliance policy advice and build-performance checks`

---

### Task 9: Migration plan generator (`migration-plan`)

**Files:**
- Create: `skill/scripts/lib/migplan.js`, `skill/scripts/migration-plan.js`, `skill/references/migration-patterns.md`, `skill/references/feature-prioritization.md`, `skill/references/modularization.md`
- Modify: `skill/templates/ai/migration/roadmap.md` (document the format), `skill/catalog/recommendations.schema.md` (plan format)
- Test: `test/migplan.test.js`

**Interfaces:**
- Consumes: Task 1 `buildFeatureMap`, Task 2 `detectReuse`, Task 3 `loadPlaybooks`/`applyPlaybook`, Task 6 is not required, the validated `recommendations.json` (steps with `id`, `dimension`, `from`, `to`, `dependsOn`, `tags`), `profile`, `catalog`.
- Produces:
  - `buildPlan({ recs, features, reuse, playbooks, profile, catalog }) -> { schemaVersion: 1, steps: PlanStep[], tracks: { features: string[], data: string[], enabling: string[] }, notes: string[] }` with `PlanStep = { id, title, track: 'enabling'|'data'|'feature', dimension, from, to, feature?: string, playbook?: string, dependsOn: string[], tags: ('irreversible'|'decision')[], verification: string[], rollback: string, evidence: string[] }`.
  - **Rules (deterministic skeleton, the model writes prose):**
    1. **Enabling steps first:** characterization tests (unit) and screenshot tests (Roborazzi/Paparazzi) for each `first`-bucket feature, as `safety-net:<feature>` steps that every migration step of that feature depends on (spec 5.16). A shared-component extraction step `extract:design-system` when `reuse.duplicationScore` is `medium` or `high`, before the UI migration steps.
    2. **Data track separate:** recommendation steps whose dimension is `persistence`, `keyvalue`, `networking` or `serialization` with a matching playbook become `data` steps, scheduled as one track (not per feature), each carrying the playbook id, `irreversible` per the playbook, and `decision` when the security checklist is non-empty. When no playbook matches, the step is plain, with a note.
    3. **Feature track:** UI and presentation steps are expanded per feature in bucket order (`first`, then `next`; `last` features get none and a note `leave as is`), each depending on its safety-net step and on the recommendation prerequisites (`dependsOn` of the original step mapped to the new ids).
    4. Every `decision` or `irreversible` tag from the source step is kept. Steps always depend on their prerequisite steps, so the plan stays acyclic (verified).
    5. Only features with `risk: high` get an extra `decision` tag (ask the user before touching them).
  - `renderRoadmap(plan) -> string`: the Markdown table for `migration/roadmap.md` (`Step | Description | Status`, every status `todo`, tags shown in the description).
  - CLI `node migration-plan.js <root> --recs <file> [--format json|md] [--out <file>]`. It validates the recs with `checkRecommendations` first and exits 1 with the violations when they do not pass. It never writes into the project: the agent writes `.ai/migration/roadmap.md` after the user agrees.

- [ ] **Step 1: Write failing tests** using `feature-app` and `reuse-app` fixtures plus a recs file that passes `recommend-check`:
  - The plan contains a `safety-net:profile` step, the `profile` migration steps depend on it, and no `login` step lacks the `decision` tag.
  - `last`-bucket features have no steps and appear in `notes` as `leave as is`.
  - A persistence recommendation with a matching playbook becomes exactly one `data` step with the playbook id, `irreversible: true` and `decision`, and appears in `tracks.data`, not in `tracks.features`.
  - With `reuse.duplicationScore: 'high'`, `extract:design-system` exists and precedes the UI feature steps.
  - The plan is acyclic and every `dependsOn` id exists (property test over the fixtures). Re-running gives identical output.
  - Invalid recs make the CLI exit 1 with the violations. `renderRoadmap` output starts with the table header and has one row per step.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Write the three references: `migration-patterns.md` (seam, strangler fig, side by side, feature flags, per-unit cutover), `feature-prioritization.md` (the scoring model, tuning `scoring.json`, why high-risk features are not pilots), `modularization.md` (layer vs feature modules, api/impl, polyrepo vs mono repo, convention plugins).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat: generate staged migration plans with safety nets and data track`

---

### Task 10: Skill commands, README and release notes for M4

**Files:** `skill/SKILL.md`, `skill/references/output-templates.md`, `skill/references/recommendation-method.md`, `skill/templates/ai/workflows/02-plan.md`, `skill/templates/ai/workflows/03-implement.md`, `skill/templates/ai/workflows/04-review.md`, `README.md`, `CHANGELOG.md`, `package.json` (version `0.4.0`), `test/skill-docs.test.js`, `test/templates.test.js`.

Content decisions:
- New SKILL commands, each following the existing command style (goal, numbered steps, scripts with exit codes, what is written where): **prioritize** (`features.js`, writes nothing unless `.ai/` exists, then `feature-map.md` is generated by init/refresh), **migration-plan** (`migration-plan.js`; the agent writes `.ai/migration/roadmap.md` only after the user agrees), **data-migration** (`playbook.js apply`; says clearly when a playbook is not applicable or not worth it), **lib-update** (`lib-update.js`; security group first, `verify` handling, `cannotUpdate`), **fitness** (`fitness.js`; the agent shows the generated files, and copies them into the project only after the user approves, because they change the build), and the **reuse** guidance in `audit`/`prioritize` (`reuse.js`, components registry rules).
- New SKILL command **review** (spec 5.11; no script of its own, it was unassigned in earlier milestone maps and lands here): the agent reads the current diff with read-only `git diff`, then checks it against accepted ADRs, `architecture-target.md` (only `status: accepted` is binding), the rubrics, `components.md` (flags new code that duplicates a registered component), and `node <skill-dir>/scripts/fitness.js <root> --check` when fitness rules exist. It writes nothing unless the user asks.
- "Not yet available" keeps only `run`. Check against the code before claiming anything.
- Workflows 02, 03 and 04: 02 checks `components.md` and the roadmap order; 03 says one roadmap step per PR and runs `fitness.js --check` after architecture-relevant steps when fitness files exist; 04 reviews against accepted ADRs, fitness results and the components registry. Templates must keep scanning clean under `lib/injection.js`.
- Ground rule 4's program list gains the new scripts (`features.js`, `reuse.js`, `playbook.js`, `lib-update.js`, `fitness.js`, `migration-plan.js`). `fitness.js` is the one new script that writes (into `.ai/fitness/`), and the rule says so.
- Docs tests derive facts from the code where possible (script names exist under `skill/scripts/`, playbook ids listed in SKILL exist in the shipped playbooks, command names match).
- README: a "Planning a migration" section (prioritize, migration-plan, data-migration, lib-update, fitness) and the playbook list. The roadmap moves M4 to done and keeps M5. CHANGELOG `[0.4.0]`: Tool entries for Tasks 1 to 9, Catalog `2026.11.3` with a note that library versions, compliance dates and playbook facts are **unverified, maintainer audit required**.

- [ ] **Step 1: Write failing doc tests.** SKILL contains the six new command headings (`prioritize`, `migration-plan`, `data-migration`, `lib-update`, `fitness`, `review`) and each script name; every script it names exists; every playbook id it mentions exists; "Not yet available" lists only `run`; README mentions each command; `package.json` version is `0.4.0`; CHANGELOG has `[0.4.0]` and the word `unverified`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Edit the docs.**
- [ ] **Step 4: Run `npm test`, expect PASS.**
- [ ] **Step 5: Commit** `docs: document M4 planning commands, playbooks and release notes`

---

### Task 11: M3 follow-ups that touch user-visible behavior

Source: `docs/superpowers/m3-followups.md`. Remove each fixed item from that file in this task's commit.

**Files:** `skill/scripts/lib/knowledge.js`, `skill/scripts/lib/overrides.js`, `skill/scripts/lib/aidir.js`, tests in the matching `test/*.test.js`, `docs/superpowers/m3-followups.md`.

Items:
1. `architecture-current.md` prints `(showing first 50)` while it shows 10 findings. It must say the number it actually shows (`showing first 10 of N`). Test.
2. A member's hub path is not verified. For `workspace.role === 'member'`, the hub's manifest must have `workspace.role === 'hub'` and list this member in `repos.json`; otherwise refuse with a clear message. Symlinks on the hub's `.ai` or `.ai/catalog-overrides` are refused like the member's own. Test with a forged member manifest pointing at an unrelated directory.
3. An unreadable member manifest silently falls back to the member's own overrides. It must raise the same hub error instead. Test.
4. The member's `architecture-current.md` heading says `.ai/catalog-overrides/` even when the overrides come from the hub. The heading must name the actual source directory. Test.

- [ ] **Step 1: Write failing tests for items 1 to 4.**
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`, expect PASS.**
- [ ] **Step 5: Commit** `fix: accurate findings count, verified hub membership, honest override source`
