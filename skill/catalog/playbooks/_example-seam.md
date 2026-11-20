---
id: okhttp-retrofit--to--ktor-client
dimension: networking
from: okhttp-retrofit
to: ktor-client
title: Retrofit to Ktor client (format example)
irreversible: false
kmpOnly: true
worthIf:
  - present:kmp
asOf: 2026-11-20
verified: false
---

This file documents the playbook format. It is skipped by the loader (the name starts with `_`); a real playbook is named `<from>--to--<to>.md`.

## When it is worth it

Retrofit to Ktor is worth it mainly with Kotlin Multiplatform: it lets the networking layer be shared across targets.

## When not to

The app is Android-only and the current client works. A client swap alone changes no user-visible behavior.

## Preconditions

- The current networking calls sit behind a small interface (the seam) or can be put behind one first.
- Integration tests cover the main request paths.

## Steps

1. Define the seam: an interface the features call instead of the HTTP client types.
2. Implement the seam on the new client and run both implementations side by side behind a switch.
3. Do the per-unit cutover: move one feature at a time to the new implementation and ship it.
4. When every unit has moved, delete the old implementation and its dependencies.

## Pitfalls

- Interceptors, authenticators and certificate pinning must be re-created on the new client.
- Error mapping differs: check timeouts, redirects and non-2xx handling.

## Tests

- Run the same contract tests against both implementations during the side-by-side phase.

## Security checklist

- Certificate pinning and the trust configuration behave the same on the new client.
- Tokens and headers are not logged by the new client's logging plugin.
- Cleartext traffic is still refused.

## Rollback

Flip the switch back to the old implementation per unit; keep the old code until the last unit has shipped and soaked.
