# Recommendation method

Every recommendation goes through four stages: **Detect → Assess → Recommend → Migrate**. Code handles the facts and the legality; you handle the judgment. Skipping a stage is how "latest everything" advice happens.

## 1. Detect

`scan.js` maps each module onto each stack dimension and reports mixes as shares (for example "UI: 60% XML, 40% Compose"). Entries with `share: null` are computed presence flags and mean "present"; an entry with `units > 0` is present even when its share rounds to 0 (shown as `<1%`). `candidates.js` then derives, from the catalog's `successors` and `prerequisites`, what each dimension can legally move to.

The dimensions are: language, build, ui, presentation, navigation, async, di, networking, serialization, persistence, keyvalue, image, background, modularization, testing, static-analysis, compliance, build-performance.

Detection is static. It reads build files and sources; it does not resolve Gradle. If something looks missing or wrong, check the code before you trust or dismiss it, and tell the user when the scan and the code disagree.

## 2. Assess

Weigh these factors before choosing any target:

- **Codebase size**: source files, LOC, Kotlin vs Java share. A 5k LOC app and a 500k LOC app get different advice for the same stack.
- **SDK levels**: `minSdk` limits what is cheap (for example Compose and some Jetpack libraries need a minimum level, desugaring changes what Java 8+ APIs are usable). `targetSdk` behind store policy is a `must`.
- **Module count and graph**: one module, a handful, or many; fan-in and fan-out of `projectDeps`; whether feature modules depend on each other.
- **Test presence**: unit and instrumented tests, and whether they cover the code a step will touch. No tests around a seam means the first step is a characterization test.
- **How mixed each dimension is**: a dimension at 90/10 needs finishing, one at 50/50 needs a decision and a rule for new code, one at 100% legacy needs a reason to start at all.
- **Stated constraints**: team size and seniority, release pressure and freeze windows, KMP plans, compliance deadlines, other ongoing migrations. Ask when one of these would change the answer.
- **Cost and risk of the hop**: rough effort, blast radius, reversibility, what the migration can silently drop (pinning, auth interceptors, encryption, ProGuard rules).

## 3. Recommend

For each dimension choose a **realistic target**, not automatically the newest entry. The default modern baseline is Google's guide to app architecture (UI layer with state holders, a data layer with repositories, an optional domain layer, unidirectional data flow), but a project reaches it in steps, and some dimensions should stay where they are.

**Targets come from catalog candidates.** The target for a dimension must be one of the `current` or `reachable` ids that `candidates.js` printed for that dimension. Staying on a `current` entry is a valid target. If the project has nothing in a dimension, a new capability is a step from `null` to an entry with catalog status `current`. Do not propose a library or pattern the catalog does not know; if the user wants one, explain that it is outside the catalog and keep it out of the JSON.

Name the alternatives when the choice is close (for example Hilt vs Koin, MVVM vs MVI) with their trade-offs for this project.

Label each dimension:

| Label | Meaning |
|---|---|
| `must` | The project is exposed or blocked: security, store policy, a deprecated entry with real removal pressure, or a prerequisite for something already committed. |
| `should` | Clear return within the next few months at a reasonable cost. |
| `later` | Worth doing, but after its prerequisites or after more urgent work. No step needed yet. |
| `dont` | The cost exceeds the benefit for this project. Say why in plain words. No step needed. |

Every rationale cites evidence and states cost, risk and why now.

## 4. Migrate

Order the steps across dimensions using catalog prerequisites (for example Kotlin before Coroutines, and Coroutines before Flow-based UI state; Kotlin before Compose). Then:

- **One hop at a time.** A step goes from an entry to one of its direct successors. A transitive hop needs a written justification of at least 20 characters and is the exception.
- **Each step is independently mergeable.** The app builds, passes its tests and can ship after every step.
- **Each step carries its risk, its verification and its rollback point.** Verification is concrete: which tests, which screens, which metric. The rollback point is the last state you can return to cheaply (a revert, a flag, a binding switch). Tag steps without a cheap rollback as `irreversible`.
- **Use seams and side-by-side running.** Introduce an interface or adapter in front of the old implementation, run old and new together, and move one unit (screen, feature, endpoint group, table) at a time. Delete the old path last.
- **Respect the team's bandwidth.** Do not run more than one or two large migrations in parallel. Say which steps can wait.

The guardrail (`recommend-check.js`) enforces the legal parts of this: successor hops (R1), prerequisites first (R2), valid ordering (R3), known ids (R4), shape (R5), and anchoring every chain in what the project actually uses (R6). Passing it means the plan is legal, not that it is wise. The judgment stays yours.

## 5. Rejections

A rejected recommendation is a decision, not a gap. Record it as an ADR with `status: rejected`, its `dimension`, `target`, `reason` and machine-checkable `reopenIf` conditions (`present:<entryId>` or `absent:<entryId>`). `recommend-check.js --adr-dir <root>/.ai/knowledge/adr` then rejects a `must` or `should` target (or a step `to`) that a rejected ADR blocks (R7-rejected) until a condition holds. Propose the alternative or ask whether to reopen; never route around the ADR. `refresh` reports reopened rejections.

