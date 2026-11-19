# M2 follow-up backlog

Deferred minor findings from the M2 per-task reviews, the final review and its fix-wave re-review. Every Important finding was fixed before merge. Triage these when planning M3+.

- Task 1: minor (deferred): ids stringified indexes, tie order "10"<"2"; redundant Set on source files; package/import tokens copied per declaration (tf growth); plan-mandated decl regex misses `fun <T>` and names extension fns after receiver; test gaps (--kind doc CLI, limit validation, Java/no-decl file, docs/ + README docs, default --out, large tree)
- Task 1: minor (deferred): index.js own gitCommit helper (dup of Task 2 headCommit; Task 2 to replace); verify queryIndex/indexer have no other plain-object term lookups
- Task 2: minor (deferred): readManifest accepts missing/non-int schemaVersion, misleading msg for null JSON; hashTree top-level dir not lstat-checked, raw ENOENT; addToExclude dupes within patterns; tests: key order unasserted, loose /manifest/ regex, untested symlink-dir/no-trailing-newline/partial patterns; writeManifest not atomic
- Task 3: minor (deferred): architecture-current test loose; no tests for unresolved/| escaping/empty modules; renderReadme throws assert without regex; mermaidId collision + label escaping; workflow safety paragraph duplicated x4 (spec-mandated)
- Task 3: minor (deferred): knowledge.js feature-map 'TODO' literal passes TODO scan only via missing word boundary; ADR bare `reopenIf:` must parse to [] in Task 6
- Task 4: minor (deferred): write race lstat->writeFileSync (O_NOFOLLOW); CLAUDE.local.md guarded in committed mode (over-refusal); managed-workflow upgrade path untested. Fix round also includes cheap minors: real realpath containment, drop CLI duplicate manifest read, anchored exclude patterns, stronger vendored query assertion.
- Task 4: minor (deferred): raw ENOENT if skillDir/scripts or catalogDir missing; exclude patterns don't escape gitignore metachars in subdir names; no symlink-under-catalogDir test
- Task 5: minor (deferred): group regex can match exclude(group=...) in deps; listFiles/discoverModules run twice per repo; relative --workspace paths resolve vs hub (document); "hub (1 repos)" grammar
- Task 5: minor (deferred): parenDepth counts parens inside strings; no test for n===0 label or symlink inside member .ai in workspace run
- Task 6: minor (deferred): single-quote rejection untested/undocumented; quoted scalar `"a" "b"` accepted, no escapes; absent: not tested via R7; list-item anchors untested; ADR ids not validated against catalog. Fix round includes cheap: trim whitespace-only dimension/target.
- Task 6: minor (deferred, FINAL REVIEW SHOULD FIX): stored dimension/target untrimmed -> `target: "ktor-client "` never matches in R7; bare values accept ` # comment` silently though doc forbids; no blank-target test
- Task 7: minor (deferred): local-mode refresh and hub refresh untested; violations only asserted as array; invalid recs JSON / removed-candidate paths untested; two notes on catalog move vs "single note"; files.written computed twice; migrateLayout backup branch dead
- Task 8: minor (deferred): update() accepts .installed.json missing version (prints undefined), no partial-update note; parseArgs accepts any known flag on any command; README top flag list incomplete; CLI tests missing init --local/--append-pointers/unknown flag on install/printRefresh sections; import order cosmetic
- Task 9: minor (deferred): substring-only doc tests, duplicate script-path test
- Task 9: minor (deferred): SKILL.md recommend step 7 / setup step 3 / Rejections hardcode <root>/.ai/knowledge/adr without "(member: see Workspaces)" pointer
- Task 10: minor (deferred): app + :data/:domain reports both layer-modules and app-plus-libraries (unpinned); M5 lacks shared/root plugin and .kts plugin-form tests; rubric-code-quality Rx bullet sits in swallowed-exceptions section; README:73 example shows 2026.11.0; catalog.test.js import order
