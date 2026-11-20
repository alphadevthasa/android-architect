---
id: sharedpreferences--to--datastore
dimension: keyvalue
from: sharedpreferences
to: datastore
title: SharedPreferences to DataStore
irreversible: true
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves key-value settings from SharedPreferences to Jetpack DataStore (Preferences DataStore, or Proto DataStore for typed data). Written from memory of https://developer.android.com/topic/libraries/architecture/datastore; check the current docs before relying on a detail. If the file is EncryptedSharedPreferences, use the separate playbook for it.

## When it is worth it

The code reads preferences on the main thread, wants a Flow of changes, needs transactional updates, or hits `apply()` and `commit()` ordering problems. DataStore is asynchronous, uses coroutines and reports errors instead of silently failing.

## When not to

The preferences are read synchronously during startup in many places and there is no time to make them asynchronous; or the data is large or relational (use a database). Also not when only a handful of rarely changed flags exist and nothing is wrong with them.

## Preconditions

- Every SharedPreferences file name and its readers and writers are listed.
- Reads go through a small settings interface (the seam) or can be put behind one first.
- The code base uses coroutines, or the team accepts adding them at this boundary.
- Multi-process access to a preferences file is known (DataStore does not support multi-process by default).

## Steps

1. Inventory the preferences files and keys, with types and defaults.
2. Define the seam: a settings interface per area, exposing Flows or suspend functions, with no SharedPreferences or DataStore types in signatures.
3. Create one DataStore per preferences file, with `preferencesDataStore(name = ..., produceMigrations = { listOf(SharedPreferencesMigration(context, "<old file name>")) })`. Migrate one preferences file per step, not all at once.
4. Implement the seam on DataStore and keep the SharedPreferences implementation side by side behind a flag. During the side-by-side phase writes go to the old store only, or to both, and reads come from one; decide per unit and keep it consistent.
5. Do the per-unit cutover: switch one preferences file (one settings area) at a time. The first read from DataStore runs the `SharedPreferencesMigration`, which copies the keys and then removes them from the old file.
6. Verify on real upgrade installs that the values survived, then ramp the flag.
7. Delete the old implementation: the SharedPreferences accessors, the flag, and confirm the old XML file under `shared_prefs` is gone for migrated users (see Security checklist).

## Pitfalls

- Single-writer rule: there must be exactly one DataStore instance per file in a process. Creating a second one for the same file throws an `IllegalStateException`; declare it with the property delegate at top level, not inside a class that is constructed repeatedly.
- Mixing: reading the old file directly after the migration returns nothing, because the migration clears migrated keys; remove all direct readers first.
- `SharedPreferencesMigration` migrates types it knows; `Set<String>` and `Float` map to `stringSetPreferencesKey` and `floatPreferencesKey`, and keys must be declared with the matching type or the value is not found.
- Blocking reads with `runBlocking` on the main thread negate the benefit and can cause ANRs; load startup values once, asynchronously, and cache.
- Backup and restore: restoring an old `shared_prefs` file after migration can bring back stale values; check backup rules.
- A corrupted file throws `CorruptionException`; set a `corruptionHandler` with sane defaults.
- Multi-process access needs `MultiProcessDataStoreFactory`, not the default.

## Tests

- Migration test: create a SharedPreferences file with legacy values of every type, build the DataStore with the migration, read each key, and assert the values and that the old file is emptied.
- Upgrade test on a device or emulator image: install the old build, set values, update to the new build, assert the values.
- Contract tests on the seam against both implementations during the side-by-side phase.
- A test that two instances for the same file are not created (DI graph test).
- Corruption test: write an invalid file and assert the handler returns defaults.

## Security checklist

- The old SharedPreferences XML file is deleted after migration: verify the file under the app's `shared_prefs` folder is gone (or empty and then deleted with `deleteSharedPreferences`), so migrated values do not linger there.
- Sensitive values (tokens, identifiers, flags that gate security) are not placed in DataStore as plain text: Preferences DataStore stores plaintext on disk, so such values stay in the encrypted store or are encrypted before writing.
- Backup rules: `android:allowBackup`, `dataExtractionRules` and `fullBackupContent` are reviewed so the new `datastore` folder is excluded if the old file was excluded.
- Values are not logged by migration or debug code.
- Exported or debuggable builds do not expose the DataStore file through `run-as` shortcuts that the old file did not have.

## Rollback

Before deletion of the old implementation, flip the flag back: the migration moves values out of the old file, so keep a one-release dual-write window, or rollback loses recent changes. After the old code is deleted and values were migrated, rollback means shipping a build that reads DataStore again; a reverse migration is not provided, so treat this as one-way.
