---
id: coroutines-livedata--to--coroutines-flow
dimension: async
from: coroutines-livedata
to: coroutines-flow
title: LiveData to StateFlow and SharedFlow
irreversible: false
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves ViewModel state exposed as `LiveData` to `StateFlow` (state) and `SharedFlow` or `Channel` (events), collected with lifecycle awareness. Written from memory of https://developer.android.com/kotlin/flow/stateflow-and-sharedflow and https://developer.android.com/topic/libraries/architecture/livedata; check the current documentation before relying on a detail.

## When it is worth it

The data layer already uses Flow, and `LiveData` only exists in the ViewModels as a conversion layer (`asLiveData`). The team wants one asynchronous model, Flow operators in ViewModels, Compose (`collectAsStateWithLifecycle`) or Kotlin Multiplatform sharing of ViewModel code.

## When not to

Screens that work and are not otherwise touched, especially with Data Binding that uses LiveData directly; LiveData remains supported. Do not convert only for style.

## Preconditions

- Every `LiveData`, `MutableLiveData`, `MediatorLiveData` and `Transformations` use in ViewModels and UI is listed.
- The UI observes through a small set of patterns (observe in `onViewCreated`, Data Binding, Compose `observeAsState`) so the replacement is mechanical.
- Events (navigation, snackbars, dialogs) delivered through `LiveData` (including `SingleLiveEvent` or `Event` wrappers) are listed separately from state.
- Any `SavedStateHandle.getLiveData` use is listed; keys and types must stay unchanged, because they are persisted across process death.

## Steps

No persisted data changes in this migration if `SavedStateHandle` keys and types stay the same, so it is reversible per unit.

1. Inventory LiveData by role: state (always has a value), derived state (`Transformations`, `MediatorLiveData`), and one-time events.
2. Define the seam: the ViewModel exposes state through a small contract. For a first step, expose the new `StateFlow` next to the old `LiveData` (`stateFlow.asLiveData()` or `liveData.asFlow()` bridges), so the UI moves independently of the ViewModel. Keep Android types out of the new signatures.
3. Convert state: `MutableLiveData<T>` becomes `MutableStateFlow<T>` with an initial value, exposed read-only as `StateFlow<T>`. Derived state from a Flow becomes `stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), initial)`. `Transformations.map` becomes `map`, `switchMap` becomes `flatMapLatest`, and `MediatorLiveData` becomes `combine`.
4. Convert events: model them as part of state that the UI consumes explicitly (an event field that the UI reports as handled), or use a `Channel` exposed with `receiveAsFlow()` where each event must be handled once. Do not model one-time events as `StateFlow` values or as a `SharedFlow` with `replay`, which redelivers them after rotation. Decide per event and test it.
5. Run the old LiveData and the new Flow side by side during the unit: the UI collects the Flow in the new code path (behind a flag) while the LiveData still exists. Collect with `repeatOnLifecycle(Lifecycle.State.STARTED)` inside `viewLifecycleOwner.lifecycleScope.launch` in a fragment (or `lifecycleScope` in an activity), and `collectAsStateWithLifecycle()` in Compose; check the current documentation for the artifact that provides it.
6. Do the per-unit cutover: move one screen (ViewModel plus its UI) at a time, switch the UI to the Flow, then remove that ViewModel's `LiveData`. Data Binding with Flow needs a lifecycle owner set on the binding; check the current documentation for Flow support there.
7. Delete the bridges (`asLiveData`, `asFlow`), the event wrappers, the flag and the LiveData imports after the last unit has shipped and soaked.

## Pitfalls

- A `StateFlow` always has a value and compares by equality: setting an equal value emits nothing (LiveData would notify). A mutated object reused in place will not re-emit; use immutable state and `copy`.
- `StateFlow` is conflated: a slow collector sees only the latest value. That is right for state and wrong for events.
- Collecting in `lifecycleScope.launch { flow.collect { } }` without `repeatOnLifecycle` keeps collecting while the UI is stopped (and in the background); this is the most common mistake in conversions.
- With `WhileSubscribed(5_000)` the upstream stops when no collector remains, and restarts later; do not put side effects with ordering needs in a shared upstream.
- A fragment must collect in `viewLifecycleOwner`, not the fragment's own lifecycle, or it collects twice after the view is recreated.
- Events through `Channel` can be dropped if no collector is active and the buffer is full; test rotation and background transitions.
- `SavedStateHandle`: switch to its Flow accessor only if keys and types stay the same, else users lose restored state after process death.

## Tests

- ViewModel tests with `runTest` and `Turbine` or a manual collector: assert the sequence of state values for an action.
- Event test: each event is handled exactly once, not again after rotation (recreate the collector) and not lost while the UI is stopped.
- Lifecycle test: no collection while the lifecycle is below STARTED (use a test lifecycle owner).
- Process-death test where `SavedStateHandle` is used: values come back after recreation.
- Side-by-side test: the LiveData bridge and the Flow produce the same values for the same actions.

## Security checklist

- Sensitive state is not retained or logged for longer than before: a `StateFlow` keeps its latest value for the life of the ViewModel even with no collectors (`WhileSubscribed` stops the upstream, not the stored value), so clear fields that hold one-time codes, tokens or personal data on logout, on screen exit or after use (set them to an empty state), and check the retention against the LiveData behavior.
- Do not model secrets as replayed events: a `SharedFlow` with `replay` or a state-based event redelivers a one-time password, deep-link token or error detail after rotation; use a consumed-once event and clear it.
- No new `onEach { log(it) }`, `println` or debug collectors print state objects: data classes print all fields in `toString`, which exposes secrets in logs; override `toString` or exclude those fields.
- Sensitive values are not stored in `SavedStateHandle` or any key that the migration adds, since it is written into the saved instance state (and may be restored after process death).

## Rollback

Per unit: while the bridges exist, the UI can collect the `LiveData` again by switching the flag back; both are fed from the same source, so there is no state loss. After step 7 removes the LiveData, restore it from version control. Keep `SavedStateHandle` keys unchanged so a rolled-back build restores the same state.
