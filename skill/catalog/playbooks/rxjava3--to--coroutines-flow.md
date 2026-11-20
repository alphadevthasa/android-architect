---
id: rxjava3--to--coroutines-flow
dimension: async
from: rxjava3
to: coroutines-flow
title: RxJava to Kotlin coroutines and Flow
irreversible: false
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves reactive code from RxJava to Kotlin coroutines and Flow. This playbook is written for RxJava 3 and the `kotlinx-coroutines-rx3` bridge module; RxJava 2 projects follow the same steps with the `kotlinx-coroutines-rx2` module (and the `io.reactivex` packages). RxJava 1 projects should first move to RxJava 2 or 3 and then use this playbook. Written from memory of https://kotlinlang.org/docs/coroutines-guide.html and https://developer.android.com/kotlin/flow; check the current documentation for exact bridge function names before relying on a detail.

## When it is worth it

The team writes new code in coroutines and the project now carries two asynchronous models, with adapters at every boundary. Lifecycle-aware collection (`repeatOnLifecycle`), structured cancellation and simpler testing are wanted, or the code base is moving towards Kotlin Multiplatform where RxJava is not available.

## When not to

Large, stable Rx pipelines with complex operators (windowing, custom backpressure, `groupBy` trees) that work and are rarely touched: the rewrite risk is higher than the benefit. Also not while the team lacks coroutine experience or a release is close. Leaving a well-tested Rx module behind a bridge is a legitimate end state.

## Preconditions

- Every place that creates or subscribes to an Rx stream is listed, including `RxJavaPlugins.setErrorHandler`, schedulers hooks and `Disposable` holders (such as `CompositeDisposable`).
- Network, database and repository calls sit behind interfaces (the seam) or can be put behind one first.
- Tests exist for the main stream behaviors (ordering, retries, error paths).
- The team knows which streams are hot (Subjects, `publish().refCount()`) and which are cold.

## Steps

No persisted data changes in this migration, so it is reversible per unit. If a stream writes to a database or a preference store, keep that write path unchanged and migrate only the stream plumbing around it.

1. Inventory the Rx usage: streams, operators, schedulers, subjects, error handlers and disposal points. Mark each as cold or hot.
2. Define the seam: change the repository or use-case interfaces to expose `suspend` functions for one-shot results and `Flow` for streams, with no Rx types in signatures. Hot sources (`BehaviorSubject`, `PublishSubject`) become `StateFlow` or `SharedFlow` behind the same interface.
3. Add the bridge module (`kotlinx-coroutines-rx3`; use the matching version of `kotlinx-coroutines`, check the release notes). Bridges convert in both directions: an `Observable` or `Flowable` becomes a `Flow` (`asFlow()`), a `Single`, `Maybe` or `Completable` is awaited from a suspend function (`await()`), and a `Flow` becomes `Observable` or `Flowable` (`asObservable()` and `asFlowable()` with a coroutine context), with builders such as `rxSingle`, `rxObservable` and `rxCompletable`. Check the current documentation for the exact set.
4. Convert bottom-up: start with the leaves (data sources, API wrappers, database access), expose them through the seam as suspend or Flow, and use the bridge to adapt them for Rx callers that have not moved yet. Then convert the mapping and combining layers, then the ViewModels, and only at the end the UI collectors. Each converted layer keeps Rx callers working through the bridge.
5. Run the old Rx implementation and the new coroutine implementation side by side behind a switch (a build flag or a remote flag) for each unit, and compare results in tests; both read from the same source and neither writes the same data twice.
6. Map operators with care: `subscribeOn` becomes `flowOn` (affects upstream only) or `withContext`; `observeOn(AndroidSchedulers.mainThread())` becomes collecting on the main dispatcher; `Schedulers.io()` maps to `Dispatchers.IO` and `Schedulers.computation()` to `Dispatchers.Default`; `switchMap` to `flatMapLatest`; `flatMap` to `flatMapMerge` and `concatMap` to `flatMapConcat`; `combineLatest` to `combine`; `zip` to `zip`; `debounce` to `debounce` (check the current API status); `retryWhen` to `retry` or `retryWhen`; `CompositeDisposable.clear()` to cancelling a scope (`viewModelScope`, or `repeatOnLifecycle` in the UI).
7. Do the per-unit cutover: switch one screen or one feature at a time to the coroutine implementation, ship it, and let it soak. Keep the Rx implementation and the switch until the unit is stable.
8. When every unit has moved and no Rx type is left in signatures, delete the Rx implementations, the bridge calls, the switch, the `RxJavaPlugins` error handler (only after checking its security duties, see the checklist) and the Rx dependencies.

