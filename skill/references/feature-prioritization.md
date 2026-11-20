# Feature prioritization

Which feature to migrate first, and why. `scripts/features.js` ranks migration candidates (feature modules, else feature packages, else top-level packages, else one `app` unit) with a score from 0 to 100 and a bucket.

## The scoring model

The score is a weighted average of six inputs, each between 0 and 1:

| Input | Meaning | Higher score when |
| --- | --- | --- |
| isolation | 1 / (1 + fan-in + fan-out) | few modules or packages depend on it or are used by it |
| size | band by lines of code | small or medium |
| tests | test files, capped at 2 | tests already exist |
| churn | distinct commits touching the feature in the last 6 months | it changes often (more value from a cleaner design) |
| risk | keyword match on the unit name | no high-risk keyword |
| proximity | share of UI files already on the target style | it is already close to the target |

Weights, risk keywords, bucket thresholds and size bands live in `catalog/scoring.json`. When churn is unavailable (no git history) the churn weight is dropped and the others are renormalised, so features still rank.

Buckets: `first` (pilot candidates), `next`, `last` (leave as is for now). A `last` feature gets no steps in the plan.

## Tuning `scoring.json`

- Raise a weight to make that signal matter more; the weights are normalised, so only ratios matter.
- Add domain words to `riskKeywords.high` for flows where a mistake costs money or trust, and to `medium` for flows with personal data.
- Move `buckets.first` up to get fewer, safer pilots.
- Change one value at a time and rerun `features.js`; a tuning that reorders everything is usually a sign of one dominant weight.

## Why high-risk and large features are not pilots

- A pilot proves the playbook on something cheap to get wrong. A high-risk feature (login, payment, onboarding) is the opposite: a defect there is costly and visible. The ranker caps such features to `next`, and the plan tags their steps `decision`.
- A feature above the large size band takes many pull requests and hides playbook problems among unrelated changes. Split it, then migrate the pieces.
- Features with no tests need characterization tests before anything else; this is why `first` features get a safety-net step.

## Caveats

- Churn is a proxy. A feature with high churn may be unstable for a reason a migration does not fix, and bulk commits (formatting, renames) are ignored by the ranker because they say nothing about a feature.
- Names carry the risk signal. A risky feature with a neutral name scores as low risk; review the list by hand.
- A ranking is advice. The user decides which features are pilots.
