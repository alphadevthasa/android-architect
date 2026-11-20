# M3 follow-up backlog

Deferred minor findings from the M3 per-task reviews, the final review and its fix-wave re-review. Every Important finding was fixed before merge. Triage these when planning M4+.

- Task 1: minor (deferred): SECRET_RULES export not authoritative + /g lastIndex state; tokenizeSafe on coords is cosmetic; short storePassword redacted vs credential min 8 untested
- Task 1: minor (deferred): `- Token: optional`/`password=$ENV` over-redacted; quoted "${TOKEN}" over-redacted; nested escaped-quote assignment in string and raw string ending """" not redacted
- Task 1: minor (deferred): indexer fallback title raw basename (doc title redacted downstream, unverified); no positive test pinning `"token": "…"` after the quote-closing guard
- Task 2: minor (deferred): timing test uses non-existent paths, flaky 5 s bound; buildIndex test assertions vacuous/odd titles; maxBuffer arbitrary
- Task 2: minor (deferred): non-repo under stray ancestor .git now throws (fail-closed, may surprise); locale test not self-validating if de_DE missing; lenient 15 s timing bound
- Task 3: minor (deferred): no test that installed ai-status --trust-modified-tools still reports modified; vendored gate skipped when manifest deleted (doc it); modified-result object built 3x; regularFiles "refusing to write" message on read path; doctor projectStatus doesn't catch aiStatus/loadCatalog errors (whole doctor fails); "(1 files)" grammar
- Task 4: minor (deferred): data-sink flag after URL (`curl URL -d @a`) not caught; bare "key" noun not in exfiltration list; injection.js<->aidir.js import cycle (call-time only)
- Task 5: minor (deferred): activity-alias exported not covered; provider read/writePermission treated as unprotected (FP); tools:node="remove" ignored; multi-line `release\n{` and `buildTypes.release {}` missed; `pin\b` lacks leading boundary (plan-mandated); no activity-alias/placeholder/large-line tests; MAX_TAG 4000 skip undocumented
- Task 6: minor (deferred): one row per module per dep undocumented; parseRange error doesn't name bad token
- Task 7: minor (deferred): refresh loads overrides twice (TOCTOU, harmless); first refresh after upgrade reports all pins as added once
- Task 8: minor (deferred): bare --workspace no-op drops link/version/artifact drift (compare links+artifacts, still write .new on drift); no negative test that real changes refresh generatedAt; midnight-crossing flake risk; item 2 symlink/missing-old-hub tests; oneLine applied inconsistently + lives in overrides.js; CONTROL excludes C1/U+2028/bidi; manifestFor references tools before declaration; manifest generatedAt kept when only candidates change
- Task 9: minor (deferred): exit 3 not in scripts table columns; CHANGELOG "required" vs auto-detect; substring-only doc tests; redaction-kind list hand-written (no drift test)
- Task 9: minor (deferred): rule 5 repeats the pattern list; docs test checks one direction only
- Final: minor (deferred): vendored scan.js/candidates.js/refresh.js/init-ai.js not gated (no workflow runs them); .ai/tools committed as symlink skips the vendored gate; strings.xml rule needs digit + single-line <string>
