---
id: gson--to--moshi
dimension: serialization
from: gson
to: moshi
title: Gson to Moshi
irreversible: false
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves JSON parsing from Gson to Moshi. Written from memory of https://square.github.io/moshi/ and https://kotlinlang.org; check the current docs before relying on a detail.

## When it is worth it

Gson is in maintenance mode, uses reflection that ignores Kotlin nullability and defaults, and has had deserialization advisories. Moshi understands Kotlin (with the codegen or the reflective Kotlin adapter), fails loudly on null for non-null fields and works well with Retrofit and OkHttp.

## When not to

The project is moving to Kotlin Multiplatform: Moshi is JVM-only, so go to kotlinx.serialization directly (see the Gson to kotlinx.serialization playbook). Also not when the models are Java classes with heavy custom `TypeAdapter` logic and no test coverage.

## Preconditions

- Parsing happens behind a seam (a mapper, a Retrofit converter factory, or a Repository), or can be put behind one first.
- Every `@SerializedName`, `@Expose`, `TypeAdapter`, `JsonDeserializer`, `JsonSerializer` and `GsonBuilder` setting in use is listed.
- Recorded JSON for each model exists, covering null, missing, extra and unusual fields.

## Steps

1. Inventory the Gson usage: models, annotations, custom adapters, date formats, `serializeNulls`, field naming policy, lenient mode, and where `Gson` instances are shared.
2. Define the seam: an interface for encode and decode (or a converter factory) that features use instead of `Gson` types.
3. Add Moshi with Kotlin codegen (`@JsonClass(generateAdapter = true)`) for Kotlin models, which avoids reflection; use `KotlinJsonAdapterFactory` only where codegen is not possible. Translate `@SerializedName("x")` to `@Json(name = "x")`.
4. Port each custom `TypeAdapter` to a Moshi `JsonAdapter` or an `@ToJson` and `@FromJson` pair. Port polymorphism with `PolymorphicJsonAdapterFactory` and an explicit label key and a fixed list of subtypes.
5. Implement the seam on Moshi and keep both implementations side by side behind a flag, with a comparison mode in debug builds that parses the same body with both and logs differences (without logging values).
6. Do the per-unit cutover: move one endpoint or one model family at a time, then ramp.
7. Delete the old implementation: Gson dependency, adapters, `@SerializedName` annotations, and the flag.

## Pitfalls

- Null and default handling: Gson builds objects through a no-arg constructor when one exists (Kotlin classes whose parameters all have defaults get one), which keeps the Kotlin defaults; otherwise it uses `Unsafe` allocation, skips the constructor and can leave a non-null Kotlin field null. Moshi uses the constructor default when the property has one and throws `JsonDataException` when a required field is missing or null. Expect new exceptions where Gson tolerated bad data, and decide per field: add a default, make it nullable, or keep the failure.
- Unknown keys are ignored by Moshi by default, as with Gson; but `failOnUnknown()` changes that.
- Numbers: Gson reads numbers into `Double` for `Any` or `Object` typed fields, Moshi does the same, but integers beyond double precision lose digits; use `Long` fields.
- Date formats: Gson `setDateFormat` has no Moshi counterpart; write an adapter and test the time zone.
- Enums: an unknown enum value throws in Moshi; use a fallback adapter with `.withUnknownFallback` or a nullable field.
- Field naming policy (snake case) applies globally in Gson; Moshi needs explicit `@Json(name)` on each property.
- `transient` and `@Expose` semantics differ; Moshi skips `transient` fields and ignores `@Expose`.
- R8: Moshi codegen needs no extra rules, the reflective Kotlin adapter does.

## Tests

- JSON contract tests with recorded JSON: for each model, store real response bodies as test resources, parse with both implementations during the side-by-side phase and assert identical domain objects.
- Edge-case bodies: missing field, null for non-null, extra field, empty array, unknown enum, large number, empty string for a date.
- Round trip: encode then decode and compare with the recorded body for request models.
- Polymorphism tests: every subtype plus an unknown label.
- A serialization test that asserts the exact JSON sent in requests, including null handling.

## Security checklist

- Unsafe deserialization settings are not carried over: a custom `JsonDeserializer` that calls `Class.forName`, or type-info fields in the payload that name the class to instantiate, must not be ported. Gson's `RuntimeTypeAdapterFactory` is a registered allow list like Moshi's `PolymorphicJsonAdapterFactory`, so port it as one: a fixed list of subtypes with an explicit label key, where unknown labels fail closed.
- Reflection-based allow lists: any Gson setup that resolves a class by name from the payload is replaced by an explicit allow list of known subtypes, and unknown labels fail closed.
- Untrusted JSON size limit: responses and request bodies get a size limit at the HTTP layer or by reading through a bounded source before parsing, and deeply nested input is rejected.
- Parsing errors are logged without payload content, and error responses are not echoed to users.
- Adapters that use `Any` or `Object` typed fields are replaced by explicit models or a constrained sealed type, so untrusted JSON cannot choose arbitrary shapes, and `failOnUnknown()` is considered for security-sensitive request or config models.

## Rollback

While both implementations exist, flip the flag back per endpoint; no data on the device changes, so the move is reversible. After deleting Gson, restore it from version control and re-add the adapters.
