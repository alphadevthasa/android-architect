# Rubric: security

Android security areas to check during `audit` and when reviewing a migration. The profile (`profile.security.findings`, rendered in the stack profile and `architecture-current.md`) holds deterministic signals found by static text matching. A signal is a candidate, not a verdict: open the cited `file:line`, confirm it in context, and cite it. Areas without a signal need manual inspection.

Severity: High (exploitable by another app or a network attacker, or leaks credentials), Medium (weakens a protection or widens the attack surface), Low (hygiene, defence in depth). Raise or lower it by how sensitive the affected flow is (login, payments, personal data).

Never quote a secret value in a report. Cite `file:line` and the kind only.

## Migration warning

A migration can silently drop security. Before approving a migration plan or a pull request that swaps networking, storage or the build setup, check that each of these still exists afterwards, and name the file that carries it:
- certificate pinning (`CertificatePinner`, `network_security_config` pins, a custom `TrustManager`)
- OkHttp interceptors that add auth headers, sign requests or refresh tokens
- encryption of stored data (`EncryptedSharedPreferences`, SQLCipher, Keystore-backed keys)
- R8 and ProGuard keep rules and `minifyEnabled` for release
- `network_security_config` and manifest flags (`usesCleartextTraffic`, `allowBackup`, backup rules)

Moving from Retrofit and OkHttp to Ktor, or from SharedPreferences to DataStore, drops these unless they are rebuilt on purpose. A missing control is a finding even when no signal fires.

## 1. Hardcoded secrets

API keys, tokens, passwords, private keys and signing credentials in source, Gradle files, `buildConfigField` values, `.properties` files or string resources (`res/values*/*.xml`: known key shapes, and credential-like names such as `api_key` or `token` with a value that has a digit).

Signal: `hardcoded-secret` (high). Detail is the secret kind only.

Manual: values built by concatenation, resource values the signal misses (multi-line or without a digit), secrets in assets or in test fixtures that ship, keys committed in git history. A key in `BuildConfig` is still in the APK. Prefer server-side secrets, or short-lived tokens issued after login.

## 2. Cleartext traffic and network security config

Plain HTTP allowed app-wide or per domain.

Signal: `cleartext-traffic` (high) for `android:usesCleartextTraffic="true"` or `cleartextTrafficPermitted="true"` in a `res/xml` network security config.

Manual: `http://` URLs in code and Gradle `buildConfigField`s, a `network_security_config` that trusts user-installed CAs in release (`<certificates src="user"/>`), debug-only overrides leaking into release, and `targetSdk` below 28, where cleartext defaults to allowed.

## 3. Certificate pinning

Pins protect high-value API hosts against a rogue or compromised CA.

Signal: none.

Manual: look for `CertificatePinner`, `<pin-set>` in the network security config, or a custom `TrustManager` / `HostnameVerifier`. A `TrustManager` that accepts every certificate or a `HostnameVerifier` that returns `true` is High. Missing pinning on a banking, payments or identity app is Medium. Check pin expiry and a backup pin.

## 4. Exported components and intent handling

Activities, services, receivers and providers reachable by other apps.

Signal: `exported-component` (medium) for `android:exported="true"` on an activity, service, receiver or provider without `android:permission`. An activity with a LAUNCHER intent filter is exempt.

Manual: components exported implicitly through an `<intent-filter>` (required `exported` on Android 12+), providers with `grantUriPermissions` or broad `<path-permission>`, deep-link activities that trust their extras, `PendingIntent` created without `FLAG_IMMUTABLE`, implicit intents carrying sensitive data, and intent extras used as file paths or URLs without validation. Raise severity when the component performs a privileged action or returns data.

## 5. WebView

Signals:
- `webview-js-interface` (medium): `addJavascriptInterface(`.
- `webview-file-access` (medium): `setAllowFileAccess(true)`, `setAllowUniversalAccessFromFileURLs(true)`, `setAllowFileAccessFromFileURLs(true)`.

Manual: which URLs the WebView can load (an interface on a WebView that loads remote or user-controlled content is High), `setJavaScriptEnabled(true)` on untrusted content, `shouldOverrideUrlLoading` allowlists, `WebViewClient.onReceivedSslError` calling `proceed()` (High), mixed-content mode, and `WebView.setWebContentsDebuggingEnabled(true)` in release.

## 6. Unencrypted sensitive storage

Tokens, credentials or personal data stored in plain `SharedPreferences`, plain files, external storage or an unencrypted Room or SQLite database.

Signal: none.

Manual: search for `getSharedPreferences`, `MODE_WORLD_READABLE`, `openFileOutput`, `getExternalFilesDir` and `Environment.getExternalStorage*`, then read what is stored. Prefer `EncryptedSharedPreferences` or DataStore with Keystore-backed keys, and no sensitive data on external storage. Plain storage of an access or refresh token is Medium to High.

## 7. PII and secrets in logs

Logging tokens, passwords, OTPs, PINs or personal data.

Signal: `sensitive-log` (low): a `Log.v/d/i/w/e` or `Timber.v/d/i/w/e` call on a line that mentions `password`, `token`, `secret`, `pin` or `otp`.

Manual: values logged through a variable name that is not in that word list, request and response bodies logged by `HttpLoggingInterceptor` at `BODY` level in release, crash reporters and analytics receiving personal data, and `Timber` trees planted in release builds. Raise to Medium or High when the value is a live credential and logs are shipped off device.

## 8. R8 and code shrinking

Signal: `minify-disabled-release` (low) for `minifyEnabled false` / `isMinifyEnabled = false` in the release build type.

Manual: shrinking is not a security boundary, but it removes dead code and obscures logic. Check `proguard-rules.pro` for over-broad `-keep class **` rules and `-dontobfuscate`. After a migration, check that keep rules for reflection and serialization libraries still exist.

## 9. Debuggable, allowBackup and backup rules

Signals:
- `debuggable-release` (high): `android:debuggable="true"` in a manifest, or `debuggable true` / `isDebuggable = true` inside a release build type. The same setting in `debug` is not a finding.
- `allow-backup` (medium): `android:allowBackup="true"` on `<application>` without `android:dataExtractionRules` or `android:fullBackupContent`.

Manual: read the backup rules to confirm they exclude tokens, databases and keys, check `android:debuggable` set by a build variant or manifest placeholder, and check `testOnly`.

## 10. Integrity checks

Detecting a tampered, rooted or emulated environment and verifying the caller.

Signal: none.

Manual: look for Play Integrity (`IntegrityManager`) or an equivalent attestation, signature verification, root or debugger detection, and server-side verification of the integrity verdict. A check that only runs on the client can be patched out. For a high-value app, absence is Medium. Remember that a migration can drop these checks.
