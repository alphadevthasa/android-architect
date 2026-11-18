# Rubric: code quality

Android-specific smells to look for during `audit`. Each smell has detection hints (what to search for and what to open) and a note on severity. Detection hints find candidates; you confirm each one by reading the code before you report it, and you cite `file:line`.

Use the same severity scale as [rubric-architecture.md](rubric-architecture.md): High, Medium, Low, scaled by how central the affected code is.

Prefer read-only search (grep or ripgrep over `src/`) and reading files. Exclude `build/`, generated code and tests unless the smell is about tests.

## 1. God Activity, Fragment or ViewModel

One class that owns UI, business rules, networking, persistence, navigation and analytics.

Detection hints:
- Largest files in `src/main`: Activities, Fragments, ViewModels or presenters above roughly 600 lines.
- Many injected or constructed collaborators (constructor with more than about 7 parameters, or many `@Inject` fields).
- Many unrelated `when`/`switch` branches, or one class handling many screens via flags.

Severity: High when it is a core flow and blocks testing or migration of that flow; Medium otherwise.

## 2. Logic in Views and Adapters

Business rules, formatting decisions or data loading inside custom Views, `RecyclerView.Adapter`/`ViewHolder` classes, data binding expressions or composables.

Detection hints:
- Adapters or ViewHolders importing repositories, API services, DAOs or `SharedPreferences`.
- `onBindViewHolder` with network or database calls, or long conditional blocks deciding business outcomes.
- Composables calling repositories or launching coroutines for loading without a state holder.
- Data binding layouts with complex expressions (`@{...}` containing ternaries and method calls).

Severity: Medium by default; High when it duplicates rules that also live elsewhere and they have diverged.

## 3. Static util grab-bags

`Utils`, `Helper`, `Common` or `AppUtil` classes, or top-level Kotlin files, collecting unrelated static functions and global state.

Detection hints:
- Files named `*Utils*`, `*Helper*`, `*Common*`, `Constants*` above a few hundred lines.
- Static mutable fields (`public static` non-final, `var` in `object`/companion) used as global state.
- Util methods that take a `Context` and touch preferences, network or database.

Severity: Medium when they hold mutable global state or I/O; Low for pure stateless helpers.

## 4. Context leaks

Long-lived objects holding short-lived `Context` instances.

Detection hints:
- Singletons, `object`s, companions or static fields holding `Activity`, `Fragment`, `View` or `Context` (other than the application context).
- ViewModels or presenters with an `Activity`, `Context` or `View` field.
- Anonymous inner classes, `Handler`s, listeners or callbacks registered and never unregistered (`register...` without matching `unregister...`).
- `GlobalScope.launch` or never-disposed Rx subscriptions that capture an Activity.

Severity: High when the object outlives screens in a frequently used flow; Medium otherwise.

## 5. Main-thread I/O

Disk, database or network work on the main thread.

Detection hints:
- `allowMainThreadQueries()` in Room builders.
- `SharedPreferences.commit()` on UI paths, `runBlocking` in UI code, synchronous `execute()` on Retrofit or OkHttp calls outside a background context.
- File reads, `SQLiteDatabase` queries or `BitmapFactory.decode*` in `onCreate`, `onResume`, `onBindViewHolder` or click listeners.
- `StrictMode` disabled or permitted with `permitAll()`.

Severity: High on startup or scroll paths (ANRs, jank); Medium elsewhere.

## 6. Copy-paste code

The same logic duplicated across screens or modules.

Detection hints:
- Near-identical Activities, Fragments or Adapters differing only in a few strings or ids.
- Repeated blocks for error handling, date formatting, auth header building or pagination.
- Search a distinctive line from one file to find its copies.

Severity: Medium when copies have diverged or touch money, auth or data integrity; Low otherwise.

## 7. `!!` density (Kotlin)

Non-null assertions used to silence the type system.

Detection hints:
- Count `!!` per file; report files with a high count relative to size, and any `!!` on values from intents, bundles, network responses or `lateinit`-like nullable fields.
- `lateinit var` on values that are sometimes legitimately absent.

Severity: Medium when on external input or lifecycle-bound values (crash risk); Low for isolated uses in initialization code.

## 8. Swallowed exceptions

Errors caught and dropped, hiding failures from users and from crash reporting.

Detection hints:
- Empty `catch` blocks, `catch (e: Exception) {}`, or catch blocks that only `printStackTrace()` or `Log.d`.
- `runCatching { ... }` whose result is ignored.
- Rx `subscribe()` without an error consumer; coroutines without a `CoroutineExceptionHandler` or try/catch where failures matter.
- Broad `catch (Throwable)` around large blocks.

Severity: High when it hides failures in payments, sync, auth or data writes; Medium otherwise.

## Reporting

For each smell you report: where (`file:line`, and how many occurrences you found), why it matters in this project, and the severity. Group repeated occurrences into one finding with a count and two or three representative locations. If a smell is absent, you can say so in one line; absence is useful information.
