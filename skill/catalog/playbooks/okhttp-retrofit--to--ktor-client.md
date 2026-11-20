---
id: okhttp-retrofit--to--ktor-client
dimension: networking
from: okhttp-retrofit
to: ktor-client
title: Retrofit to Ktor client
irreversible: false
kmpOnly: false
worthIf:
  - present:kmp
asOf: 2026-11-20
verified: false
---

Moves the HTTP layer from Retrofit (on OkHttp) to the Ktor client. Written from memory of the public documentation (https://ktor.io, https://square.github.io); check the current docs before relying on a detail.

## When it is worth it

The project uses Kotlin Multiplatform, or is about to, and the networking code should be shared with iOS or desktop targets. Retrofit and OkHttp are JVM-only, so a shared module cannot use them. Ktor gives one client API on every target.

## When not to

The app is Android-only and has no plan to share code: Retrofit with OkHttp is current, stable and well supported, and a swap changes no user-visible behavior. Also hold off when the app relies heavily on OkHttp-specific features (custom `Authenticator` chains, `EventListener` metrics, Cronet or HTTP cache tuning) that need re-building and re-testing.

## Preconditions

- Network calls are reachable through a Repository or DataSource interface (the seam). If features call Retrofit service interfaces directly, introduce the seam first, as its own change.
- The JSON layer is chosen: the Ktor ContentNegotiation plugin pairs with kotlinx.serialization, Moshi is not a first-class Ktor option. If the project uses Gson or Moshi converters today, plan the serialization move too (see the Gson playbooks).
- A written list of every interceptor, authenticator, certificate pinner, timeout and base URL in use, taken from the current OkHttpClient setup.
- Contract tests or recorded responses exist for the main endpoints (see Tests).

## Steps

1. Inventory the endpoints and the OkHttp configuration: interceptors, authenticator, pinning, timeouts, cache, proxy, cookie handling, base URLs per environment. This is the checklist the new client must match.
2. Define the seam if absent: a Repository or RemoteDataSource interface per feature, expressed in domain types, with no Retrofit, OkHttp or Ktor types in its signatures. Map DTOs to domain models behind it.
3. Pick the Ktor engine for Android (OkHttp engine keeps the OkHttp connection stack and pinning; the CIO engine is pure Kotlin). Using the OkHttp engine first reduces behavior drift. Install the plugins you need: ContentNegotiation with the JSON serializer, HttpTimeout, Logging, DefaultRequest, and Auth if you use bearer refresh.
4. Implement the seam on Ktor in a new class next to the Retrofit one. Keep both implementations side by side, selected by a switch (remote config flag, build flag, or DI binding).
5. Do the per-endpoint cutover: move one endpoint or one feature at a time to the Ktor implementation, starting with a read-only, low-traffic endpoint. Compare responses against the Retrofit path in staging or with shadow calls behind the flag.
6. Re-create the cross-cutting behavior one item at a time: auth header and token refresh, request signing, user-agent and locale headers, retry policy, error mapping (HTTP status to domain errors, timeouts, no-connectivity), certificate pinning and logging redaction (see Security checklist).
7. Ramp the flag to 100 percent per endpoint group, then keep the Retrofit path for at least one release as the fallback.
8. When every unit has moved and soaked, delete the old implementation: Retrofit service interfaces, converter factories, OkHttp interceptors that are no longer used, the flag, and the dependencies. Run the dependency report to confirm nothing still pulls them in transitively.

## Pitfalls

- Defaults differ: timeouts, redirect following, retry on connection failure, and gzip handling are not the same. Set them explicitly and compare.
- Ktor throws on non-2xx only when `expectSuccess` is on; Retrofit returns a `Response`. Decide one error model and test 4xx and 5xx paths.
- ContentNegotiation is strict about the content type: a server that answers JSON with a wrong `Content-Type` works with some Retrofit converters and fails in Ktor.
- Retrofit `@Streaming`, multipart uploads and download progress need explicit Ktor equivalents (channel or `onDownload` listener); test them with large bodies.
- Kotlinx serialization needs `@Serializable` on every DTO and the compiler plugin; unknown JSON keys fail unless `ignoreUnknownKeys` is set, and missing keys need defaults.
- Cancellation: Ktor calls cancel with coroutine scopes. A client created per call, instead of one shared instance, leaks connections and loses pooling.
- Keep one `HttpClient` instance per base configuration and close it with the owning scope.

## Tests

- Contract tests with recorded JSON: store real responses (with personal data removed) per endpoint and run the same assertions against the Retrofit and the Ktor implementation of the seam during the side-by-side phase.
- Use Ktor `MockEngine` for unit tests of the new implementation and MockWebServer for the Retrofit side, feeding both the same recorded bodies.
- Error-path tests: 401 with token refresh, 429 with retry, 5xx, timeout, malformed JSON, empty body, and no connectivity.
- A header test that asserts the exact set of headers on the wire (auth, signature, user agent) for each endpoint group.
- A pinning test against a test server with a wrong certificate: the call must fail.

## Security checklist

- Certificate pinning is re-implemented on the new client (OkHttp engine `CertificatePinner` via the engine config, or the platform equivalent) with the same pins and backup pins, and a test proves a wrong certificate is refused.
- Authentication and signing interceptors are re-created in full: token attach, refresh with a single in-flight refresh, request signature or HMAC headers, and an equivalence test on the wire.
- Logging redaction: the Ktor Logging plugin sanitizes the Authorization header, cookies and any signature header, and body logging is off in release builds.
- Cleartext policy is unchanged: no cleartext traffic permitted beyond what the network security config allows, and no base URL with plain HTTP introduced during the move.
- Debug-only trust overrides (user CA trust, trust-all managers) stay out of release builds.

## Rollback

While the flag exists, set it back to the Retrofit implementation per endpoint group, no data migration is involved. Keep the Retrofit code and dependencies until the last unit has shipped and soaked for a full release; after step 8, rollback means restoring the old classes from version control.
