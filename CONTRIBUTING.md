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
5. **Create the `release` environment before the first tag**, with required reviewers and a deployment rule that allows only `v*` tags. If it does not exist, GitHub creates an unprotected one on first use. Store `NPM_TOKEN` only as a secret of that environment. Use a granular npm token limited to this package with publish rights (not an automation token: automation tokens bypass 2FA), on an account with 2FA enabled. Alternatively use npm trusted publishing (OIDC), which needs no stored token; then remove `NPM_TOKEN` and update the workflow and policy together. Provenance needs the GitHub-hosted runner and `id-token: write`, granted only to the `publish` job.
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
- [ ] `release` environment, required reviewers and `NPM_TOKEN` secret configured; GitHub private vulnerability reporting enabled; branch protection on `main`.
- [ ] `npm view android-architect` name check done.
- [ ] Maintainer data audit below completed.

### Pre-release maintainer data audit

All of the following were written from memory and are unverified. Check each against its primary source, fix it, record the source and flip `verified` only then.

- [ ] All playbooks in `skill/catalog/playbooks/` (steps, pitfalls, security checklists, tags).
- [ ] `skill/catalog/versions.json` (stable versions, update groups, BOM and coordinate data).
- [ ] Compliance policy data and effective dates in `skill/catalog/dimensions/compliance.json`, including the Google Play target API level 36 date (2026-08-31) and the source links.
- [ ] The Gson CVE-2022-25647 entry (affected range, fixed version, severity) and the other `vulnerableVersions` data.
- [ ] Default agent CLI flags for `run` (`claude`, `codex`) in `skill/scripts/lib/agent.js`. Audit 2026-11-21: `claude` 2.1.329 accepts `-p`, `--output-format json` and `--max-turns` (confirmed with one real run; `--max-turns` is just absent from `--help`). `codex exec` is documented (non-interactive mode, `--sandbox`, `--ask-for-approval`), but its binary was not installed here, so `--json` and the default argv are unconfirmed.
