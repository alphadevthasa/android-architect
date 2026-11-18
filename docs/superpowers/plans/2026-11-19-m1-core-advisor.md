# android-architect M1 (Core Advisor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an installable npm package that puts an `android-architect` skill into Claude Code and Codex. The skill detects any Android project's stack on every catalog dimension, computes catalog-legal migration candidates, and validates the agent's recommendations with a guardrail. Those pieces back the `audit` and `recommend` commands.

**Architecture:** The package is zero-dependency Node ESM. `bin/cli.js` installs a self-contained `skill/` folder (SKILL.md, references, a versioned JSON catalog, and Node scripts) into each harness's skills directory. All deterministic work (file walking, Gradle/TOML parsing, module graph, stack detection, candidate paths, guardrail) lives in `skill/scripts/lib/`. Thin entry scripts in `skill/scripts/` print JSON or Markdown for the agent. Judgment (choosing targets, labels, prose) comes from the model, guided by the references.

**Tech Stack:** Node >= 20 (ESM, `node:test`, `node:assert/strict`, `node:fs`, `node:path`), no runtime or dev dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-android-architect-design.md`

**Milestone map** (one plan each, written when the previous one ships):
- **M1 (this plan):** package, CLI install/doctor, catalog, scan/audit, candidates, guardrail, SKILL.md and core references
- M2: `update` CLI command, `.ai/` generator, local BM25 index, workflows, workspace mode, `--local`, manifest + hashes, `refresh` and the recommendation diff, rejected ADRs
- M3: security: secret redaction, gitignore-aware indexing, tamper check, injection rules, `rubric-security.md`, `vulnerableVersions`, playbook security checklists
- M4: feature prioritization (churn via git), data-layer playbooks, reuse detection + `components.md`, `fitness` generator, `lib-update`, compliance + build-performance advice
- M5: `run` loop, eval suite on real open-source apps, release pipeline (`--provenance`)

## Global Constraints

- All docs, prompts and code comments are in English.
- Runtime: Node `>=20`. `package.json` has `"type": "module"`, **no `dependencies`, no `devDependencies`**, and no `preinstall`/`install`/`postinstall`/`prepare` scripts.
- Scripts make **no network requests**. No `eval`, `new Function`, or dynamic `import()` of computed paths. If a child process is ever needed, use `execFile` with fixed args (M1 needs none).
- Scripts only read the project. M1 writes only where an explicit `--out` path is given.
- Catalog files are **strict JSON** (designer call: the spec allowed JSON or restricted YAML; JSON needs no parser dependency) with `schemaVersion: 1`.
- Never follow symlinks that leave the scanned root. Always skip `build/`, `.gradle/`, `.git/`, `.idea/`, `node_modules/`, `.ai/`, `graphify-out/`.
- Never read these files (spec 5.13 B, early baseline): `local.properties`, `keystore.properties`, `*.jks`, `*.keystore`, `*.p12`, `google-services.json`, `.env*`.
- Package name `android-architect`, binary `android-architect`, install folder name `android-architect`.
- Commit messages: conventional commits, **no `Co-Authored-By` or `Claude-Session` trailers** (user rule).
- Layout deviation from spec 5.1 (designer call): scripts live in `skill/scripts/` instead of a top-level `scripts/`, so the installed skill and the later `.ai/tools/` vendoring copy one self-contained folder.

## Review Focus

1. Gradle values that can't be resolved (`"$kotlin_version"`, `rootProject.ext.versions.retrofit`, function calls) must produce `version: null, unresolved: true` and must not throw. Pinned in Task 4.
2. `settings.gradle(.kts)` variants: several modules per `include` line, `include(":a:b")` nested paths, `project(':x').projectDir = file('libs/x')`, and a missing settings file (a single-module project). Pinned in Task 6.
3. A large or odd tree: symlink loops, symlinks out of the root, `build/` folders with thousands of generated files. The scan must not hang or leave the root. Pinned in Task 1.
4. CRLF line endings and a UTF-8 BOM must still give correct `line` numbers in evidence. Pinned in Task 1 (`readLines`) and Task 7.
5. Reinstalling over an older install must leave no stale files, and installing when `~/.claude/skills` doesn't exist yet must create it. Pinned in Task 9.

---

### Task 0: Repository bootstrap and package policy

**Files:**
- Create: `package.json`, `.gitignore`, `README.md` (stub: name, one-line purpose, "No telemetry" section), `CHANGELOG.md` (with `## Tool` and `## Catalog` sections under `## [0.1.0] - Unreleased`), `test/package-policy.test.js`, `test/helpers/no-network.mjs`

**Interfaces:**
- Produces: `npm test` = `node --test --import ./test/helpers/no-network.mjs test/`. After this task every test runs with the network blocked.

- [ ] **Step 1: `git init`, add `.gitignore`** (`node_modules/`, `*.tgz`, `.DS_Store`), and commit the existing spec and this plan as `docs: add design spec and M1 plan`.

- [ ] **Step 2: Write the failing test `test/package-policy.test.js`**

