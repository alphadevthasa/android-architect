# Contributing

Thanks for helping. The package has zero dependencies and no install scripts; please keep it that way. Everything (code, docs, comments) is in English and generic: no employer or private project names.

```
npm test        # all tests, network blocked, includes the eval suite and the release policy
npm run eval    # only the eval suite
```

## Add a dimension entry

Entries live in `skill/catalog/dimensions/<dimension>.json`. Add an object to `entries` with `id`, `name`, `era`, `status` (`current`, `legacy` or `deprecated`), `since`, `successors` (ids in the same catalog, a direct step only), `detect` signals (Gradle coordinates, imports, file globs) and, where relevant, `prerequisites` and `vulnerableVersions`. Mark anything written from memory with `verified: false` or the dimension-level `dataNote`. Then bump the catalog version (see below), update goldens if detection changed, and run `npm test`.

## Add a playbook

Playbooks are `skill/catalog/playbooks/<from>--to--<to>.md`, with `from` and `to` entries of the same dimension and `to` reachable through `successors`. Read `skill/catalog/playbooks/README.md` and copy `_example-seam.md`: strict front matter, the fixed headings in order, and a Security checklist of at least two items.

**Safe-ordering rule for irreversible playbooks (on-device data moves):** back up first, keep a single writer, copy behind a write gate, verify, and only then delete the old store. The old store is never deleted before verification, and the playbook is tagged `irreversible`. Playbooks start as `verified: false`. Add a fixture test in `test/playbooks.test.js`.

## Change catalog data

- `skill/catalog/catalog.json` `catalogVersion` is `YYYY.MM.N`. Bump `N` for any data change in the same month and the year-month when the month changes, and update `asOf`.
- After a bump, re-record goldens (`node dev/record-eval.mjs <name> --force`, then `node dev/record-eval.mjs --update-recs`) and review the whole diff.
- Version numbers, policy dates, CVE ranges and default agent flags written from memory stay `verified: false` until someone checks them against the primary source and records the source link. Never mark data verified without that check.
- Add a CHANGELOG line under the unreleased heading for every data change.

## Run the eval suite

`npm run eval` runs `test/eval/eval.test.js`: golden profiles, candidate paths, guardrail rules and pinned real apps (if checked out). See `test/eval/README.md` for the format and how to add an app. It is deterministic and offline.

## CI and policy tests

`.github/workflows/ci.yml` runs the tests on Node 20 and 22 with read-only permissions. `test/release-policy.test.js` checks the package contents and size budget, and parses both workflows (permissions, triggers, token scope, provenance, pinned actions). Change a workflow and the policy together, and keep its negative tests green.

## Cut a release

Releases are published only by `.github/workflows/release.yml`, from a version tag, with npm provenance.

1. Update `version` in `package.json` and the `CHANGELOG.md` heading together; merge to `main` through a reviewed pull request.
2. Run `npm test` and `npm run eval` locally.
3. Tag the merged commit `vX.Y.Z` (equal to `package.json` version) and push the tag. The workflow refuses a tag that does not match, a tag whose commit is not on `origin/main`, and any run that is not a tag ref (a manual dispatch from a branch cannot publish).
4. The job waits on the protected **`release`** environment: configure it with required reviewers (and restrict deployments to `v*` tags). A reviewer approves the run.
5. `NPM_TOKEN` is stored only as a secret of the `release` environment. Use an npm automation token scoped to this package, on an account with 2FA enforced for publishing. Provenance needs the GitHub-hosted runner and `id-token: write`, both only in the publish job.
6. Check the result with `npm view android-architect` and the provenance badge on the npm page.

### Before the first publish

Run `npm view android-architect` and confirm the name is free (or yours). If it is taken, stop and choose a name or scope before anything else.

### Release blockers

The release workflow runs the policy test with `RELEASE_REQUIRE_PINNED=1`, so it fails until the first item is done.

- [ ] **Replace tag pins by verified SHAs.** `actions/checkout@v4` and `actions/setup-node@v4` in both workflows are tag references marked `UNVERIFIED pin`. The SHAs were not known when the workflows were written. Resolve each tag to its full 40-character commit SHA from the action's own repository, replace the references (keep the version in a trailing comment), and confirm `RELEASE_REQUIRE_PINNED=1 node --test test/release-policy.test.js` passes.
- [ ] `release` environment, required reviewers and `NPM_TOKEN` secret configured; GitHub private vulnerability reporting enabled; branch protection on `main`.
- [ ] `npm view android-architect` name check done.
- [ ] Maintainer data audit below completed.

### Pre-release maintainer data audit

All of the following were written from memory and are unverified. Check each against its primary source, fix it, record the source and flip `verified` only then.

- [ ] All playbooks in `skill/catalog/playbooks/` (steps, pitfalls, security checklists, tags).
- [ ] `skill/catalog/versions.json` (stable versions, update groups, BOM and coordinate data).
- [ ] Compliance policy data and effective dates in `skill/catalog/dimensions/compliance.json`, including the Google Play target API level 36 date (2026-08-31) and the source links.
- [ ] The Gson CVE-2022-25647 entry (affected range, fixed version, severity) and the other `vulnerableVersions` data.
- [ ] Default agent CLI flags for `run` (`claude`, `codex`) in `skill/scripts/lib/agent.js`.
- [ ] GitHub Action SHAs (the first blocker above).
