---
id: dagger2--to--hilt
dimension: di
from: dagger2
to: hilt
title: Dagger 2 to Hilt
irreversible: false
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves a hand-written Dagger 2 setup (components, subcomponents, modules) to Hilt, which is built on Dagger and generates the Android components. A project that only uses `dagger-android` (the `AndroidInjector` library) is a different catalog entry and does not match this playbook. Written from memory of https://developer.android.com/training/dependency-injection/hilt-android and the Dagger to Hilt codelab at https://developer.android.com/codelabs/android-dagger-to-hilt; check the current documentation before relying on a detail.

## When it is worth it

The project maintains a lot of component and subcomponent boilerplate (`AndroidInjector`, factories, manual `inject()` calls in every Activity and Fragment), or new developers struggle with the graph. Hilt standardizes the components, supports `@HiltViewModel` and gives testing support (`@HiltAndroidTest`, `@TestInstallIn`).

## When not to

The graph relies on custom component hierarchies that do not map to the Hilt component tree (for example several long-lived user or tenant scopes), or on `@Component.Factory` and `@BindsInstance` with runtime values that Hilt cannot supply; evaluate `@DefineComponent` first. Also not if the app is not Android-only and the DI must be shared. A graph that works and has few injection sites may stay on Dagger.

## Preconditions

- The component graph is drawn: components, subcomponents, scopes, modules, and which classes are injected where.
- Scopes that carry user or session data (logged-in user, token store) are identified; see the checklist.
- Build tooling supports the Hilt Gradle plugin and annotation processing (KSP or kapt, check the current documentation); the project builds with it.
- Tests that use Dagger components directly are listed.

## Steps

No persisted data changes in this migration, so it is reversible per unit. One safe ordering applies throughout: every stateful binding has exactly one owner at any time, and the old component is deleted only in the last step.

