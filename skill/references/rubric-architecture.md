# Rubric: architecture

Use this rubric in `audit` to judge structure, and in `recommend` to justify labels. Each criterion lists signals you can find in code and how to rate severity. Cite `file:line` for every signal you report.

Severity scale used in reports:

- **High**: actively causes bugs, blocks testing or a committed migration, or makes changes in one area routinely break another.
- **Medium**: slows the team down or raises the cost of every change in an area, with no immediate breakage.
- **Low**: inconsistency or local debt with a contained cost.

Scale severity with reach: the same smell in one rarely touched screen is lower than in the checkout flow or a module everything depends on.

## 1. Layering and the dependency rule

Expected shape: UI (Activities, Fragments, composables, ViewModels) depends on data (repositories, data sources), optionally through a domain layer (use cases). Dependencies point inward: data and domain know nothing about Android UI classes.

Signals in code:
- Activities, Fragments or composables calling Retrofit services, DAOs, `SharedPreferences` or `SQLiteDatabase` directly.
- Repositories or use cases importing `android.view.*`, `android.widget.*`, `Activity`, `Fragment`, or holding a `Context` for UI work.
- Domain or model classes annotated with Room `@Entity` or Gson/Moshi annotations and used straight in the UI (persistence and transport models leaking upward).
- A `domain` package or module that imports from `data` implementation classes rather than interfaces.
- Package names suggest layers (`ui`, `data`, `domain`) but imports cross them freely.

Severity guidance:
- High: UI talks to network or database directly in core flows, or data classes depend on UI classes.
- Medium: layers exist but leak in places (shared models across layers, occasional direct DAO use from a ViewModel).
- Low: naming or package layout inconsistent with an otherwise sound dependency direction.

## 2. Module coupling (fan-in / fan-out)

Use the profile's `modules[].projectDeps` to build the module graph.

Signals in code:
- High fan-out: a feature module depending on many other feature modules (feature to feature edges).
- High fan-in on a "common", "core" or "base" module that contains unrelated code (UI widgets, networking, analytics, utils together). Any change there rebuilds everything.
- Cycles avoided only through a shared module that keeps growing.
- `api(project(...))` used where `implementation` would do, leaking transitive dependencies.
- The `:app` module holding most of the code even though other modules exist.
- Single module with a large codebase: note it as context for modularization, not as a defect by itself.

Severity guidance:
- High: feature modules depend on each other in a way that blocks independent work or builds, or a god "common" module with fan-in from every module.
- Medium: a few unnecessary edges, `api` leaks, `:app` still owning most features.
- Low: naming or grouping issues in an otherwise acyclic, layered graph.

## 3. Testability seams

Signals in code:
- Constructors that create their own collaborators (`new ApiClient()`, `Retrofit.Builder()` inside a ViewModel or presenter) instead of receiving them.
- Singletons reached through static access (`App.getInstance()`, `Foo.INSTANCE`, `object` with mutable state) from business logic.
- Business logic in Activities or Fragments, which needs instrumentation to test.
- Hard-coded dispatchers or schedulers (`Dispatchers.IO`, `Schedulers.io()`) inside logic without a way to inject them.
- Calls to `System.currentTimeMillis()`, `Random`, `UUID` in logic with no clock or generator abstraction.
- Test folders that are empty, or tests that only cover trivial classes while core flows have none.

Severity guidance:
- High: core flows (auth, payment, sync) have no seam at all, so no migration step there can be verified.
- Medium: seams exist but are bypassed in places; tests rely on heavy mocking of statics.
- Low: occasional static access in leaf code.

## 4. State ownership

Signals in code:
- UI state spread across several mutable fields in a ViewModel or Fragment instead of one immutable state object.
- State held in Activities or Fragments that is lost on configuration change or process death (no `SavedStateHandle`, no `rememberSaveable` where needed).
- Mutable state exposed publicly (`val state = MutableStateFlow(...)`, `MutableLiveData` exposed as public).
- The same data cached in several places (singleton, ViewModel, database) with no single source of truth.
- Two-way flows where the UI writes into shared state directly instead of sending events.

Severity guidance:
- High: inconsistent state causes visible bugs (stale screens, lost input after rotation or process death).
- Medium: no single source of truth, but bugs are rare or worked around.
- Low: style inconsistencies in how state is exposed.

## 5. Navigation ownership

Signals in code:
- `startActivity` and `FragmentTransaction` calls scattered across adapters, presenters, ViewModels or utils.
- ViewModels or presenters holding an `Activity` or `NavController` reference to navigate.
- Feature modules navigating to each other by importing concrete Activity classes, creating feature-to-feature dependencies.
- Deep links handled in several places with duplicated parsing.
- Mixed navigation systems (manual transactions, Navigation component, Compose navigation) without a rule for which one new screens use.

Severity guidance:
- High: navigation logic couples feature modules or causes back-stack bugs in core flows.
- Medium: navigation is scattered but works; adding a screen needs edits in several places.
- Low: one consistent approach with minor exceptions.

## 6. DI boundaries

Signals in code:
- Two DI approaches at once (Dagger and Koin, or DI plus a hand-rolled service locator) with no migration in progress.
- A single giant component or module providing everything.
- `@Singleton` or app-scoped bindings for things that should be scoped to a screen or flow.
- Feature modules reaching into each other's DI graph, or `:app` binding implementation details of every feature.
- `inject()` calls or `get()` lookups deep inside business logic (service locator usage) instead of constructor injection.

Severity guidance:
- High: scoping errors that leak screens or share state across users or sessions, or DI that makes feature modules impossible to build in isolation.
- Medium: one oversized graph, mixed DI frameworks, service locator use in logic.
- Low: naming and organization of DI modules.

## Reporting

For each criterion you report: a one-line verdict, the severity, two to five signals with `file:line`, and the impact on the team or users. Skip criteria where you found nothing notable, and say in one line that you checked them.
