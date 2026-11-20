---
id: koin--to--hilt
dimension: di
from: koin
to: hilt
title: Koin to Hilt
irreversible: false
kmpOnly: false
worthIf:
  - absent:kmp
asOf: 2026-11-20
verified: false
---

Moves dependency injection from Koin (a runtime service locator and DSL) to Hilt (compile-time Dagger-based injection). This is usually an optional change, and the first question is whether to do it at all. Written from memory of https://developer.android.com/training/dependency-injection/hilt-android; check the current documentation for details, and for Koin consult its own documentation (not linked here).

## When it is worth it

Hilt's compile-time graph validation is required by the team or by policy, missing bindings have caused runtime crashes in production, or the organization has standardized on Hilt and Android tooling around it (`@HiltViewModel`, `@HiltAndroidTest`).

## When not to

The team should stay on Koin when it works: Koin is a supported, maintained library, it is simple, and it supports Kotlin Multiplatform, which Hilt does not (Hilt is Android only). If the code is shared across platforms, or the main complaint is only that Koin errors appear at runtime, the better answer is to stay and add a graph check test (Koin offers module verification; check its documentation) instead of rewriting every injection site. The migration touches every module and injection site, so it needs a clear reason.

## Preconditions

- Every Koin module, definition (`single`, `factory`, `viewModel`, `scope`), `get()` and `inject()` call is listed, including those in non-Android classes.
- Koin scopes (`scope`, `createScope`, session scopes) are identified, especially those that carry user data.
- The team accepts Android-only DI, and shared (KMP) modules do not depend on Koin.
- A graph verification test for Koin exists, or is written first, to compare behavior.

## Steps

No persisted data changes in this migration, so it is reversible per unit. One safe ordering applies throughout: every stateful binding has exactly one owner at any time, and a Koin module is deleted only in the last step.

1. Inventory definitions and map them: `single` to `@Singleton` in `SingletonComponent` (`@Provides` or `@Binds` plus `@Inject constructor`), `factory` to unscoped bindings, `viewModel` to `@HiltViewModel` with `@Inject constructor`, Koin `scope` tied to an Activity to `@ActivityScoped` or `@ActivityRetainedScoped`, session or user scopes to a custom component through `@DefineComponent` or a manually owned object, and named qualifiers to Hilt qualifiers. Mark every binding as stateful (token store, session cache, HTTP client, database, locks, key holders) or stateless.
2. Define the seam: the classes that features use are interfaces with constructor injection, with no direct `get()` or `inject()` calls in business code (replace service-locator lookups with constructor parameters first, while still on Koin).
3. Add Hilt next to Koin and annotate the `Application` with `@HiltAndroidApp`. Pick one owner for each type. A stateful type is created by one container only; the other container gets a bridge: a Hilt `@Provides` method that returns the instance from Koin, or a Koin definition that reads the Hilt instance through an `@EntryPoint`. Creating a stateful type in both containers would give two instances (two token stores, two database connections), so it is not allowed; stateless types may be defined in both.
4. For one Koin module at a time, add the equivalent Hilt module with `@InstallIn`, make Hilt the owner of its stateful types, and replace the Koin definitions in that module with bridge definitions that point to the Hilt instance. The Koin module stays in place with the bridges until its units have moved and soaked. Run both containers side by side for the unit and compare the resolved implementations and instance identity in tests.
5. Do the per-unit cutover: move one screen at a time to `@AndroidEntryPoint` or `@HiltViewModel` and stop using its `by inject()` or `by viewModel()` lookups. Non-Android classes that Hilt does not construct use an `@EntryPoint` with `EntryPointAccessors`, never a static lookup. Let the unit soak.
6. Delete Koin in the last step only: remove the remaining Koin modules and bridge definitions, the `startKoin` and `stopKoin` calls and the Koin dependencies, after the last unit has shipped and soaked.

## Pitfalls

- Koin definitions resolve lazily at runtime, so an unmoved dependency fails only when first used; keep a test that resolves all bindings.
- `factory` produces a new instance for every call; Hilt's unscoped bindings do the same, but a `single` converted to unscoped changes behavior (state is lost) and an unscoped converted to `@Singleton` can share state that was meant to be separate.
- Koin allows injecting parameters at lookup (`parametersOf`); Hilt does not, so use `@AssistedInject` or pass values at the call site.
- Koin scopes tied to an Activity map to `@ActivityScoped` or `@ActivityRetainedScoped`, but session or user scopes have no built-in Hilt equivalent; map them deliberately with a custom component or an owner object.
- Shared KMP modules that use Koin cannot move to Hilt; keep a Koin or manual-injection boundary at that edge.
- Default arguments and property injection hidden in Koin definitions must be recreated.

## Tests

- Single-owner test: a stateful type obtained through Koin and through Hilt is the same instance (assert identity).
- Before the move, write a test that resolves every Koin definition; after each unit, a Hilt graph test (`@HiltAndroidTest`) that injects the main entry points.
- Per unit: the same behavior tests pass on both containers.
- Scope tests: a session-scoped object is dropped after logout in the new container.
- Check that no `get()` or `inject()` call from Koin remains in moved code.

## Security checklist

- Scope lifetimes do not widen: a Koin `scope` holding credentials, a session or a decrypted key must not become `@Singleton` in Hilt; keep a lifetime that ends at logout and verify the old instance is not reachable afterwards. Koin's `single` is process-wide, so check which of those singles hold user data and release them on logout.
- Koin properties and definitions that hold secrets or API keys are not copied into logs, build config or Hilt modules in plaintext; configuration that was read at runtime keeps coming from the same protected source.
- Koin's logger (which can print the definitions it creates) is turned off or set to a no-op level in release builds before the first Hilt unit ships, and the Koin `startKoin` call does not ship with a debug logger or with properties files that hold secrets.
- Qualified bindings for different trust levels (authenticated versus anonymous clients) keep distinct qualifiers in Hilt.

## Rollback

Per unit: send the unit back to Koin by changing it back to its Koin lookups (`by inject()` or `by viewModel()`). The Koin modules, with their bridge definitions, stay in the code until the last unit has shipped and soaked (step 6), and the bridge definitions keep returning the instance that Hilt owns, so the single owner of each stateful type never changes during a rollback (never point a bridge back at a new Koin-created instance beside Hilt's). After step 6 deletes Koin, restore it from version control. No persisted state is involved.
