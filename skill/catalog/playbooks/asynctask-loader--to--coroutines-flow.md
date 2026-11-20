---
id: asynctask-loader--to--coroutines-flow
dimension: async
from: asynctask-loader
to: coroutines-flow
title: AsyncTask and Loaders to Kotlin coroutines
irreversible: false
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves background work from `AsyncTask` and `Loader` (`LoaderManager`, `AsyncTaskLoader`, `CursorLoader`) to Kotlin coroutines, with Flow for streams of results. Both APIs are deprecated. Written from memory of https://developer.android.com/kotlin/coroutines and https://developer.android.com/topic/libraries/architecture/coroutines; check the current documentation before relying on a detail.

## When it is worth it

The code base still contains deprecated `AsyncTask` or Loader code that leaks activities, loses results on rotation, or is hard to cancel and to test. It is a prerequisite for moving off old support libraries and for adopting lifecycle-aware components.

## When not to

Dead code that is scheduled for deletion; or a screen about to be rewritten anyway (convert it as part of the rewrite instead of twice).

## Preconditions

- Every `AsyncTask` subclass and Loader is listed, with its trigger, its inputs, what it does in `onPostExecute` and what happens on cancel.
- The coroutines dependencies and `lifecycle-viewmodel-ktx` or `lifecycle-runtime-ktx` are available in the module.
- Long-running work that must outlive the screen (uploads, downloads, sync) is identified, because a screen-scoped coroutine does not outlive the screen.

## Steps

Moving screen-scoped work to coroutines changes no persisted data, so that part is reversible per unit. Moving work that must outlive the screen to WorkManager (step 5) does add persisted state: enqueued work is stored by WorkManager, so the Worker class and its name must stay in rollback builds (see Rollback).

1. Inventory the tasks and loaders. For each, record: where it starts, whether it must survive rotation, whether it must survive leaving the screen, how it reports progress, and how its result reaches the UI.
2. Define the seam: a repository or use-case interface with `suspend` functions (one-shot work) or `Flow` (loader-style observation of data), with no `AsyncTask`, `Loader` or `Callback` types in signatures. Inject the dispatcher so tests can replace it.
3. Implement the seam with coroutines: blocking work runs in `withContext(Dispatchers.IO)`; blocking calls that must be cancellable can use `runInterruptible`; a `CursorLoader` becomes a Flow from the database layer (Room returns `Flow` directly) rather than a hand-written cursor observer.
4. Run the old AsyncTask or Loader and the new implementation side by side behind a flag for one unit, and compare results in tests. Only one of them performs side effects (writes, uploads) for a given request; the other is read-only or disabled, to avoid double execution.
5. Choose the scope per task. Work tied to a screen and surviving rotation: `viewModelScope`. Work that must stop with the view: `lifecycleScope` and, for streams, `repeatOnLifecycle(Lifecycle.State.STARTED)`. Work that must survive the screen or the process: not a scope, but a service or WorkManager (see the checklist).
6. Do the per-unit cutover: switch one screen at a time. Replace `onPostExecute` UI updates with state exposed from the ViewModel and collected in the UI, replace `cancel(true)` with job cancellation, and replace `LoaderManager.initLoader` callbacks with collection of the Flow.
7. Delete the AsyncTask subclasses, Loader classes and callbacks, the flag and the old tests after the last unit has shipped and soaked.

## Pitfalls

- Cancellation is cooperative: `AsyncTask.cancel(true)` interrupted the thread, a coroutine only stops at a suspension point. Long loops need `ensureActive()` or `isActive` checks, and blocking IO needs `runInterruptible`.
- `AsyncTask` ran tasks serially on a shared executor by default; coroutines run in parallel. Code that relied on that ordering (two tasks updating the same file or counter) needs a `Mutex` or a single-thread dispatcher.
- A screen-scoped coroutine is cancelled when the ViewModel is cleared or the lifecycle ends; an `AsyncTask` often kept running. Decide on purpose whether the work should be cancelled.
- Do not use `GlobalScope`; it recreates the leak problem. Use an injected application-level scope only for work that really is process-wide.
- Exceptions: `AsyncTask` crashed the app on an uncaught exception in `doInBackground`; in a `launch` inside `viewModelScope` without a `CoroutineExceptionHandler` the exception still crashes the app, so it is not swallowed by default; handle it where the result is produced. Catch and map errors where the result is produced, and rethrow `CancellationException`.
- Loader callbacks were delivered on the main thread and tied to the Activity lifecycle; a collected Flow must be started with `repeatOnLifecycle`, or it keeps collecting while the UI is stopped.
- Progress updates (`publishProgress`) become a `Flow` of progress states or a `StateFlow`; do not update views from `Dispatchers.IO`.

## Tests

- A test per converted unit with a test dispatcher (`runTest`): the result reaches the state holder and, on failure, an error state does.
- Cancellation tests: cancelling the scope stops the work (assert via a fake that records cancellation).
- Rotation test or ViewModel test: the work is not restarted when the screen is recreated.
- Ordering test where the old serial execution mattered.
- Side-by-side test: old and new implementations give the same result for the same input.

## Security checklist

- Work that outlived the screen stays alive: an upload, a download of user data, a payment confirmation, or a sync that an `AsyncTask` completed after the user left must not be silently cancelled by `viewModelScope` or `lifecycleScope`. Move it to a foreground service or WorkManager (with constraints, unique work names and retry policy) so it completes or fails in a controlled way, and do not place secrets in WorkManager input data, because it is stored unencrypted on disk (pass an identifier and read the secret from a secure store).
- Cancellation must not leave a half-finished security-relevant operation: a cancelled logout, token revoke or credential write is completed or rolled back in a `finally` block with `NonCancellable` where needed.
- Errors previously handled in `onPostExecute` (authentication failure, certificate errors) are still handled and are not lost in a `launch`.
- Results are not delivered to a screen that is gone, and sensitive results are not logged by new debugging code.

## Rollback

Per unit: switch the flag back to the AsyncTask or Loader implementation, which stays in the code until the last unit has shipped. Screen-scoped conversions change no persisted state. For work moved to WorkManager, work already enqueued is persisted: keep the Worker class (same fully qualified name) in every rollback build, or cancel the unique work before the rollback ships, otherwise the old build finds work whose class it does not have. Once the old classes are deleted in step 7, restore them from version control if needed.
