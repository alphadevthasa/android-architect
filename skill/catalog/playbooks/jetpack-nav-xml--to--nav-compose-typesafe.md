---
id: jetpack-nav-xml--to--nav-compose-typesafe
dimension: navigation
from: jetpack-nav-xml
to: nav-compose-typesafe
title: Navigation XML graphs to type-safe Navigation Compose
irreversible: false
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves in-app navigation from XML navigation graphs (with Safe Args or bundle arguments) to Navigation Compose with type-safe routes: route classes or objects annotated with `@Serializable` from kotlinx.serialization. The type-safe API arrived in a Navigation 2.x release (2.8.0, as far as the author remembers; check the current documentation for the minimum version). Navigation 3, a separate library, is the newer option for Compose-only apps; check whether it fits before choosing Navigation Compose for a new target. Written from memory of https://developer.android.com/guide/navigation and https://developer.android.com/guide/navigation/design/type-safety; check the current documentation before relying on a detail. Run this after most screens use Compose (see the XML to Compose playbook); the string-route Compose step is skipped here.

## When it is worth it

Most screens are composables and Fragments exist only to host them, so the XML graph and Safe Args generation add indirection. Type-safe routes remove string-built route and argument errors at compile time.

## When not to

Most screens are still Fragments and Views (convert the screens first), or the XML graph is shared with features that cannot move yet. Navigation that works and is not changing can stay on XML graphs.

## Preconditions

- Every destination, argument (type, nullability, default), action, deep link, nested graph and result passing (`setFragmentResult`, saved state handle) in the XML graphs is listed.
- Every deep link and app link entry point is listed, with its manifest intent filters and `android:exported` settings.
- The destinations to convert are composable or hosted by a `ComposeView`.
- The kotlinx.serialization plugin is configured in the module.

## Steps

No persisted data changes in this migration, so it is reversible per unit. The back stack and arguments are in-memory (and restored through saved instance state), so test process death.

1. Inventory the graphs and write down for each destination its argument types and deep links.
2. Define the seam: a small navigation interface or callback set per feature (for example `onOpenDetail(id)`), so screens and ViewModels do not call the `NavController` or the generated Safe Args directions directly. Pass identifiers, not large objects.
3. Define the route types with kotlinx.serialization: each destination becomes a `@Serializable` object (no arguments) or data class (arguments), with the same argument types and defaults as the XML destination. Custom argument types need a `NavType`; prefer primitive identifiers, check the documentation.
4. Run both navigation systems side by side during migration: a Navigation Compose `NavHost` hosted inside a Fragment (or an Activity) next to the XML graph, with the seam deciding which one handles a given navigation event behind a flag. Read the flag once on the host Activity's first creation and keep the chosen value in saved state, so a restored back stack is always restored by the system that saved it; a flag change applies only when the Activity is created fresh, not restored. Flipping it across saved state makes the restore fail (destination not found) or drop the stack. Moving the whole app at once is not needed.
5. Do the per-unit cutover: move one feature graph (a nested graph and its destinations) at a time. Register destinations with `composable<Route>`, navigate with `navController.navigate(Route(...))`, read arguments with `backStackEntry.toRoute<Route>()` (or the ViewModel's `SavedStateHandle.toRoute`, check the documentation), and move deep links to `deepLinks = listOf(navDeepLink<Route>(basePath = ...))` for that destination.
6. Recreate behavior: `popUpTo` and `launchSingleTop` options, nested graphs (`navigation<Route>`), start destinations, result passing, and the up and back behavior of each former action.
7. When the last graph has moved, make the Activity host the `NavHost` directly, and delete the XML graph files, the `NavHostFragment`, the Safe Args plugin and generated classes, the hosting Fragments, the flag and the navigation-fragment dependencies.

## Pitfalls

- Deep links: the XML `<deepLink>` and the manifest `<nav-graph>` element generated intent filters; with Compose they must be declared explicitly in the manifest and registered in the `NavHost`, or external links stop working. Test every link.
- Back handling: a `NavHost` nested in a Fragment that is itself a destination of the XML graph creates two back-press handlers (the Fragment navigation and the Compose navigation); define which one consumes back, and test it.
- Back stack: Compose navigation builds a synthetic back stack for deep links from the graph structure; compare the back behavior of each external entry point with the old one.
- Arguments: types, nullability and defaults must match; changing a route class later changes the URL pattern for deep links. A destination restored after process death re-creates its arguments from the serialized route, so every route field must be serializable.
- Do not pass large or sensitive objects through routes; arguments end up in the back stack state and saved state. Pass an id and load from a repository.
- Result passing between destinations differs (`SavedStateHandle` of the previous back stack entry, or a shared ViewModel); old `setFragmentResult` calls do not cross into composables.
- Shared ViewModels scoped to a nav graph need the equivalent back stack entry scoping (`hiltViewModel` or `viewModel` with the entry as owner; check the documentation).
- Transitions and animations are defined differently; confirm them per screen.

## Tests

- Navigation tests with `TestNavHostController` and `createComposeRule`: each route reaches its screen with the expected arguments.
- Deep link tests: an intent with each URI opens the right destination with the right back stack; invalid, missing or malformed arguments do not crash and land on a safe destination.
- Back stack tests: up and back from each destination match the old behavior.
- Process-death test: navigating deep into a graph, killing the process and returning restores the destination and its arguments.
- Process-death plus flag-flip test: save state under the XML system, kill the process, flip the flag, and assert the restore still uses the XML system (and the reverse); a new task uses the new value.
- Side-by-side test: the same navigation event reaches the same destination in both systems.

## Security checklist

- Exported deep-link activities and intent filters are re-validated: list every Activity with an intent filter, confirm that `android:exported` is set explicitly and is true only for destinations that must be reachable from outside, and compare the new manifest to the old generated filters so that moving the graph did not add or widen an exported entry point (a `<nav-graph>` removal that is replaced by hand-written filters is the usual place for this to go wrong). Use verified app links (`android:autoVerify`) for HTTPS links, and no wildcard hosts that were not in the old filters.
- Argument validation: values arriving from a deep link or external intent (ids, URLs, tokens, redirect targets) are validated and treated as untrusted in the destination or its ViewModel (type, range, length, allow list for hosts and schemes), and defaults for missing arguments do not grant access or skip a check.
- No untrusted URI parsing regressions: the old code might rely on `NavArgument` types or the Safe Args generated parsing to reject malformed input; the new route deserialization behaves differently (check the current documentation), so keep explicit parsing and validation of URIs, query parameters and redirect URLs, and do not navigate to a destination given by an external `Uri` without an allow list.
- Authentication gates still apply: a deep link into a protected destination goes through the same sign-in check as before, and the synthetic back stack does not let the user reach a protected screen without it; sensitive data is not placed in routes (they appear in saved state and logs).
- Routes and arguments are not logged with sensitive values.

## Rollback

Per feature graph: switch the flag back to the XML graph for new tasks (running tasks keep the system that saved their state), which stays in the code (graph files, Safe Args, hosting Fragments, manifest filters) until the last graph has shipped and soaked. Keep the old manifest intent filters until the deletion step, and keep both entry points consistent while both exist. After step 7 deletes the XML graphs, restore them from version control.
