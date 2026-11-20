# Modularization

Notes for the modularization dimension: how to split a project into Gradle modules, and what to avoid. Facts here are general guidance, not tied to a tool version; check the current documentation for exact plugin syntax.

## Layer modules and feature modules

- **Layer modules** group by technical layer (`data`, `domain`, `ui`). They are easy to start with, but every feature change touches several modules and the modules grow into catch-all buckets.
- **Feature modules** group by product feature (`feature:login`, `feature:profile`). A feature owns its screens, view models and its feature-specific data code. Shared building blocks live in small core modules (design system, networking, common models), named for what they contain.
- A common shape combines both: core modules by layer or capability, and feature modules on top. Features do not depend on each other; they meet at the app module or through a navigation contract.

## api and impl

Split a module into an `api` module (interfaces and models other modules need) and an `impl` module (the implementation) when several consumers need only the contract, or when you want the implementation to change without rebuilding its consumers. Do not split by reflex: a module with one consumer does not need it. Consumers depend on `api`; only the app module (or the dependency graph root) depends on `impl`.

## Polyrepo and mono repo

- A **mono repo** keeps all modules in one Gradle build: atomic cross-module changes, one version of every dependency, one CI pipeline. It needs build performance care (configuration cache, build cache, parallel execution).
- A **polyrepo** keeps modules or apps in separate repositories and shares code as published libraries. Teams are independent, but every shared change needs a release, versions drift, and a cross-repo refactor is a coordinated rollout.
- The migration tooling treats a workspace with several repositories as separate projects with a shared hub for decisions; plan each repository on its own.

## Convention plugins

When many modules repeat the same build configuration (Android settings, Kotlin options, test setup), move it into convention plugins in an included build, and apply them by id in each module. This keeps module build files short, makes the shared setup one change instead of one per module, and lets a fitness check enforce which plugin a module uses. Prefer a version catalog for dependency versions.

## Rules of thumb

- Introduce modules when there is a reason: build time, ownership boundaries, enforced dependencies. Not for symmetry.
- Keep the dependency graph acyclic and shallow; check it with the fitness rules generated from accepted ADRs.
- Never create a catch-all `common` or `utils` module; see `reuse.md`.
- Extract a module in its own pull request, with no behavior change.
