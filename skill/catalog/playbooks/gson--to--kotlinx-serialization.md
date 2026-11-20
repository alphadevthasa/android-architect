---
id: gson--to--kotlinx-serialization
dimension: serialization
from: gson
to: kotlinx-serialization
title: Gson to kotlinx.serialization
irreversible: false
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves JSON parsing from Gson to kotlinx.serialization. Written from memory of https://kotlinlang.org/docs/serialization.html; check the current docs before relying on a detail.

## When it is worth it

The project is Kotlin Multiplatform or will be, or it wants compile-time serializers with no reflection, and it uses Ktor (whose ContentNegotiation pairs with kotlinx.serialization). The compiler plugin generates serializers, so R8 and startup behave better than with reflection.

## When not to

The models are Java classes, or the code relies on Gson reflection over classes you do not own and cannot annotate. Also not when the team is staying with Retrofit and OkHttp on Android only and Moshi would be a smaller step.

## Preconditions

- Parsing happens behind a seam (a mapper, a converter factory, or a Repository), or can be put behind one first.
- Every `@SerializedName`, `TypeAdapter`, `JsonDeserializer`, `GsonBuilder` setting and date format in use is listed.
- The Kotlin serialization Gradle plugin can be applied to every module that holds models.
- Recorded JSON for each model exists, covering null, missing, extra and unusual fields.

## Steps

1. Inventory the Gson usage as in the Moshi playbook: models, names, adapters, naming policy, nulls, lenient mode.
2. Define the seam: an interface for encode and decode that features use instead of `Gson` types.
3. Apply the serialization plugin and add `@Serializable` to the models. Translate `@SerializedName("x")` to `@SerialName("x")`. Configure one `Json` instance: `ignoreUnknownKeys`, `coerceInputValues`, `explicitNulls`, `encodeDefaults` chosen deliberately, not left at defaults by accident.
4. Port custom adapters to `KSerializer` implementations. Port polymorphism with sealed classes and a `classDiscriminator`, or a `polymorphic` module that registers a fixed list of subclasses.
5. Implement the seam on kotlinx.serialization and keep both implementations side by side behind a flag, with a debug comparison that parses the same body with both and logs differences (without values).
6. Do the per-unit cutover: move one endpoint or one model family at a time, then ramp.
7. With Ktor, install ContentNegotiation with `json(...)` using the same `Json` instance. With Retrofit, use the kotlinx.serialization converter from the Retrofit project.
8. Delete the old implementation: Gson dependency, adapters, annotations and the flag.

## Pitfalls

- Null and default handling: a missing non-null property without a default throws `MissingFieldException`; Gson left it null. A JSON null for a non-null property throws unless `coerceInputValues` is on, which silently replaces it with the default; choose per project and test.
- Defaults are not encoded unless `encodeDefaults = true`; a server that expects the field in requests then breaks.
- Unknown enum values throw unless `coerceInputValues` plus a default is set.
- Numbers: reading `Any` is not supported; use `JsonElement` for dynamic structures.
- Date handling: no built-in `Date` support; write a serializer or use a type with built-in support and test time zones.
- Generics and nested sealed hierarchies need the serializer resolved at compile time; avoid `Class`-based lookups.
- Every model class needs the annotation, including classes in other modules; a missing one fails at runtime with a serializer-not-found error, so cover it with tests.
- Snake case naming is not global in the default configuration; use `@SerialName` or a naming strategy where the library offers one, and test it.

## Tests

- JSON contract tests with recorded JSON: for each model, store real response bodies as test resources, parse with both implementations during the side-by-side phase and assert identical domain objects.
- Edge-case bodies: missing field, null for non-null, extra field, empty array, unknown enum, large number, empty string for a date.
- Round trip: encode then decode and compare with the recorded body for request models, checking default and null handling.
- Polymorphism tests: every subtype, a missing discriminator and an unknown discriminator.
- A test that loads every `@Serializable` model once so a missing serializer fails in CI, not in production.

## Security checklist

- Unsafe deserialization settings are not carried over: no payload-controlled class names; polymorphism uses a closed set of registered subclasses, and unknown discriminators fail closed.
- Reflection-based allow lists from the Gson setup are replaced by the compile-time serializers; there is nothing to allow-list by name, and any code that still resolves classes by name from a payload is removed.
- Untrusted JSON size limit: responses and request bodies get a size limit at the HTTP layer or through a bounded source before decoding, and deeply nested input is rejected.
- Lenient parsing (`isLenient`, `allowSpecialFloatingPointValues`) stays off unless a documented need exists.
- Decoding errors are logged without payload content.

## Rollback

While both implementations exist, flip the flag back per endpoint; no data on the device changes, so the move is reversible. After deleting Gson, restore it from version control and re-add the adapters.
