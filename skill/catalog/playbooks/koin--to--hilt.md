---
id: koin--to--hilt
dimension: di
from: koin
to: hilt
title: Koin to Hilt
irreversible: false
kmpOnly: false
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

No persisted data changes in this migration, so it is reversible per unit.

1. Inventory definitions and map them: `single` to `@Singleton` in `SingletonComponent` (`@Provides` or `@Binds` plus `@Inject constructor`), `factory` to unscoped bindings, `viewModel` to `@HiltViewModel` with `@Inject constructor`, `scope` to a custom component through `@DefineComponent` or a manually owned object, and named qualifiers to Hilt qualifiers.
2. Define the seam: the classes that features use are interfaces with constructor injection, with no direct `get()` or `inject()` calls in business code (replace service-locator lookups with constructor parameters first, while still on Koin).
3. Add Hilt next to Koin and annotate the `Application` with `@HiltAndroidApp`. During migration, a binding can be supplied from one container to the other: a Hilt `@Provides` method that reads the instance from Koin, or a Koin definition that reads from a Hilt `@EntryPoint`, so that each type has one owner. Make the owner of each type explicit and move it exactly once.
4. Convert module by module: move one Koin module's definitions into Hilt modules with `@InstallIn`, then delete that Koin module. Run both containers side by side for the moved unit and compare the resolved implementations in tests.
5. Do the per-unit cutover: move one screen at a time to `@AndroidEntryPoint` or `@HiltViewModel` and remove its `by inject()` or `by viewModel()` usage. Non-Android classes that Hilt does not construct use an `@EntryPoint` with `EntryPointAccessors`, never a static lookup.
6. Delete Koin: remove the remaining Koin modules, `startKoin` and `stopKoin` calls, the Koin dependencies and the bridge providers after the last unit has shipped and soaked.

## Pitfalls

- Koin definitions resolve lazily at runtime, so an unmoved dependency fails only when first used; keep a test that resolves all bindings.
- `factory` produces a new instance for every call; Hilt's unscoped bindings do the same, but a `single` converted to unscoped changes behavior (state is lost) and an unscoped converted to `@Singleton` can share state that was meant to be separate.
- Koin allows injecting parameters at lookup (`parametersOf`); Hilt does not, so use `@AssistedInject` or pass values at the call site.
- Koin scopes tied to an Activity or session have no automatic Hilt equivalent; map them deliberately.
- Shared KMP modules that use Koin cannot move to Hilt; keep a Koin or manual-injection boundary at that edge.
- Default arguments and property injection hidden in Koin definitions must be recreated.

## Tests

- Before the move, write a test that resolves every Koin definition; after each unit, a Hilt graph test (`@HiltAndroidTest`) that injects the main entry points.
- Per unit: the same behavior tests pass on both containers.
- Scope tests: a session-scoped object is dropped after logout in the new container.
- Check that no `get()` or `inject()` call from Koin remains in moved code.

## Security checklist

- Scope lifetimes do not widen: a Koin `scope` holding credentials, a session or a decrypted key must not become `@Singleton` in Hilt; keep a lifetime that ends at logout and verify the old instance is not reachable afterwards. Koin's `single` is process-wide, so check which of those singles hold user data and release them on logout.
- Koin properties and definitions that hold secrets or API keys are not copied into logs, build config or Hilt modules in plaintext; configuration that was read at runtime keeps coming from the same protected source.
- Koin's logger (which can print the definitions it creates) and any Hilt debug output stay off in release builds.
- Qualified bindings for different trust levels (authenticated versus anonymous clients) keep distinct qualifiers in Hilt.

## Rollback

Per unit: move the unit's bindings back to its Koin module, which stays until the last unit has shipped. Keep the bridge providers in sync while both containers exist. After step 6 deletes Koin, restore it from version control. No persisted state is involved.
