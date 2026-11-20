# Architecture fitness checks

An accepted ADR can carry machine-checkable rules in its front matter. `scripts/fitness.js` turns those rules into a
static check and into generated files that a team reviews and then adds to its build. The generated files never change
the build on their own: a person reviews them and copies or applies them.

## Writing rules

Rules live in the `fitness` list of an ADR in `.ai/knowledge/adr/`:

```
---
id: "0007"
title: Feature modules stay independent
status: accepted
date: 2026-11-20
fitness:
  - "module-no-dep: :feature:* -> :feature:*"
  - "package-no-import: com.example.ui.** -> com.example.data.db."
---
```

Only ADRs with `status: accepted` contribute rules. A `proposed`, `rejected` or `superseded` ADR that has rules
produces a note and no rule, so a decision that is not yet agreed never fails a build.

Two rule kinds exist. Each rule is one string, `<kind>: <from> -> <to>`:

- `module-no-dep: <fromGlob> -> <toGlob>`: no module whose Gradle path matches `fromGlob` may declare a project
  dependency on a module matching `toGlob`. A module depending on itself never counts, so
  `:feature:* -> :feature:*` means "no feature module depends on another feature module".
- `package-no-import: <packageGlob> -> <importPrefix>`: no Kotlin or Java file whose `package` matches `packageGlob`
  may import a name that starts with `importPrefix`. A trailing `.*` on the prefix is the same as the bare prefix
  ending in a dot (`com.example.data.*` is `com.example.data.`). A wildcard import such as `import com.example.data.db.*`
  matches by the same prefix test.

### Glob grammar

Module globs are `:`-separated and start with `:` (`:feature:login`). Package globs are `.`-separated
(`com.example.ui.login`). Both use the same small grammar:

- A segment is literal text with at most one `*`, which matches any run of characters inside that one segment.
  `:feature:*` matches `:feature:login` but not `:feature:login:impl`.
- `**` may appear once, as the whole first segment (zero or more segments before the rest: `:**:data` matches
  `:data` and `:core:data`) or as the whole last segment (one or more segments after the rest: `:feature:**` matches
  `:feature:login:impl` but not `:feature` itself).
- At most two `*` in one glob (`**` counts as one). No `?`, braces, classes or empty segments.
- The root module `:` and the default (empty) package never match.

### Limits and validation

- At most 20 rules per ADR; an ADR with more contributes no rule at all.
- At most 200 characters per rule.
- Values use only `A-Z a-z 0-9 _ . : - / *`, separated by the literal ` -> `. Module globs additionally exclude `/`;
  package globs and import prefixes use only letters, digits, `_`, `.` and `*`.
- A rule that looks like a secret to the redaction rules is rejected.

Every invalid rule is reported as `<adr file>: rule "<n>": <reason>` (n counts from 1) and the run exits with code 1
before anything is generated. Rules are never dropped silently, and the reason never repeats the rejected text.

## The script

`node <skill-dir>/scripts/fitness.js <projectRoot> [--check] [--out <dir>]`

- Without `--check`: prints the rules found as JSON and writes the generated files into `<projectRoot>/.ai/fitness/`
  through the same guarded writer as init (the `.ai` folder must exist, symlinks are refused, every text is redacted).
  With `--out <dir>` the files go to that directory instead, which must be outside the project.
- With `--check`: evaluates the rules statically and prints JSON with `ok`, `violations` (`rule`, `from`, `to`, `file`,
  `line`), `notes`, `skippedFiles` and `truncatedFiles`. Module rules use the declared `project(...)` dependencies of
  each build file, with the build file and line as evidence. Package rules read the `package` and `import` lines of
  Kotlin and Java sources that git does not ignore. Only the first 1 MB of a larger file is read (package and imports
  sit at the top); such files are counted in `truncatedFiles`, unreadable ones in `skippedFiles`.
- In a workspace member repo the ADRs live in the hub: fitness.js prints a note to run it from the hub, evaluates and
  generates nothing, writes nothing, and exits 0 (in both modes).

How package rules read sources, and where that is approximate:

