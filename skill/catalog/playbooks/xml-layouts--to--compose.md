---
id: xml-layouts--to--compose
dimension: ui
from: xml-layouts
to: compose
title: XML Views to Jetpack Compose
irreversible: false
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves screens from XML layouts (with `findViewById`, View Binding or Data Binding) to Jetpack Compose, one screen at a time, using interoperability in both directions. Because Compose and Views interoperate, there is no big-bang rewrite and no stored data changes, so the move is reversible. Written from memory of https://developer.android.com/develop/ui/compose/migrate and https://developer.android.com/develop/ui/compose/migrate/interoperability-apis; check the current documentation before relying on a detail. Projects that still use `findViewById`, Butter Knife or synthetics can use this playbook directly for screens they convert, without first moving to View Binding.

## When it is worth it

New screens are already written in Compose, the team wants one UI toolkit, state-driven UI, easier theming and previews, or the XML layouts are costly to maintain (deep nesting, many variants).

## When not to

Stable screens that rarely change, heavy custom `View` drawing, or screens built on views that have no good Compose equivalent yet (for example a complex `WebView` or map integration, which stay wrapped in `AndroidView`). A release with a hard deadline is not the time to start. Staying on XML for the long tail is a legitimate outcome.

## Preconditions

- The screens are inventoried with size, complexity, usage frequency and the custom views each uses.
- Business logic sits in ViewModels or presenters that expose state, not in Activities and Fragments; if not, extract it first (the seam).
- A design system or theme exists (colors, typography, shapes) that can be expressed as a Compose theme; a Material components bridge may help (check the current documentation).
- The Compose compiler setup and BOM are configured in the module (check the current documentation for the Kotlin version rules).
- Screens that carry sensitive content (login, payments, personal data) are listed with their window flags, input handling and accessibility behavior.

## Steps

1. Inventory every screen and layout. Rank by risk and value: start with a small, isolated, low-risk screen (a settings or about screen), not login or payment.
2. Define the seam: a screen state class and a set of event callbacks exposed by the ViewModel (state in, events out), with no View types. The same ViewModel must serve both the XML and the Compose versions of the screen.
3. Add Compose to the module and create the theme that mirrors the XML theme.
4. Build the Compose version of the screen as a stateless composable that takes state and callbacks, and run it side by side with the XML version behind a flag: the Fragment or Activity either inflates the XML layout or hosts the composable. In an existing Fragment, host Compose through `ComposeView` (in XML or created in code) and set the composition strategy suited to Fragment views (`ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed`, check the documentation); in an Activity use `setContent`.
5. Where a Compose screen needs an existing View (a `WebView`, a map, a custom chart, an ad view), wrap it with `AndroidView` (factory to create and configure, update to apply state), and where an XML screen needs a new composable, use `ComposeView`. Convert the container screen first, then the leaf custom views.
6. Do the per-unit cutover: switch one screen at a time to the composable, ship it behind the flag, and check metrics and crashes. Read the flag once when the screen is first created and keep the chosen value in saved state, so a restored screen uses the UI that saved its state and a remote flag flip applies only to a fresh screen. Keep the flag until the last screen has shipped; it is removed in step 8.
7. Move navigation last: once most screens are composables, host them in a Compose navigation graph (see the navigation playbook); until then, keep Fragments and the existing Navigation component hosting `ComposeView`.
8. Delete the XML layouts, View Binding classes, adapters and custom views of each converted screen, the flags, and finally unused XML resources, view binding or data binding build options, and Material View dependencies after the last screen has shipped and soaked.

## Pitfalls

- State: never keep state in `remember` that must survive rotation or process death; use `rememberSaveable` or the ViewModel. Collect Flow state with lifecycle awareness (`collectAsStateWithLifecycle`).
- Recomposition cost: unstable parameters and lambdas recreated on every pass cause extra work; check the Compose performance documentation, and use lazy lists with stable keys instead of a `Column` of many items.
- `ComposeView` in a Fragment: a wrong composition strategy leaks or disposes the composition at the wrong time; a `RecyclerView` item that hosts a `ComposeView` needs the strategy for pooled views (check the documentation).
- Theming mismatch: values from the XML theme (night mode, dynamic color, density) must be mirrored, or the two toolkits look different on one screen.
- `AndroidView` is not recomposed like a composable: updates go through its `update` block, and views that hold resources need release in `onRelease`.
- Insets, keyboard handling (`windowSoftInputMode`, `imePadding`) and edge-to-edge behave differently and should be tested on each screen.
- Screenshot and UI tests written against view ids and Espresso matchers must be rewritten with the Compose test APIs and semantics; plan for a period with both.
- A remote flag that flips between the XML and the Compose version while a screen is restored after process death can restore state into the wrong UI; read the flag once on first creation and keep it in saved state.
- Process death and configuration changes: the saved state of views (text typed into an `EditText`) is not restored automatically for composables unless state is saved.

## Tests

- Compose UI tests with `createComposeRule` for the new screen and the same scenarios as the old Espresso tests; keep the old tests running against the XML version while both exist.
- Screenshot tests (if used) for both versions of a screen, compared per theme and font scale.
- State tests on the ViewModel remain unchanged and are shared by both UIs.
- Accessibility test: TalkBack order, content descriptions and minimum touch target size on the new screen (see the checklist).
- Rotation and process-death test for each converted screen.

## Security checklist

- `FLAG_SECURE` and screenshot blocking are preserved: if the XML screen's Activity or window set `WindowManager.LayoutParams.FLAG_SECURE` (or the app disables screenshots and the recent-apps preview for sensitive screens), the Compose version and any new Activity must set it too. For Compose dialogs, popups and bottom sheets, the `DialogProperties` and `PopupProperties` (and the sheet properties) carry a `securePolicy` of type `SecureFlagPolicy`: the default `Inherit` copies the parent window's flag, so set `SecureFlagPolicy.SecureOn` on sensitive ones (or verify that `Inherit` really gives a secure window) and flag any `SecureOff`. View-based dialogs (`Dialog`, `BottomSheetDialog`) do not inherit the flag, so keep checking each of them. Verify with a manual screenshot and recent-apps check.
- WebView settings carried over: when a `WebView` moves into `AndroidView`, recreate every setting from the XML version (JavaScript enabled or not, file and content access, mixed content, `WebViewClient` URL allow list, safe browsing, `addJavascriptInterface` exposure, cookie handling), release it in `onRelease`, and do not let the new factory fall back to defaults.
- Input masking for password fields: password and PIN fields use a masking visual transformation and the password keyboard type (the equivalent of `inputType="textPassword"`), keep autofill hints and disable suggestions and clipboard-related leaks where the XML did; no input is written to logs or to `rememberSaveable` state unless that is deliberate.
- Accessibility is not regressed: content descriptions, labels, roles and semantics, focus order, minimum 48dp touch targets and announcements (including security warnings and error text) are carried over and checked with TalkBack. Obscured-touch protection (`filterTouchesWhenObscured`) set on views of sensitive confirmation screens is preserved on the host view; check the current documentation for the Compose equivalent.
- Sensitive text shown by a composable is not captured in logs, previews or screenshot-test artifacts committed to the repository.

## Rollback

Per screen: switch the flag back to the XML version, which stays in the code (layouts, binding classes and the XML path in the Fragment) until the last screen has shipped and soaked. No persisted state changes, and the ViewModel is shared, so the flip loses nothing. After step 8 deletes the XML for a screen, restore it from version control if needed.
