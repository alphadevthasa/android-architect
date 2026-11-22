# Contributing

Thanks for helping. The package has zero dependencies and no install scripts; please keep it that way. Everything (code, docs, comments) is in English and generic: no employer or private project names.

```
npm test        # all tests, network blocked, includes the eval suite and the release policy
npm run eval    # only the eval suite
```

## Add a dimension entry

Entries live in `skill/catalog/dimensions/<dimension>.json`. Add an object to `entries` with `id`, `name`, `era`, `status` (`current`, `legacy` or `deprecated`), `since`, `successors` (ids in the same catalog, a direct step only), `detect` signals (Gradle coordinates, imports, file globs) and, where relevant, `prerequisites` and `vulnerableVersions`. `successors` must be entries of the same dimension. There is no entry-level `verified` flag: unverified data is marked at dimension level with `verified: false` and `dataNote` (see `compliance.json`). Playbooks carry `verified: false` in their front matter. Then bump the catalog version (see below), update goldens if detection changed, and run `npm test`.

## Add a playbook

Playbooks are `skill/catalog/playbooks/<from>--to--<to>.md`, with `from` and `to` entries of the same dimension and `to` reachable through `successors`. Read `skill/catalog/playbooks/README.md` and copy `_example-seam.md`: strict front matter, the fixed headings in order, and a Security checklist of at least two items.

**Safe-ordering rule for irreversible playbooks (on-device data moves):** back up first, keep a single writer, copy behind a write gate, verify, and only then delete the old store. The old store is never deleted before verification, and the playbook is tagged `irreversible`. Playbooks start as `verified: false`. Add a fixture test in `test/playbooks.test.js`, and check `test/playbook-content.test.js`: it has per-id expectation tables and batch lists a new playbook may need to join.

## Change catalog data

- `skill/catalog/catalog.json` `catalogVersion` is `YYYY.MM.N` by convention (not enforced by code): bump `N` for any data change in the same month, reset `N` when the month changes, and update `asOf`.
- After a bump, re-record goldens (`node dev/record-eval.mjs <name> --force`, then `node dev/record-eval.mjs --update-recs`) and review the whole diff.
- Version numbers, policy dates, CVE ranges and default agent flags written from memory stay `verified: false` until someone checks them against the primary source and records the source link. Never mark data verified without that check (dimension-level `verified`, or `verified:` in playbook front matter).
- Add a CHANGELOG line under the unreleased heading for every data change.

## Run the eval suite

`npm run eval` runs `test/eval/eval.test.js`: golden profiles, candidate paths, guardrail rules and pinned real apps (if checked out). See `test/eval/README.md` for the format and how to add an app. It is deterministic and offline.

### If timing tests fail on a loaded machine

A few tests are timing-sensitive (the agent output flood and grandchild-kill tests, the 1 MB worst-case glob test, and the 1 MB linear-time redaction and reuse tests). On a machine under heavy load they can fail in a full `npm test` and pass alone. Re-run the failing files by themselves (for example `node --test --import ./test/helpers/no-network.mjs test/agent.test.js`), and run a clean `npm test` on a quiet machine before publishing. Thresholds are deliberately not loosened.

## CI and policy tests

`.github/workflows/ci.yml` runs `npm test` (which includes the eval suite and the package policy) on Node 20 and 22 on Linux and one macOS job, with read-only permissions. `test/release-policy.test.js` checks the package contents and size budget, and parses both workflows (permissions, triggers, token scope, provenance, pinned actions). Change a workflow and the policy together, and keep its negative tests green.

## Cut a release

Releases are published only by `.github/workflows/release.yml`, from a version tag, with npm provenance.

1. Update `version` in `package.json` and the `CHANGELOG.md` heading together; merge to `main` through a reviewed pull request. Only plain `X.Y.Z` versions are released: pre-release tags such as `1.2.3-rc` are refused by design.
2. Run `npm test` locally (it includes the eval suite and the package and workflow policy).
3. Tag the merged commit `vX.Y.Z` (equal to `package.json` version) and push the tag. Both jobs refuse a tag that does not match, a commit that is not an ancestor of `origin/main` (note: any historical `main` commit passes this check, so tag only the commit you reviewed), and any run that is not a tag ref (a manual dispatch from a branch cannot publish).
4. The `verify` job (read-only token, no environment, no secrets) runs the tests. Only then does `publish` start, and it waits on the protected **`release`** environment, where a reviewer approves it. `publish` repeats the guards, then runs only `npm publish --provenance --access public --ignore-scripts`.
5. **Create the `release` environment before the first tag**, with required reviewers and a deployment rule that allows only `v*` tags. If it does not exist, GitHub creates an unprotected one on first use. Publishing uses npm trusted publishing (OIDC): no token is stored anywhere. On npmjs.com the package's Trusted Publisher must name this repository, workflow `release.yml`, environment `release` and allow `npm publish`; the workflow needs npm >= 11.5.1 (Node 24 ships it). Provenance needs the GitHub-hosted runner and `id-token: write`, granted only to the `publish` job. The policy checker forbids any secret or `NODE_AUTH_TOKEN` in `release.yml`.
6. Check the result with `npm view android-architect` and the provenance badge on the npm page.