## Pitfalls

- Error semantics differ. In Rx, an error is delivered to `onError`, and with no handler it goes to `RxJavaPlugins.onError` and can crash. In coroutines, an exception thrown in `launch` goes to the parent scope and the exception handler; in `async` it is thrown at `await()`. A Flow completes exceptionally and `catch` only handles exceptions from upstream of it.
- Swallowed errors: Rx `onErrorReturn`, `onErrorResumeNext` and global handlers often hid failures. A blanket `try { } catch (e: Exception)` in a suspend function also catches `CancellationException` and breaks cancellation; rethrow it (and avoid `runCatching` around suspend calls without rethrowing).
- Cold versus hot: a Flow is cold; two collectors run the upstream twice. Use `shareIn` or `stateIn` (with `SharingStarted.WhileSubscribed`) where Rx used `share()`, `replay()` or `refCount()`.
- Null values: Rx forbids `null` items, Flow allows them; check mappers that relied on the NullPointerException.
- Backpressure: `Flowable` has explicit strategies; a Flow suspends the producer. Use `buffer`, `conflate` or `collectLatest` deliberately where Rx dropped or latest-ed items.
- Thread confinement: Rx code often relied on `observeOn(Schedulers.single())` or a serialized scheduler to protect mutable state. Coroutines on `Dispatchers.Default` or `IO` run in parallel; use a single-threaded confinement (`limitedParallelism(1)`) or a `Mutex` where that guarantee mattered.
- Disposal: a missed `dispose` was a leak, a missed `cancel` is too; tie every collection to a scope that ends with the screen or the ViewModel.
- Testing with `TestScheduler` does not carry over; use `runTest` and a test dispatcher, injected through the seam.

## Tests

- Characterization tests written before conversion: feed the same inputs through the Rx and the coroutine implementations and assert the same emissions, order and terminal state.
- Error path tests: a failing source must produce the same user-visible error and no crash; assert a thrown `CancellationException` is not turned into an error state.
- Retry and token refresh tests: a 401 followed by a refresh triggers exactly one refresh, even with several concurrent calls, then retries once.
- Cancellation tests: leaving the screen cancels the in-flight request.
- Use `runTest` with `StandardTestDispatcher`, and a test for each `shareIn` or `stateIn` that two collectors cause one upstream run.

## Security checklist

- Error handlers that logged or swallowed errors are found (`onError`, `onErrorReturn`, `RxJavaPlugins.setErrorHandler`) and each duty is re-implemented in the new code: security-relevant failures (authentication, certificate, tamper or integrity errors) must still be reported or must still force a safe state, and must not be hidden by a new broad `catch`.
- Auth-token refresh keeps working: if Rx code used `retryWhen` or an authenticator to refresh on a 401, the replacement refreshes once (guard with a `Mutex` or an OkHttp `Authenticator`), never loops, and signs the user out on a failed refresh; tokens are not logged by new `onEach` or `catch` blocks.
- No thread-confinement assumption is dropped: any code that relied on a single scheduler for sequential access to credentials, session state or a cipher instance keeps an equivalent guarantee (`Mutex`, single-thread dispatcher), since `Cipher` and similar objects are not thread-safe.
- Scopes holding session data are cancelled on logout, so no stream keeps emitting user data after sign-out.

## Rollback

Per unit: flip the switch back to the Rx implementation, which stays in the code until the last unit has shipped and soaked. No persisted state is changed, so the flip loses no data. After step 8 deletes the Rx code there is no switch; restore it from version control and treat later changes as new work.
