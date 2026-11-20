# Reusable components: rules

How to decide what becomes a shared component, where it lives and how it is kept consistent. Used by the planning and review workflows together with `.ai/knowledge/components.md`.

## Detect first

`node scripts/reuse.js <root>` lists what the project already duplicates: identical XML layout structures, `@Composable` functions with the same parameter types and the same ordered calls, copied utility functions, competing `Base*` classes (activity, fragment, view model), repeated error-handling and HTTP client builder blocks, and hardcoded colors and dp values. Everything it reports comes with `file:line` evidence. Treat the report as a list of candidates, not as a verdict.

## Rule of three

- Do not extract a shared component from one use. Wait for the third real use, then extract; two uses are a coincidence.
- Exception: a detected duplicate group of two that must change together (a copied formatter, two layouts that always drift apart) can be extracted early when the planner can show the shared reason to change.
- Extract by the real behavior the uses share, not by how the code looks. Components with a flag per caller are two components.

## No catch-all `common` module

- A module called `common`, `utils` or `shared` that accepts everything becomes a dependency of everything and a reason to rebuild everything.
- Put a component where its meaning lives: UI building blocks in the design system, domain helpers in the domain or feature they belong to, formatting in a small module named for what it formats.
- When a catch-all module already exists, do not add to it. Move items out when you touch them, and list the moves as roadmap steps.

## Design system first, with XML interop

- Shared UI goes into the design system module first (an existing `designsystem`, `design-system`, `core-ui` or `ui` module, or a new `:core:designsystem`). Feature modules depend on it; it depends on no feature.
- Tokens come before components: colors, typography, spacing and shape as named values. Replace hardcoded colors and dp values with tokens as components move.
- In a project that still uses XML views, expose each new Compose component to XML screens through `ComposeView` (or a thin wrapper view) so both worlds use one implementation during the migration. Do not keep two copies.
- Do not move a component across the module boundary and change its behavior in the same step.

## Preview and screenshot test per component

- Every shared component has a `@Preview` for its main states (default, empty, error, long text) and one screenshot test that locks the rendering.
- A component without both is not finished. A change to the component updates the screenshot in the same pull request.

## Size the shared-module set to the project

- A small app needs one design-system module, or even a package inside the app module. Do not create `core-ui`, `core-common`, `core-testing` and `core-network` for a project with three screens.
- Add a shared module when two or more modules need the same thing and the code has a stable owner. Name it after its contents.
- Keep the module count proportional to the team: every module adds build configuration, ownership and review work.

## Keep the registry current

- `.ai/knowledge/components.md` has a curated section you own (name, module, purpose, usage example) and a generated block the tool rewrites on every refresh. Add extracted components to the curated section.
- Before creating a UI component or utility, look in the registry and in the design system. Reuse or extend what exists.
- Review flags new code that duplicates a registered component.