```js
test('package has no install-time scripts', () => {
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare'])
    assert.equal(pkg.scripts?.[k], undefined);
});
test('package has no runtime or dev dependencies', () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), []);
});
test('package metadata', () => {
  assert.equal(pkg.name, 'android-architect');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.bin['android-architect'], 'bin/cli.js');
  assert.equal(pkg.engines.node, '>=20');
  assert.deepEqual(pkg.files.sort(), ['bin', 'skill']);
});
test('network is blocked in tests', async () => {
  await assert.rejects(() => fetch('https://example.com'), /network disabled/);
});
```

- [ ] **Step 3: Run `node --test test/` and confirm it fails** (no package.json).

- [ ] **Step 4: Create `package.json`** (version `0.1.0`, license `MIT`, fields as asserted, `"scripts": {"test": "node --test --import ./test/helpers/no-network.mjs test/"}`). Create `test/helpers/no-network.mjs`. It replaces `globalThis.fetch`, `net.connect`, `net.createConnection`, `http.request`, `http.get`, `https.request`, `https.get`, `dns.lookup` and `tls.connect` with functions that throw `Error('network disabled in tests')`.

- [ ] **Step 5: Run `npm test`.** Expected: 4 passing.

- [ ] **Step 6: Commit** `chore: bootstrap package with no-deps and no-network policy`

---

### Task 1: Safe project file walker

**Files:**
- Create: `skill/scripts/lib/walk.js`
- Test: `test/walk.test.js` (builds temp trees with `fs.mkdtempSync(os.tmpdir())`)

**Interfaces:**
- Produces:
  - `listFiles(root: string, opts?: { extraIgnoreDirs?: string[] }): string[]`: sorted, POSIX-style relative paths of regular files under `root`. Skips the ignore dirs and secret files from Global Constraints. Follows a symlink only when its real path stays inside `realpath(root)`. Uses a visited set of real directory paths to break loops.
  - `readLines(absPath: string): string[]`: reads UTF-8, strips a leading BOM, splits on `/\r?\n/`. Index `i` is line `i + 1`.
  - `SECRET_FILE_PATTERNS: RegExp[]`, `IGNORED_DIRS: string[]` (exported for later milestones).

- [ ] **Step 1: Write failing tests**
  - `lists files sorted with posix separators`: tree `a/B.kt, a/b/C.java, build.gradle` gives `['a/B.kt','a/b/C.java','build.gradle']`.
  - `skips ignored dirs`: files under `build/`, `app/build/`, `.gradle/`, `.git/`, `node_modules/`, `.ai/` are absent.
  - `skips secret files`: `local.properties`, `app/release.jks`, `keystore.properties`, `app/google-services.json`, `.env.prod` are absent; `gradle.properties` is present.
  - `does not follow symlink outside root`: `link -> <outside dir with x.kt>` gives no `link/x.kt`.
  - `survives symlink loop`: `a/loop -> ..` terminates and lists `a/F.kt` once.
  - `readLines handles CRLF and BOM`: `'﻿one\r\ntwo\nthree'` gives `['one','two','three']`.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL (module not found).
