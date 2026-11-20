# Library updates

How to read the output of `scripts/lib-update.js` and how to carry out a library update plan safely. The tool only plans: it reads the project, prints a plan and never edits a build file.

```
node scripts/lib-update.js <projectRoot> [--scope <module-path>] [--format json|md] [--out <file>]
```

## What the plan contains

- Groups of dependency declarations, in the order described below. Each item names the library coordinate, the module, the build file and line of the declaration, the current version, the target version, the kind of jump and whether the target needs verification.
- `cannotUpdate`: declarations the tool refuses to guess about. These have no target, by design.
- Notes about the data behind the plan: whether it is verified and how old it is.

A target is only ever taken from `catalog/versions.json`, and only when it is newer than the version in the project. The file is maintained by hand. It is not a feed and it does not claim that a version is the latest release. Treat a target as "a version the maintainers believed was a good stable choice on the `asOf` date", then check it against the library's own release notes.

## Group order and why

1. **Security.** Every declaration whose current version is covered by a known advisory, highest severity first. These come first because the risk is present today and a fix is usually a small, targeted bump. Do them as separate changes so each can be released or reverted on its own.
2. **Patch and minor updates, one group per update group.** An update group holds libraries that are released and tested together (for example the AndroidX lifecycle artifacts, or OkHttp and its interceptors). Update a whole group in one change: a partial update leaves a mix of versions that was never released together. Groups are sorted by name, items by coordinate; the order carries no priority between groups, so pick the order by risk and by what your tests cover.
3. **Major updates, last.** A major version may change behavior or remove API. Each major item lists what the library requires (see below) and the plan prints those requirements as prerequisites before the items. Meet the prerequisites first, as separate earlier steps, then update the library alone.

Partial update rules:

- Never combine a security fix with a major migration in one change. If the only fixed version is a major jump, do the migration as its own step and keep the change reviewable.
- Update the artifacts of one library together, and keep their versions equal when the library publishes them in lockstep.
- Build and run the tests after every group. Stop at the first failure and fix or revert before the next group.
- Do not hide a failing update by pinning a transitive dependency without writing down why and when to remove the pin.

## Reading `verify`

`verify: true` means "do not trust this target without checking it". It is set when:

- the data in `versions.json` is older than 90 days at planning time (every item is then marked), or
- the item is a major jump for a library that has no advisory data in the catalog, so nothing else supports the choice.

Verify by opening the library's release notes or changelog, confirming the target exists and is stable, and reading the migration notes for every version you skip. A target with `verify: false` still deserves a build and a test run; it only means the plan has no specific reason for doubt.

## Reading `cannotUpdate`

A declaration lands here, without a target, when:

- the version is dynamic (`2.+`, `latest.release`, a range) or unresolved, so the tool cannot know what is actually used;
- no version is declared, because a BOM, platform or plugin manages it;
- a version-catalog alias or bundle could not be resolved to coordinates;
- the coordinate is not in `versions.json`.

For these, check the real resolved version (a dependency report from your build) and decide by hand. For a dynamic version on a library with advisories, the tool cannot tell whether the resolved version is affected, so it never reports it as safe.

## Treating a security update

- The advisory is the reason; the version in the plan is a suggestion. Open the advisory source named in the item and confirm the fixed version and the affected range.
- A security item with `target: null` has no fixed version known to the data. Check the advisory source for a fixed release, or for a mitigation if none exists, and decide whether to update, replace the library or mitigate.
- After the bump, confirm the resolved version in the dependency report, not only the declared one. A transitive constraint can keep an old version in place.
- Record the change and the advisory id in the commit message so the reason survives.

## Compatibility matrices

Libraries and tools depend on each other. A plan item's `requires` field states what its target needs, using these keys:

- `kotlin`: a minimum Kotlin language or compiler version, such as `>=1.9`.
- `agp`: a minimum Android Gradle Plugin version.
- `minSdk`: the minimum `minSdk` the target supports.

The tool prints these requirements but does not compare them with your project. Check them yourself, and consult the official compatibility documentation, never a table copied from a blog:

- **Kotlin and the Kotlin Gradle plugin.** Libraries are built against a Kotlin version and generally need a compiler at least that new. Metadata from a much newer Kotlin can be unreadable by an older compiler.
- **AGP and Gradle.** Each AGP version supports a range of Gradle versions and a range of JDK versions. The AGP release notes list them. A newer AndroidX library can also require a newer `compileSdk` and so a newer AGP.
- **Compose compiler and Kotlin.** The Compose compiler is tied to the Kotlin version: either through a version table published by the Compose team (older setups) or because the compiler ships as a Kotlin plugin released with Kotlin itself (newer setups). Update Kotlin and the Compose compiler together, then the Compose BOM.
- **KSP and Kotlin.** A KSP release is built for one Kotlin version, and its version string says which. Annotation processors that run on KSP (such as Room's compiler) must be updated with it.
- **Annotation processors and kapt.** Check that the processor supports the Kotlin version and the JDK you build with.

Order for a toolchain update that touches several of these: Gradle wrapper, AGP, Kotlin, KSP, Compose compiler, then libraries. Check each against its official compatibility page before moving on.

## Do not

- Do not edit build files from this plan without reviewing each item.
- Do not treat the absence of an item as proof that a dependency is current or safe: coordinates missing from the data and dynamic versions are reported separately in `cannotUpdate`.
- Do not describe a target as "the latest version". The data is unverified unless it says otherwise.