- Lines are read one by one. Block comments, triple-quoted strings, string and char literals and line comments are
  skipped with a simple linear state, so a `package` or `import` inside a comment is ignored.
- Nested Kotlin block comments are treated as ending at the first closing marker, and a string spanning lines with
  escapes is not tracked beyond its line.
- The first `package` line counts; every `import` line counts, wherever it appears outside comments and strings.
- Names are compared as text: a package glob against the declared package, an import prefix against the imported
  name. Type aliases, star imports of classes and fully qualified names in code are not resolved.

Exit codes: 0 success (and, with `--check`, no violation); 1 usage error, invalid ADR or rule, refused write, or
violations found by `--check`; 2 not a Gradle project, or no `.ai` folder (init has not been run).

`.ai/fitness/` is generated: fitness.js rewrites it on every run (and removes the files of its own that a run no longer
produces), while init and refresh leave it alone and never delete it. Before the first write every target is checked:
a symlink, a directory, a FIFO or any other non-regular file where a generated file goes is refused, and nothing is
written. Generated files are not meant to be edited by hand: change the ADR and regenerate. Its files are scanned for planted instructions like the other generated text in `.ai`.

## Generated files

- `architecture-fitness.gradle.kts` (only when there is at least one `module-no-dep` rule): a root-project script with
  one task, `architectureFitness`. The task reads the declared project dependencies of every project
  (`ProjectDependency.path`) and fails the build with one line per forbidden dependency. When the root project applies
  the `base` plugin, `check` depends on it. The task starts no process and reads no network. It needs Gradle 8.11 or
  newer and does not support the configuration cache.
- `ArchitectureFitnessTest.kt` (only when there is at least one rule, because a JUnit class without tests fails): a
  Konsist unit test. Package rules check imports directly; module rules compare the
  imports of each matching module with the packages declared in the forbidden modules (module directories are taken
  from the Gradle settings when the file is generated). The header lists the Konsist calls it relies on; check them
  against the Konsist version in use.
- `verify-commands.json`: the verification commands of the generated checks, for the agent loop:
  `./gradlew architectureFitness` when the Gradle script was generated, and the Konsist test command when the Konsist
  test was generated. With no generated check the list is empty (`{ "schemaVersion": 1, "commands": [] }`); the file is
  always written so its shape stays stable. It holds fixed strings only, no project-derived text.
- `README.md`: the rule table and how to apply the files.

## Safety rules

ADR text and module paths come from the repository, so fitness.js treats them as untrusted:

- Rules are validated before use. Matching is linear: no regular expression is ever built from rule text, and a glob
  outside the grammar is refused rather than interpreted.
- Every value emitted into generated code goes through one escaper. It refuses anything outside
  `A-Z a-z 0-9 _ . : - / *`, which keeps quotes, `$`, backslashes, whitespace, line breaks, Unicode separators and
  direction controls out of generated code, and still escapes `\`, `"`, `$` and line breaks as a second line of defense.
- Rule ids and ADR file names in comments are reduced to letters, digits, `_`, `.` and `-` and shortened, so they cannot
  close a comment or start a new line of code.
- A module whose path or directory uses other characters is skipped with a note and appears in no generated file.
- Nothing generated starts a process or reads the network.

## Why detekt is not generated

Version 1 generates no detekt configuration. Detekt rules about imports and packages need either a custom rule set
(compiled code the team would have to build and maintain) or the generic forbidden-import rule, which works on import
patterns without the module context the module rules need. A Gradle task and a Konsist test cover both rule kinds
with small, reviewable sources. Teams that already use detekt can express a package rule as a forbidden import by hand.

## Applying the files

1. Review each generated file like any other build change.
2. Gradle task: add `apply(from = ".ai/fitness/architecture-fitness.gradle.kts")` to the root `build.gradle.kts`, or
   copy the script into the project (for example `gradle/`) and apply the copy, so later regeneration is a reviewed
   change.
3. Konsist test: copy `ArchitectureFitnessTest.kt` into a unit test source set, add a package line that matches its
   folder, and add the Konsist test dependency.
4. After changing a fitness rule or the module list, regenerate the files and review the difference before copying it.
