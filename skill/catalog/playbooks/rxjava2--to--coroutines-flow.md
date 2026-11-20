---
id: rxjava2--to--coroutines-flow
dimension: async
from: rxjava2
to: coroutines-flow
title: RxJava 2 to Kotlin coroutines and Flow
irreversible: false
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves reactive code from RxJava 2 (`io.reactivex` packages) to Kotlin coroutines and Flow with the `kotlinx-coroutines-rx2` bridge module. The shared concepts (cold versus hot, operator mapping, error semantics, testing) are in the RxJava 3 playbook; read that one for the detail, and use this one for what differs. RxJava 1 projects move to RxJava 2 first (the catalog path) and then use this playbook. Written from memory of https://kotlinlang.org/docs/coroutines-guide.html; check the current documentation before relying on a detail.

## When it is worth it

The project is on RxJava 2, which is no longer the current Rx major version, and the team would rather move to coroutines than do an Rx 2 to Rx 3 upgrade first. New code is already written in coroutines, so every boundary carries an adapter.

## When not to

Large, stable Rx pipelines that are rarely touched: leaving them behind the bridge is a legitimate end state. Also not when many third-party libraries still hand out RxJava 2 types and cannot be changed; keep the bridge at that edge.

## Preconditions

- Every place that creates or subscribes to an Rx stream is listed, with the Rx 2 base types in use (`Observable`, `Flowable`, `Single`, `Maybe`, `Completable`) and the `RxJavaPlugins` hooks.
- Repositories and data sources sit behind interfaces (the seam) or can be put behind one first.
- The `kotlinx-coroutines-rx2` version matches the `kotlinx-coroutines` version used in the project.

## Steps

No persisted data changes in this migration, so it is reversible per unit. The same safe ordering as in the RxJava 3 playbook applies: the Rx implementation and the switch stay until the last unit has soaked, and only one implementation performs side effects for a request.

1. Inventory the Rx 2 usage, including `Maybe` and `Completable` sites and every `Disposable` holder, and mark streams as cold or hot.
2. Define the seam: repository and use-case interfaces expose `suspend` functions and `Flow`, with no `io.reactivex` types in signatures.
3. Add `kotlinx-coroutines-rx2`. It provides the same bridges as the rx3 module, in the rx2 package (`asFlow()` for `Observable` and `Flowable`, `await()` for `Single` and `Completable`, `rxSingle` and `rxObservable` builders, `asObservable()` and `asFlowable()`). Check the current documentation for the exact set, including how `Maybe` is awaited.
4. Convert bottom-up (data sources first, ViewModels next, UI collectors last), mapping operators as you go using the table in the RxJava 3 playbook (`subscribeOn` to `flowOn`, `switchMap` to `flatMapLatest`, `combineLatest` to `combine`, subjects to `StateFlow` or `SharedFlow`). Rx 2 specifics: `Flowable` honors backpressure and a Flow suspends, so pick `buffer` or `conflate` where `onBackpressureDrop` or `onBackpressureLatest` was used; `Observable` and `Flowable` forbid null items; and `RxJavaPlugins` in Rx 2 reports undeliverable errors the same way as in Rx 3.
5. Run the Rx 2 implementation and the coroutine implementation side by side behind a switch for one unit and compare results in tests.
6. Do the per-unit cutover: one screen or feature at a time, shipped and soaked, with the Rx implementation kept.
7. When every unit has moved and no Rx type remains in signatures, delete the Rx implementations, the bridge calls, the switch and the first-party Rx dependencies. Keep the `RxJavaPlugins` error handler until no RxJava remains in the runtime dependency tree.

## Pitfalls

- Undeliverable errors: after disposal or cancellation, an error from a bridged `rxSingle` or `rxCompletable` is routed to `RxJavaPlugins.onError` as `UndeliverableException`, and without `RxJavaPlugins.setErrorHandler` the app crashes. This becomes more frequent during the migration. Install the handler before the first bridge ships and keep it until no RxJava is left in the runtime dependency tree (third-party SDKs may still bring it).
- Exceptions in `launch` inside `viewModelScope` without a `CoroutineExceptionHandler` still crash the app.
- Cooperative cancellation: a broad `catch (e: Exception)` swallows `CancellationException`; rethrow it.
- `Schedulers.io()` is unbounded and `Dispatchers.IO` is capped (64 threads by default).
- Mixed Rx 2 and Rx 3 in one app (through a library) means two sets of types and two `RxJavaPlugins` classes; convert the bridge module that matches each type.
- `retryWhen` token-refresh logic must be rebuilt with a single in-flight refresh.

## Tests

- Characterization tests: the same inputs through both implementations give the same emissions, order and terminal state.
- Undeliverable error test: cancel a bridged `rxSingle` while it fails; the handler receives the error and the app does not crash.
- Token refresh test: a 401 triggers exactly one refresh under concurrent calls, then one retry.
- Cancellation test: leaving the screen cancels the in-flight request, and a cancelled operation leaves no half-written state.

## Security checklist

- Error handlers that logged or swallowed errors (`onError`, `onErrorReturn`, `RxJavaPlugins.setErrorHandler`) are found and their duties re-implemented: security-relevant failures (authentication, certificate, integrity) are still reported or still force a safe state, and are not hidden by a new broad `catch`.
- The `RxJavaPlugins` error handler keeps its crash-avoidance duty for undeliverable errors until no RxJava remains in the runtime dependency tree, and it must not log error messages that contain tokens or personal data.
- Auth-token refresh keeps working: a `retryWhen`-based refresh is replaced by a single-flight refresh (a `Mutex` or an OkHttp `Authenticator`), never loops, and signs the user out when the refresh fails.
- Scheduler-based serialization of access to credentials, session state or cipher objects keeps an equivalent guarantee (`Mutex`, `limitedParallelism(1)`), and scopes holding session data are cancelled on logout.

## Rollback

Per unit: flip the switch back to the Rx 2 implementation, which stays in the code until the last unit has shipped and soaked. No persisted state changes, so the flip loses no data. After step 7 deletes the Rx code, restore it from version control.