### Editing the workflows

The policy lives in the same commit as the workflow, so a pull request can change both. Nothing in the repository may redirect `npm publish`: the publish command pins `--registry https://registry.npmjs.org`, and the policy test fails on any `.npmrc` (root, `bin/`, `skill/`) or a `publishConfig` that sets another registry. Treat `.github/`, `.npmrc`, `test/helpers/`, `test/release-policy.test.js` and `package.json` as sensitive: protect `main` with required pull request review and **Require review from Code Owners** (`.github/CODEOWNERS`). `test/helpers/release.golden.yml` is a golden copy of `release.yml` (pin comments and action refs ignored); any change to the release workflow needs a deliberate golden update, shown in review (the command is in `test/release-policy.test.js`).

### First CI run on macOS

The CI matrix includes macOS, and tests that use temp directories can fail there on the first run because `/var` is a symlink to `/private/var` (compare real paths). Expect to fix such failures when the pipeline first runs; they are test issues, not product bugs.

### Before the first publish

Run `npm view android-architect` and confirm the name is free (or yours). If it is taken, stop and choose a name or scope before anything else.

### Release blockers

The release workflow runs the policy test with `RELEASE_REQUIRE_PINNED=1`, so it fails until the first item is done.

- [x] **Action pins.** Done: both workflows use full commit SHAs with `# v4.4.0` comments. When bumping, resolve the new tag from the action's own repository and keep `RELEASE_REQUIRE_PINNED=1 node --test test/release-policy.test.js` green.
- [ ] `release` environment and required reviewers configured, npm Trusted Publisher set up (no `NPM_TOKEN`); GitHub private vulnerability reporting enabled; branch protection on `main`.
- [ ] `npm view android-architect` name check done.
- [ ] Maintainer data audit below completed.

### Pre-release maintainer data audit

All of the following were written from memory and are unverified. Check each against its primary source, fix it, record the source and flip `verified` only then.

- [ ] All playbooks in `skill/catalog/playbooks/` (steps, pitfalls, security checklists, tags). Partly audited 2026-11-21: every URL in the catalog, references and SKILL.md was fetched (27 of 29 returned 200; the two broken links were fixed). On 2026-11-22 three reviewers checked the factual claims (API and artifact names, plugin ids, operator mappings, deprecation status) of 18 of the 19 playbooks against official docs and the corrections were applied (Rx `Flowable.asFlow()` module, empty lifecycle `-ktx` artifacts, Realm end of support, the SharedPreferences cleanup wording, a Navigation 3 pointer). Not confirmed: the `FragmentComponent` mapping, Moshi JVM-only, Ktor `expectSuccess` default, the `AndroidSqliteDriver(SupportSQLiteOpenHelper)` constructor, Realm companion files, security-crypto reserved keyset names, and Compose equivalents of secure-flag behaviour. Pitfalls, ordering and security checklists were not re-derived, so the playbooks stay `verified: false`.
- [x] `skill/catalog/versions.json` stable versions: resolved from Google Maven and Maven Central on 2026-11-21. Still unaudited: update groups, `requires` and `notes` data, and migration builds for major bumps. Changelog review 2026-11-22: Retrofit 3 moves to OkHttp 4.12 and keeps forward binary compatibility with 2.x; Glide 5 is 4.16 plus a Java 8 and Kotlin 1.8 build baseline (4.16 added nullability annotations to `RequestListener`, which can break Kotlin code); OkHttp 5 is reported as source compatible with 4.12 and ships separate JVM and Android artifacts, so 4.x and 5.x artifacts must not be mixed. None of this was verified by building a migration.
- [ ] Compliance policy data and effective dates in `skill/catalog/dimensions/compliance.json`. Audited 2026-11-22 against Android and Play docs: target API 36 (2026-08-31), the 16 KB page size date (corrected from 2025-11-01 to 2027-02-01, when Play blocks non-compliant updates; earlier extension to 2026-05-31 existed), predictive back (opt-out `android:enableOnBackInvokedCallback=false` still documented for target 36) and edge-to-edge (opt-out disabled on Android 16). Foreground service types (target 34), notification permission and granular media permissions (target 33) and exact alarms were checked on 2026-11-22 too; exact alarm default-deny applies from target 33, not 34, so that entry was corrected. Source links were not re-fetched.
- [ ] The Gson CVE-2022-25647 entry (affected range, fixed version, severity) and the other `vulnerableVersions` data.
- [ ] Default agent CLI flags for `run` (`claude`, `codex`) in `skill/scripts/lib/agent.js`. Audit 2026-11-21: `claude` 2.1.329 accepts `-p`, `--output-format json` and `--max-turns` (confirmed with one real run; `--max-turns` is just absent from `--help`). `codex exec` is documented (non-interactive mode, `--sandbox`, `--ask-for-approval never`; the default sandbox is read-only, so editing needs `--sandbox workspace-write` in `agent.command`), but its binary was not installed here, so `--json` and the default argv are unconfirmed by a real run.
