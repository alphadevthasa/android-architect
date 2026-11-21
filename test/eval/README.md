# Eval suite for the tool itself

`npm run eval` runs `test/eval/eval.test.js`. It also runs as part of `npm test` (node's discovery picks it up), so CI covers it; the two commands are separate runs, never one run twice. It is deterministic, offline and takes about a second.

## What runs in CI

1. **Golden profiles.** For each in-repo fixture (`legacy-java-mvp`, `modern-compose`, `mixed`, `feature-app`, `reuse-app`, `secrets`, `insecure-app`) `golden/<fixture>.json` holds the expected `scan.js` profile subset, asserted exactly: per dimension the entry ids and shares, modules and their project deps, sdk levels and size counts. Evidence lists, the root and any timestamps are deliberately not recorded.
2. **Candidate paths.** The same file holds `candidates`: for each dimension with a detected entry, `current`, `next`, `reachable` and the ids that are blocked by unmet prerequisites. The order is the catalog's order and is asserted as a list, so a change in ordering fails.
3. **Recommendation rules.** `rules` in each golden file point at canned recommendation files in `golden/recs/<fixture>.<case>.json` (the exact input of `recommend-check.js`). Rule kinds:
   - `guardrail`: each case expects `pass` (exit 0, no violations) or `fail` (exit 1, and exactly the listed R-rules fire).
   - `must-not-recommend`: `forbid` lists `{dimension, to[]}` targets that no step may reach without a 20+ character justification. A `violate` case must contain such a step and the guardrail must reject it with the listed rules; a `pass` case must not. The legacy Java+MVP fixture must never receive an unjustified jump to Compose or MVI.
   - `must-recommend`: `require` is `{dimension, anyOf[]}`; at least one step must reach one of the ids (`pass`), or the case is a deliberately lacking file (`fail`).
4. **Pinned real apps.** `apps.json` is validated against the schema below. For every listed app whose `test/eval/apps/<id>` folder exists, the golden `golden/apps/<id>.json` is asserted the same way; if the folder is absent the test is skipped with a notice.

Recommendation files carry the catalog version. After a catalog bump (profile `catalogVersion`, new or renamed entries), re-record the goldens with `node dev/record-eval.mjs <name> --force` (existing `rules` are kept), update `catalogVersion` in the files under `golden/recs/`, and review the whole diff before committing.

## `apps.json` format

```json
{ "schemaVersion": 1, "apps": [
  { "id": "some-app", "era": "modern-compose", "repo": "https://host/org/repo", "commit": "<40 lowercase hex>", "license": "Apache-2.0", "notes": "why this app" }
] }
```

- `id`: lowercase letters, digits and `-`, up to 64 characters, unique.
- `era`: one of `legacy-java-mvp`, `mvvm-rxjava`, `modern-compose`.
- `repo`: an `https://` URL without embedded credentials.
- `commit`: a full 40-character lowercase hex commit (a branch or tag name is rejected).
- `license`: non-empty (record the SPDX id after checking the repository).
- `notes`: optional.

The shipped list is empty on purpose: the repository and commit choices are a maintainer decision and no hash is invented here. The spec (5.16) suggests Now in Android as the modern example; which commit to pin is for the maintainer. Pick one app per era you want covered.

## Adding a real app (maintainer only)

1. Choose the repository, pin a commit (40 hex) and check the license.
2. Add the entry to `apps.json`.
3. `node dev/fetch-eval-apps.mjs` validates the manifest and clones each pinned commit into `test/eval/apps/<id>` (gitignored) with `git clone --no-checkout` plus `git checkout`, https only, hooks disabled, a sanitized environment, and verifies HEAD equals the pin. It never runs repository scripts. It needs the network and is never run by `npm test`. It removes `.js`, `.mjs` and `.cjs` files from the checkout, because node's test discovery executes any `.js` file under `test/`; the eval fails if any remain.
4. `node dev/record-eval.mjs <id>` runs `scan.js` and `candidates.js` and writes `golden/apps/<id>.json`. It refuses to overwrite without `--force`.
5. Review the diff of the golden, then commit it. The checked-out app itself is never committed.

Note: `fetch-eval-apps.mjs` has only been exercised for manifest validation; the clone path needs a real run by a maintainer.

## Model-dependent flow (documentation only, never CI)

The model's behaviour is not deterministic, so it is checked by hand. Before each release, and on every catalog or prompt change:

- [ ] For each fixture and each pinned app, run the skill with the model to produce recommendations (`recommendations.json`).
- [ ] Run `node skill/scripts/recommend-check.js <recommendations.json> --profile <profile.json>` on each output; it must exit 0 with no violations.
- [ ] Check by eye that legacy projects get small steps (no jump to Compose and MVI without justification), that `irreversible` and `decision` steps are tagged, and that nothing recommends a rejected ADR.
- [ ] Record the results (which model, which fixtures and apps, pass or fail, notable deviations) in the release notes.