1. Draw the existing graph and map it to Hilt: the application component to `SingletonComponent` (`@Singleton`), activity components to `ActivityComponent` (`@ActivityScoped`), fragment subcomponents to `FragmentComponent` (`@FragmentScoped`), ViewModel to `ViewModelComponent` and `@HiltViewModel` (`@ViewModelScoped`), and others per the component table in the documentation. Mark every binding as stateful (token store, session cache, `OkHttpClient` with its connection pool and authenticator, Room database, refresh `Mutex`, cipher or key holders) or stateless (a mapper, a formatter).
2. Define the seam: interfaces for the collaborators that features use, with constructor injection, so classes do not reference the Dagger component or the Hilt entry points directly. Convert field and `component.inject(this)` calls to constructor injection where possible first, in plain Dagger.
3. Add the Hilt dependencies and plugin alongside Dagger, and annotate the `Application` class with `@HiltAndroidApp`. Decide the owner of each stateful binding: it is created by exactly one graph. Normally Hilt owns it and the legacy component receives it through an `@EntryPoint` interface installed in `SingletonComponent` (read with `EntryPointAccessors.fromApplication`) or through a component dependency; the reverse (the legacy component owns it and a Hilt `@Provides` method returns the same instance) is acceptable while the legacy component is still the creator. Providing a stateful binding from both graphs would create two instances (two token stores, two connection pools, two database connections on one file, two refresh locks), so it is not allowed. Providing the same binding from both graphs is allowed only for stateless bindings. Check the migration guide for the supported coexistence pattern for your setup.
4. Install modules by ownership. A module that holds a stateful `@Provides` or `@Singleton` binding is installed (`@InstallIn(SomeComponent::class)`, choosing the component whose scope equals the old component's) in its owner graph only; the other graph gets a bridge provision (the entry point or component dependency from step 3) instead of the module. Only modules that contain stateless bindings only may be installed in both graphs. The old modules and component interfaces stay in place until the last step.
5. Hand over ownership of every stateful binding that the legacy component still owns, in a dedicated release before the old component is deleted in the last step: in that one release, take the module out of the legacy component's module list, install it in Hilt with `@InstallIn`, and switch the legacy side to the bridge provision that reads the instance from Hilt. Do the handover for one module per release, with the single-owner identity test passing, and let it soak. Ownership is never held by both graphs, not even for one release.
6. Run the old Dagger component and the Hilt graph side by side for a unit behind a flag where feasible: stateless bindings may exist in both, stateful ones come from the single owner, and a screen uses one graph at a time.
7. Do the per-unit cutover: move one Activity, Fragment or ViewModel at a time with `@AndroidEntryPoint` or `@HiltViewModel`, and stop calling its `inject()` and subcomponent. Classes that Hilt does not create (a `ContentProvider`, a `WorkManager` worker without `@HiltWorker`, a custom `View`, a third-party callback) use an `@EntryPoint` with `EntryPointAccessors`, not static access to the component. Let each unit soak before the next.
8. Delete the old components, subcomponents, `AndroidInjector` plumbing, factory classes, entry-point bridges that only served the legacy component, the flag and the Dagger-only test components after the last unit has shipped and soaked. This is the first point at which any of them is deleted.

## Pitfalls

- A Fragment annotated with `@AndroidEntryPoint` must be attached to an Activity that is also an entry point, so convert the host Activity before (or with) its Fragments; a missed one fails at runtime.
- Two graphs give every stateful `@Singleton` two instances: duplicated token stores or sessions, two HTTP clients with separate authenticators, two writers on one Room database file. Follow the single-owner rule in Steps 3, 4 and 5.
- Scope mismatches: a binding with a narrower scope than its consumer fails at compile time, but a binding that gets installed in a wider component than before compiles and runs, so check the scope of every moved module (see the checklist).
- `@BindsInstance` and component factories with runtime arguments (a user id, a session) have no direct Hilt equivalent: use `@AssistedInject` for objects built with runtime values, or a custom component through `@DefineComponent`.
- Components or classes created outside Hilt's control (a service in a separate process, a library callback, a `ContentProvider` that runs before `Application.onCreate`) cannot rely on field injection; check the documentation for these cases and use an `@EntryPoint` where it applies.
- Dagger and Hilt generated code both live in the build output: stale generated sources can hide errors; clean builds are needed after the move.
- Tests: Dagger test components are replaced by `@TestInstallIn` and `@UninstallModules`; do not mix them.
- Qualifiers (`@Named`, custom) must stay identical across both graphs while they coexist, or the same type resolves to different implementations.

## Tests

- A graph test that builds the Hilt graph (a `@HiltAndroidTest` that injects the main entry points) so a missing binding is caught in CI.
- Single-owner test: the stateful binding obtained through the legacy component and through Hilt is the same instance (assert identity).
- Per unit: the screen works with the Hilt injection and the old tests pass with `@TestInstallIn` replacements.
- A scope test: the same instance is returned within a scope and a different instance after the scope ends (for example a session object after logout).
- Instrumented smoke test for each `@EntryPoint` use (a worker or provider obtains its dependency).
- Side-by-side check: the old component and the Hilt graph resolve the same interface to the same implementation class for the moved bindings.

## Security checklist

- No scope widening keeps credentials alive: an object that held a token, a session, a decrypted key or a user profile in a narrow or custom (user-session) component must not be moved into `SingletonComponent` just because Hilt makes that the easy choice. Keep it scoped to a lifetime that ends at logout (a custom component through `@DefineComponent`, or an owner object that is released and recreated at logout), and check that after logout the old instance cannot be reached.
- Review each `@InstallIn` for exposure: a module installed in `SingletonComponent` is visible everywhere, including `@EntryPoint` interfaces; expose only the narrow interface needed (not the whole credential store), and keep debug or test bindings in debug source sets or in `@TestInstallIn`.
- Qualifiers for different trust levels (an authenticated client versus an anonymous client, a pinned versus a default `OkHttpClient`) stay distinct; a missing qualifier must not let the anonymous client satisfy an authenticated injection point or the other way round.
- `@Provides` methods do not log or print credentials, and nothing is cached in a `@Singleton` that was unscoped before.

## Rollback

Per unit: switch back to the old Dagger component for that unit. The old component, its modules and its interfaces stay in the code until the last unit has shipped and soaked (step 8), so rollback needs no restoration. While both exist, keep stateless bindings in sync and keep the single owner of each stateful binding unchanged: never hand ownership back and forth. To roll back the ownership handover release (step 5), revert that release as a whole (module list, `@InstallIn` and bridge together), so exactly one graph owns the binding before and after; never ship a state in which both own it. After step 8 deletes the old components, restore them from version control. No persisted state is involved.