- [ ] **Step 3: Implement `walk.js`** with an iterative DFS using `fs.readdirSync(dir, { withFileTypes: true })`.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(scan): add safe project file walker`

---

### Task 2: Catalog schema, loader, validator, and the first three dimensions

**Files:**
- Create: `skill/scripts/lib/catalog.js`, `skill/catalog/catalog.json`, `skill/catalog/dimensions/language.json`, `build.json`, `ui.json`
- Test: `test/catalog.test.js`

**Interfaces:**
- Produces:
  - `catalog.json`: `{ "schemaVersion": 1, "catalogVersion": "2026.11.0", "asOf": "2026-11-19", "dimensions": ["language", "build", "ui", ...] }`. The `dimensions` array orders the files to load (Task 3 appends to it).
  - Dimension file: `{ "id": string, "name": string, "entries": Entry[] }`
  - `Entry`: `{ id, name, era: integer>=1, status: "current"|"legacy"|"deprecated", since?: "YYYY"|"YYYY-MM", deprecatedSince?: same, successors: string[] (entry ids in the same dimension), prerequisites?: [{ dimension, anyOf: string[] }], detect: Detect, notes?: string }`
  - `Detect` (at least one key must be non-empty): `{ gradle?: [{ coord: "group:name" | "group:", minVersion?: "x.y" }], plugins?: string[], imports?: string[] (prefixes), files?: string[] (globs, supporting `**`, `*`), content?: [{ glob, regex }], manifest?: string[] }`
  - `loadCatalog(dir = <skill>/catalog): Catalog` returns `{ schemaVersion, catalogVersion, asOf, dimensions: Dimension[], entry(dimId, entryId): Entry | undefined }`. It throws `CatalogError` listing every validation error.
  - `validateCatalog(raw: { meta, dimensions }): string[]`
  - `SUPPORTED_SCHEMA_VERSION = 1`

- [ ] **Step 1: Write failing tests**
  - `loads shipped catalog`: `loadCatalog()` returns `catalogVersion === '2026.11.0'` and dimension ids include `language`, `build`, `ui`.
  - `rejects unknown schemaVersion`: meta `schemaVersion: 2` gives an error matching `/schemaVersion/`.
  - `rejects successor pointing to unknown id`, `rejects duplicate entry ids`, `rejects entry without detect signals`, `rejects successor cycle` (a→b→a), `rejects prerequisite to unknown dimension/entry`, `rejects bad status`. Each asserts one specific error substring.
  - `every shipped entry validates` (this test grows automatically in Task 3).

- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement `catalog.js`** (`JSON.parse` only; cycle check by DFS over `successors`).
- [ ] **Step 4: Author the three dimension files.** Entry ids are fixed here because later tasks and tests use them. Detect signals are the builder's call, following the spec's lists.
  - `language`: `java` (1), `java8-desugar` (2; gradle `com.android.tools:desugar_jdk_libs`), `kotlin` (3; plugins `org.jetbrains.kotlin.android`, `kotlin-android`; files `**/*.kt`), `kotlin-k2` (4; `detect: { "computed": true }`, evaluated in Task 7 from the Kotlin plugin/library version >= 2.0), `kmp` (5; plugin `org.jetbrains.kotlin.multiplatform`). Successors: java→java8-desugar→kotlin→kotlin-k2→kmp.
  - `build`: `ant-eclipse` (1; files `build.xml`, `project.properties`), `gradle-groovy` (2; files `**/build.gradle`), `buildsrc` (3; files `buildSrc/**`), `gradle-kts` (3; files `**/build.gradle.kts`), `version-catalog` (4; files `gradle/libs.versions.toml`), `convention-plugins` (5; files `build-logic/**`), `kapt` (2; plugins `kotlin-kapt`, `org.jetbrains.kotlin.kapt`), `ksp` (4; plugin `com.google.devtools.ksp`; prerequisite language anyOf `kotlin`,`kotlin-k2`,`kmp`).
  - `ui`: `xml-findviewbyid` (1; content `findViewById\(`), `butterknife` (2; gradle `com.jakewharton:butterknife`), `kotlin-synthetics` (2; imports `kotlinx.android.synthetic`), `databinding` (3; content in `**/build.gradle*` `dataBinding\s*(\{|=)\s*.*true|dataBinding\s*\{`), `viewbinding` (3; content `viewBinding\s*(=\s*true|\{|true)`), `compose` (4; imports `androidx.compose.`; prerequisite language anyOf kotlin/kotlin-k2/kmp), `compose-multiplatform` (5; plugin `org.jetbrains.compose`). Plus `xml-layouts` (1; files `**/res/layout*/*.xml`), which is used for the XML/Compose mix share.

- [ ] **Step 5: Run `npm test`.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(catalog): add catalog schema, validator and first dimensions`

---

### Task 3: Remaining catalog dimensions

**Files:**
- Create: `skill/catalog/dimensions/{presentation,navigation,async,di,networking,serialization,persistence,keyvalue,image,background,modularization,testing,static-analysis,compliance,build-performance}.json`
- Modify: `skill/catalog/catalog.json` (append the ids in that order)
- Test: `test/catalog.test.js` (add cases)

**Interfaces:**
- Produces these entry ids (tests and the guardrail depend on them). The detect signals are the builder's call.
  - `presentation`: `god-activity` (1), `mvp` (2; files `**/*Presenter.{java,kt}`, gradle `com.hannesdorfmann.mosby`, `com.github.moxy-community`), `mvvm-livedata` (3; imports `androidx.lifecycle.LiveData`), `mvvm-clean` (4; files `**/*UseCase.{kt,java}`, `**/*Interactor.{kt,java}`), `mvi` (4; gradle `org.orbit-mvi:`, `com.airbnb.android:mavericks`, `com.arkivanov.mvikotlin:`), `udf-stateflow` (5; content `MutableStateFlow<\w*UiState>`; prerequisite async anyOf `coroutines-flow`), `circuit-decompose` (6; gradle `com.slack.circuit:`, `com.arkivanov.decompose:`, `app.cash.molecule:`). Niche entries with status `legacy` and empty successors: `viper`, `ribs`, `square-workflow`. Successors: god-activity→mvp→mvvm-livedata→{mvvm-clean, udf-stateflow}, mvvm-clean→udf-stateflow, mvi→udf-stateflow, udf-stateflow→circuit-decompose.
  - `navigation`: `multi-activity`, `fragment-manual`, `cicerone-conductor`, `jetpack-nav-xml`, `nav-compose-string`, `nav-compose-typesafe` (gradle `androidx.navigation:navigation-compose` minVersion `2.8`), `navigation3`, `voyager`, `decompose-nav`.
  - `async`: `asynctask-loader`, `eventbus`, `rxjava1`, `rxjava2`, `rxjava3`, `coroutines-livedata`, `coroutines-flow` (prerequisite language anyOf kotlin/kotlin-k2/kmp).
  - `di`: `manual-servicelocator`, `dagger1`, `dagger2`, `dagger-android`, `koin`, `kodein`, `hilt`, `kotlin-inject`, `anvil`, `metro`.
  - `networking`: `httpurlconnection`, `apache-httpclient`, `volley`, `okhttp-retrofit`, `ktor-client`, `apollo`.
  - `serialization`: `gson`, `moshi`, `kotlinx-serialization`, `jackson`.
  - `persistence`: `sqliteopenhelper`, `contentprovider`, `ormlite`, `greendao`, `realm`, `room`, `sqldelight`, `sqlcipher`.
  - `keyvalue`: `sharedpreferences`, `encrypted-sharedpreferences`, `datastore` (prerequisite async anyOf coroutines-livedata/coroutines-flow), `mmkv`.
  - `image`: `uil`, `picasso`, `glide`, `fresco`, `coil`.
  - `background`: `service-alarmmanager`, `intentservice`, `jobscheduler`, `firebase-jobdispatcher`, `workmanager`.
  - `modularization`: `single-module`, `layer-modules`, `feature-modules`, `api-impl-modules`, `dynamic-features`, `polyrepo-aar`, `monorepo-convention`. Detection for this dimension comes from the module graph in Task 7. Entries carry `detect: { "computed": true }`, so the validator must accept `computed` as a signal.
  - `testing`: `instrumentation-robotium`, `junit4`, `mockito`, `espresso`, `mockk`, `turbine`, `robolectric`, `compose-ui-test`, `paparazzi`, `roborazzi`, `junit5`, `kotest`.
  - `static-analysis`: `android-lint`, `checkstyle`, `pmd`, `findbugs-spotbugs`, `ktlint`, `detekt`, `spotless`.
  - `compliance`: entries keyed by policy with `detect.computed: true` and a `policy` object `{ kind: "targetSdkMin", value: 35, effective: "2025-08-31" }`. Initial ids: `target-sdk-35`, `page-size-16kb`, `edge-to-edge`, `predictive-back`, `fgs-types`. M1 evaluates only `target-sdk-35`; the others are data-only until M4.
  - `build-performance`: `config-cache` (content in `gradle.properties` `org\.gradle\.configuration-cache=true`), `build-cache`, `non-transitive-r`, `parallel`, `kapt-free` (computed).

- [ ] **Step 1: Add failing tests**: `catalog has 18 dimensions in declared order`. Also `presentation successors form the documented chain` (asserts the exact successor arrays above), and `computed detect is accepted only on modularization, compliance, build-performance, language.kotlin-k2`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Author the 15 files** and extend the validator for `computed` and `policy`.
- [ ] **Step 4: Run `npm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(catalog): add remaining stack dimensions`

---

### Task 4: Gradle build file parser (Groovy and KTS, static, best effort)

**Files:**
- Create: `skill/scripts/lib/gradle.js`
- Test: `test/gradle.test.js`

**Interfaces:**
- Produces:
  - `parseBuildFile(text: string, kind: 'groovy'|'kts', ctx?: { ext?: Record<string,string>, versionCatalog?: VersionCatalog }): BuildFile`
  - `BuildFile = { plugins: [{ id, version: string|null, line }], dependencies: [{ configuration, group, name, version: string|null, unresolved: boolean, project?: string, alias?: string, line }], android: { namespace?, minSdk?: number, targetSdk?: number, compileSdk?: number, buildFeatures: { compose?, viewBinding?, dataBinding? } }, ext: Record<string,string> }`
  - `parseExtBlocks(text): Record<string,string>`: string literals from `ext { k = "v" }`, `ext.k = 'v'`, `extra["k"] = "v"`, and nested `ext.versions = [retrofit: '2.9.0']` flattened to `versions.retrofit`.

- [ ] **Step 1: Write failing tests**, each a small inline Gradle snippet:
  - `groovy string notation`: `implementation 'com.squareup.retrofit2:retrofit:2.9.0'` gives `{configuration:'implementation', group:'com.squareup.retrofit2', name:'retrofit', version:'2.9.0', unresolved:false, line:N}`.
  - `kts string notation`: `implementation("io.ktor:ktor-client-core:2.3.12")` parses the same way.
  - `map notation`: `implementation group: 'a', name: 'b', version: '1'`.
  - `project dependency`: `implementation(project(":core:data"))` gives `{project:':core:data'}`.
  - `ext interpolation resolved`: with `ext.retrofit_version = '2.9.0'`, `"com.squareup.retrofit2:retrofit:$retrofit_version"` gives version `'2.9.0'`. Same for `${rootProject.ext.versions.retrofit}` with nested ext.
  - `unresolved stays null` (Review Focus 1): `"x:y:${getVersion()}"` gives `version:null, unresolved:true`, and no throw.
  - `version catalog alias`: `implementation(libs.retrofit.core)` with a catalog that maps `retrofit-core` resolves group/name/version and sets `alias:'retrofit-core'`.
  - `plugins block`: `id("com.google.devtools.ksp") version "2.0.21-1.0.27"`, `alias(libs.plugins.hilt)`, and legacy `apply plugin: 'kotlin-kapt'` each yield the plugin ids.
  - `android block`: `minSdk 21` / `minSdk = 24` / `minSdkVersion 19`, `targetSdk 34`, `buildFeatures { compose true }` / `compose = true`.
  - `ignores commented-out lines`: `// implementation 'a:b:1'` and `/* ... */` blocks are skipped.
  - `bom without version`: `implementation(platform("androidx.compose:compose-bom:2024.10.00"))` then `implementation("androidx.compose.ui:ui")` gives `version:null, unresolved:false`.

- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement it as a line-oriented scanner.** First strip comments while keeping line numbers. Track `android {}` nesting by brace depth. Use regexes for the notations. Do not attempt a full Groovy/Kotlin grammar.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Commit** `feat(scan): add static gradle build file parser`

---

### Task 5: Version catalog (TOML subset) parser

**Files:**
- Create: `skill/scripts/lib/version-catalog.js`
- Test: `test/version-catalog.test.js`

**Interfaces:**
- Produces:
  - `parseVersionCatalog(text: string): VersionCatalog`
  - `VersionCatalog = { versions: Record<string,string>, libraries: Record<string, { group, name, version: string|null }>, plugins: Record<string, { id, version: string|null }> }`. Keys are normalized: `-`, `_` and `.` are all mapped to `-`, so `libs.retrofit.core` matches the key `retrofit-core` or `retrofit_core`.
  - `resolveAlias(vc, accessor: 'libs.retrofit.core'|'libs.plugins.hilt'): {kind:'library'|'plugin', ...} | null`

- [ ] **Step 1: Write failing tests**: `[versions]` with string values; library forms `"g:n:v"`, `{ module = "g:n", version.ref = "x" }`, `{ group = "g", name = "n", version = "1" }`, and `{ module = "g:n" }` (no version, so null); plugin forms `{ id = "p", version.ref = "x" }`; `[bundles]` ignored; comments and blank lines ignored; an unknown `version.ref` gives `version:null`; `resolveAlias(vc,'libs.retrofit.core')` resolves an underscore key.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement it** with a line parser for `[section]` headers and `key = value`, where value is a string or a single-line inline table. Multi-line arrays are out of scope (skipped with no error).
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Commit** `feat(scan): add version catalog parser`

---

### Task 6: Fixtures, settings parsing, module discovery and graph

**Files:**
- Create: `skill/scripts/lib/modules.js`, `test/modules.test.js`
- Create fixtures (minimal but realistic. Source files only need the imports and the class declarations the detectors look for):
  - `test/fixtures/legacy-java-mvp/`: `settings.gradle` (`include ':app'`), root `build.gradle` with `ext { retrofit_version = '2.3.0' }` and `buildscript` classpath AGP 3.x. `app/build.gradle`: minSdk 19, targetSdk 28, deps butterknife, rxjava2 + rxandroid, dagger 2 + `annotationProcessor`, retrofit 2 + gson, `com.github.bumptech.glide:glide`, junit4 + mockito + espresso. `app/src/main/java/com/example/legacy/`: `LoginActivity.java` (`findViewById(`, implements `LoginContract.View`), `LoginPresenter.java`, `LoginContract.java`, `UserDbHelper.java` (`extends SQLiteOpenHelper`), `SyncTask.java` (`extends AsyncTask`). `res/layout/activity_login.xml`, `res/layout/item_user.xml`.
  - `test/fixtures/modern-compose/`: `settings.gradle.kts` (`include(":app", ":core:data")` on one line and `include(":feature:home")` on another). `gradle/libs.versions.toml` (kotlin 2.0.21, compose-bom, hilt, room, retrofit, kotlinx-serialization, coil, navigation-compose 2.8.4, ksp). `build-logic/convention/build.gradle.kts`. Module build files use `alias(libs.plugins.*)`. Kotlin sources: `HomeScreen.kt` (`import androidx.compose.`), `HomeViewModel.kt` (`MutableStateFlow<HomeUiState>`, `import kotlinx.coroutines.flow.`), `GetUserUseCase.kt`, `UserDao.kt` (`import androidx.room.`), `HomeViewModelTest.kt` (`import app.cash.turbine.`, `import io.mockk.`). `gradle.properties` with `org.gradle.configuration-cache=true`. targetSdk 35, minSdk 24.
  - `test/fixtures/mixed/`: `settings.gradle` with `include ':app', ':legacy'` and `project(':legacy').projectDir = file('libs/legacy')`. Kotlin + Java. 3 XML layouts and 2 Compose files. LiveData in one ViewModel, StateFlow in another. Koin. `SharedPreferences` usage and `androidx.datastore` usage.
  - `test/fixtures/single-module-no-settings/`: only `build.gradle` + `src/main/java/A.java` (Review Focus 2).

**Interfaces:**
- Consumes: `listFiles`, `readLines` (Task 1); `parseBuildFile` (Task 4); `parseVersionCatalog` (Task 5)
- Produces:
  - `parseSettings(text, kind): { includes: string[], projectDirs: Record<string,string> }`
  - `discoverModules(root: string, files: string[]): Module[]`, where `Module = { path: ':app', dir: 'app', buildFile: 'app/build.gradle.kts'|null, kind, build: BuildFile, projectDeps: string[] }`. Without settings, the root dir is the single module `':'`. `ext` from the root build file feeds each module's parse context, and so does `gradle/libs.versions.toml` when present.
  - `moduleGraph(modules): { nodes: string[], edges: [from, to][] }`

- [ ] **Step 1: Write failing tests**
  - `multi-include line`: modern-compose modules are `[':app', ':core:data', ':feature:home']` (sorted), and `':core:data'` has dir `core/data`.
  - `projectDir override`: mixed `':legacy'` has dir `libs/legacy`.
  - `no settings = single root module` gives `[':']`.
  - `project deps become edges`: modern `':app'` → `':feature:home'`, and `':feature:home'` → `':core:data'`.
  - `root ext feeds module parse`: the legacy retrofit version resolves to `'2.3.0'`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement `modules.js`.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Commit** `feat(scan): add fixtures and module discovery`

---

### Task 7: Stack detection, `scan.js`, and the profile report

**Files:**
- Create: `skill/scripts/lib/detect.js`, `skill/scripts/lib/glob.js`, `skill/scripts/lib/report.js`, `skill/scripts/scan.js`
- Test: `test/detect.test.js`, `test/scan-cli.test.js`

**Interfaces:**
- Consumes: Tasks 1, 2/3, 4, 5, 6
- Produces:
  - `globToRegExp(glob): RegExp` (supports `**/`, `*`, `{a,b}`)
  - `detectStack(root: string, catalog: Catalog): StackProfile`
  - `StackProfile = { schemaVersion: 1, catalogVersion, root: '.', sdk: { minSdk, targetSdk, compileSdk } (min of minSdk, max of targetSdk across modules), size: { files, sourceFiles, kotlinFiles, javaFiles, xmlLayouts, loc }, modules: [{ path, dir, projectDeps }], dimensions: Record<dimId, { entries: [{ id, share, units, evidence: [{ file, line, signal }] }] }>, compliance: [{ id, status: 'ok'|'gap', detail }] }`
  - Share rule (spec 5.4 "mixes as percentages"): for each dimension, a **unit** is a source file for `imports`/`content`/`files` signals and a module for `gradle`/`plugins` signals. `units(entry)` counts the units that match the entry. `share = units / sum(units over entries in that dimension)`, rounded to 2 decimals. Entries with 0 units are omitted. At most 5 evidence items per entry.
  - Computed detections: `modularization` from the module graph (1 module = `single-module`; modules named `data|domain|presentation` = `layer-modules`; a `feature` path segment = `feature-modules`; `:api`/`:impl` pairs = `api-impl-modules`). `language.kotlin-k2`: when the Kotlin plugin/library version is >= 2.0. `compliance.target-sdk-35`: `gap` when the max targetSdk is < 35. `build-performance.kapt-free`: when no module applies kapt.
  - `renderProfileMarkdown(profile): string`: one section per dimension with `- <entry name>: <share as %> (evidence: file:line, ...)`.
  - CLI: `node skill/scripts/scan.js <projectRoot> [--format json|md] [--out <file>]`. Default format `json`, to stdout. Exit 2 when the root has no Gradle or Ant build file, with the stderr message `not an Android/Gradle project: <root>`.

- [ ] **Step 1: Write failing tests (`detect.test.js`)**
  - legacy-java-mvp: `language` = `[{id:'java', share:1}]`. `presentation` contains `mvp`. `ui` contains `butterknife`, `xml-findviewbyid`, `xml-layouts`. `async` contains `rxjava2` and `asynctask-loader`. `di` contains `dagger2`. `persistence` contains `sqliteopenhelper`. `networking` contains `okhttp-retrofit`. `serialization` contains `gson`. `modularization` = `single-module`. `sdk.targetSdk === 28`. `compliance` has `{id:'target-sdk-35', status:'gap'}`.
  - modern-compose: `language` contains `kotlin-k2`. `build` contains `gradle-kts`, `version-catalog`, `convention-plugins`, `ksp`. `presentation` contains `udf-stateflow` and `mvvm-clean`. `ui` contains `compose`. `di` contains `hilt`. `persistence` contains `room`. `navigation` contains `nav-compose-typesafe`. `testing` contains `mockk`, `turbine`. `modularization` contains `feature-modules`. `build-performance` contains `config-cache`, `kapt-free`. `target-sdk-35` is `ok`.
  - mixed: the `ui` entries are exactly `[{id:'xml-layouts', share:0.6}, {id:'compose', share:0.4}]` (comparing ids and shares only). The fixture deliberately has no `findViewById`, viewBinding or dataBinding, so these are the only UI units. `presentation` contains both `mvvm-livedata` and `udf-stateflow`. `keyvalue` contains `sharedpreferences` and `datastore`.
  - `evidence line numbers are 1-based and survive CRLF` (Review Focus 4): copy one fixture file to a temp dir with CRLF + BOM, and the import on line 3 reports `line: 3`.
- [ ] **Step 2: Write failing tests (`scan-cli.test.js`)**: run with `execFileSync(process.execPath, ['--import', noNetwork, scanPath, fixture])`, parse the JSON, assert `schemaVersion === 1`. `--format md` output contains `## UI`. A non-Gradle temp dir gives exit 2 with the message.
- [ ] **Step 3: Run, confirm FAIL.**
- [ ] **Step 4: Implement** `glob.js`, `detect.js`, `report.js`, `scan.js`.
- [ ] **Step 5: Run, confirm PASS.**
- [ ] **Step 6: Commit** `feat(scan): detect stack profile per catalog dimension`

---

### Task 8: Candidate paths and the recommendation guardrail

**Files:**
- Create: `skill/scripts/lib/candidates.js`, `skill/scripts/lib/guardrail.js`, `skill/scripts/candidates.js`, `skill/scripts/recommend-check.js`, `skill/catalog/recommendations.schema.md` (prose description of the format, for the agent)
- Test: `test/candidates.test.js`, `test/guardrail.test.js`

**Interfaces:**
- Consumes: `Catalog` (Task 2), `StackProfile` (Task 7)
- Produces:
  - `candidatePaths(profile, catalog): Record<dimId, { current: string[] (ids with share>0, by share desc), next: string[] (union of direct successors of current, minus current), reachable: string[] (transitive successors), blockedBy: Record<entryId, {dimension, anyOf}[]> (unmet prerequisites) }>`
  - `Recommendations = { schemaVersion: 1, catalogVersion, generatedAt, dimensions: [{ dimension, current: string[], target: string|null, label: 'must'|'should'|'later'|'dont', rationale: string }], steps: [{ id, dimension, from: string|null, to: string, dependsOn: string[], justification?: string, tags?: ('irreversible'|'decision')[] }] }`
  - `checkRecommendations(recs, catalog, profile): { ok: boolean, violations: [{ step?: string, dimension?: string, rule: 'R1-hop'|'R2-prereq'|'R3-order'|'R4-unknown-id'|'R5-shape', message }] }`
    - **R1-hop:** `to` must be a direct successor of `from`. If it is only transitively reachable, then `justification` must be at least 20 characters, otherwise it is a violation. If it is unreachable, it is always a violation. When `from === null`, `to` must have status `current`.
    - **R2-prereq:** every prerequisite of `to` must already be present in the profile (share > 0), or be the `to` of a step listed in `dependsOn` (directly or transitively).
    - **R3-order:** `dependsOn` ids exist and point to steps earlier in the array, with no cycles.
    - **R4-unknown-id:** dimension or entry ids that don't exist in the catalog.
    - **R5-shape:** a missing field, a bad label, or a `catalogVersion` different from the loaded catalog.
  - CLIs: `node skill/scripts/candidates.js <projectRoot>` prints JSON. `node skill/scripts/recommend-check.js <recommendations.json> --profile <profile.json>` prints violations as JSON and exits 1 when `ok` is false, 0 otherwise.

- [ ] **Step 1: Write failing tests**
  - `candidates for legacy`: `presentation.current` = `['mvp']` and `next` contains `mvvm-livedata`. `ui.blockedBy.compose` names the language prerequisite, because the project is Java-only. `blockedBy` covers every entry in `reachable`.
  - `R1 rejects jump to latest`: legacy step `presentation mvp → circuit-decompose` with no justification gives `R1-hop`.
  - `R1 allows justified multi-hop`: `mvp → udf-stateflow` with a 40-char justification gives no R1 violation.
  - `R2 requires kotlin before compose`: the step `ui xml-findviewbyid → compose` on legacy without a language step gives `R2-prereq`. Adding step `lang1 java → java8-desugar`, `lang2 java8-desugar → kotlin`, and `dependsOn:['lang2']` makes it pass.
  - `R3 rejects forward dependsOn`, `R4 rejects unknown entry`, `R5 rejects wrong catalogVersion and bad label`.
  - `recommend-check CLI exit codes` are 1 and 0 on the fixtures above.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Commit** `feat(recommend): add candidate paths and recommendation guardrail`

---

### Task 9: CLI: install, uninstall, doctor, version

**Files:**
- Create: `bin/cli.js` (shebang `#!/usr/bin/env node`, executable bit), `skill/scripts/lib/install.js`
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `loadCatalog` (Task 2)
- Produces:
  - `install({ home, claude?: boolean, codex?: boolean, sourceDir }): { installed: string[] }`. Targets are `<home>/.claude/skills/android-architect` and `<home>/.codex/skills/android-architect`. With neither flag, install to every harness whose base dir (`<home>/.claude` / `<home>/.codex`) exists. If neither exists, throw `NoHarnessError` with a message saying to pass `--claude` or `--codex`. An explicit flag creates missing dirs. Each install **removes the existing target dir first**, then `fs.cpSync(sourceDir, target, { recursive: true })`, then writes `.installed.json` `{ version, catalogVersion, installedAt }`.
  - `uninstall({ home })`: removes both targets if present.
  - `doctor({ home }): { node, harnesses: [{ name, installed: boolean, version?, catalogVersion? }], optional: { graphify: boolean } }`. graphify is present when `<home>/.claude/skills/graphify` or `<home>/.codex/skills/graphify` exists.
  - CLI: `android-architect install|uninstall|doctor|version [--claude] [--codex] [--home <dir>]`. `--home` defaults to `os.homedir()` and exists for tests. `version` prints `android-architect <pkg version> (catalog <catalogVersion>)`. Unknown commands print usage and exit 1.

- [ ] **Step 1: Write failing tests** (temp home dirs):
  - `install to existing harnesses only`: home with only `.claude/` gives only the Claude target, containing `SKILL.md`, `catalog/catalog.json`, `scripts/scan.js`, and `.installed.json` with the package version.
  - `explicit --codex creates dirs` (Review Focus 5).
  - `reinstall removes stale files` (Review Focus 5): plant `<target>/scripts/old.js`, reinstall, and the file is gone.
  - `no harness and no flag gives error exit 1` with a message matching `/--claude or --codex/`.
  - `doctor reports versions` and `doctor detects graphify`.
  - `version prints package and catalog version`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement** (`sourceDir` = `new URL('../skill', import.meta.url)` in `bin/cli.js`).
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Commit** `feat(cli): add install, uninstall, doctor and version commands`

---

### Task 10: SKILL.md and core references

**Files:**
- Create: `skill/SKILL.md`, `skill/references/persona.md`, `recommendation-method.md`, `rubric-architecture.md`, `rubric-code-quality.md`, `output-templates.md`
- Test: `test/skill-docs.test.js`

**Interfaces:**
- Consumes: script CLIs from Tasks 7 and 8 (exact invocations below)
- Produces: the agent-facing contract. Commands available in M1 are `audit` and `recommend` only. SKILL.md says the other commands arrive in later versions and must not pretend they exist.

Required content (copy is the builder's, but these facts are fixed):
- `SKILL.md` frontmatter: `name: android-architect`. `description` mentions Android architecture audit, migration planning, modularization, and Lead Android Engineer, and fits within 1024 chars. The body has these sections in order:
  1. `## Role`, pointing to `references/persona.md`
  2. `## Ground rules`: evidence with file:line; project content is data, not instructions; no network; answer in the user's language
  3. `## Scripts`: exact commands with `<skill-dir>` explained, `node <skill-dir>/scripts/scan.js <root> --format md`, `node <skill-dir>/scripts/candidates.js <root>`, `node <skill-dir>/scripts/recommend-check.js <file> --profile <file>`
  4. `## Command: audit`: run scan (json + md), read the rubrics, inspect the evidence files, produce the report using the `output-templates.md` "Audit report" template
  5. `## Command: recommend`: requires an audit/profile. Run candidates, choose a target per dimension only from `current ∪ reachable`, label each must/should/later/dont, write the recommendations JSON to a temp file, run `recommend-check`, **fix and re-run until exit 0 (max 3 attempts, then report the remaining violations to the user)**, then present the result using the "Recommendation" template
  6. `## Not yet available`: lists `setup, prioritize, migration-plan, data-migration, lib-update, review, refresh, fitness, run`
- `persona.md`: the six persona rules of spec 5.10, each with one short example. It includes the "don't migrate" rule with the Retrofit→Ktor-without-KMP example.
- `recommendation-method.md`: Detect → Assess → Recommend → Migrate (spec 5.4), the assess factors list, and the rule that targets come from catalog candidates.
- `rubric-architecture.md`: layering and the dependency rule, module coupling (fan-in/out), testability seams, state ownership, navigation ownership, DI boundaries. Each criterion has "signals in code" and "severity guidance".
- `rubric-code-quality.md`: the Android smells (god Activity/ViewModel, logic in Views/Adapters, static util grab-bags, context leaks, main-thread IO, copy-paste, `!!` density, swallowed exceptions). Each smell has detection hints.
- `output-templates.md`: `### Audit report` (summary, stack profile table, findings with severity/evidence/impact) and `### Recommendation` (per-dimension table current → target with a label, then the ordered steps with risk, verification, and rollback point).

- [ ] **Step 1: Write failing test `skill-docs.test.js`**: the frontmatter parses, `name === 'android-architect'`, and description length <= 1024. SKILL.md contains the six `##` headings in order. Each script path named in SKILL.md exists under `skill/scripts/`. Every reference file linked from SKILL.md exists. No file under `skill/` contains `TODO` or `TBD`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Commit** `docs(skill): add SKILL.md, persona, method, rubrics and templates`

---

### Task 11: Package end-to-end check and README

**Files:**
- Modify: `README.md` (install, `doctor`, using `audit`/`recommend` in Claude Code and Codex, supported setups, **No telemetry**, pinned `npx android-architect@<version>`), `CHANGELOG.md` (0.1.0 entries)
- Test: `test/e2e.test.js`

**Interfaces:**
- Consumes: everything above

- [ ] **Step 1: Write failing test `e2e.test.js`**
  - `npm pack --dry-run --json` (via `execFileSync('npm', ...)`; it only lists files, with no network) includes `bin/cli.js`, `skill/SKILL.md`, and `skill/catalog/catalog.json`, and excludes `test/` and `docs/`.
  - Install into a temp home, then run the **installed** `scripts/scan.js` on each fixture under the no-network import. All three exit 0 with valid JSON.
  - README contains the headings `## Install`, `## Usage`, `## Supported setups`, `## No telemetry`.
- [ ] **Step 2: Run, confirm FAIL** (README headings).
- [ ] **Step 3: Write README and CHANGELOG.**
- [ ] **Step 4: Run full `npm test`.** Expected: all pass.
- [ ] **Step 5: Manual smoke test** (read-only): `node skill/scripts/scan.js <a real local Android project> --format md`. Check that the profile looks plausible and record the observations in the (untracked) task report, never in tracked files. Triage detection gaps for follow-up.
- [ ] **Step 6: Commit** `docs: add README and changelog for 0.1.0`
