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

One safe ordering applies: (1) the migration is one-way per file, with a single writer, so there is no dual-write while a migration is active; (2) the old file is deleted only after verification and a full release cycle; (3) rollback is decided before the first release (see Rollback).

1. Inventory the preferences files and keys, with types and defaults.
2. Define the seam: a settings interface per area, exposing Flows or suspend functions, with no SharedPreferences or DataStore types in signatures.
3. Choose the migration mode per file before writing code. Mode A (default): the built-in `SharedPreferencesMigration` copies the keys on the first DataStore read and then cleans up by removing the migrated keys from the old file, so the old file is empty afterwards. Mode B (when a rollback window is required): a custom `DataMigration` that copies the keys, records a "migrated" marker key inside DataStore, returns `false` from `shouldMigrate` once the marker exists (so it never overwrites newer values), and leaves the old file untouched in `cleanUp`; the old file is removed in the deletion release.
4. Create one DataStore per preferences file, with `preferencesDataStore(name = ..., produceMigrations = { ... })` using the chosen mode. Migrate one preferences file per step, not all at once.
5. Implement the seam on DataStore and keep the SharedPreferences implementation side by side in the code, behind a flag that selects the one store for each file. Never write the same value to both stores while a migration is active: the built-in migration re-checks the old file on initialization and cleans it up, so a dual-written value is overwritten or removed. The flag picks one reader and writer per file.
6. Do the per-unit cutover: switch one preferences file (one settings area) at a time, with every reader and writer of that file moving in the same release. Verify on real upgrade installs that the values survived, then ramp the flag.
7. Delete the old implementation after verification and a full release cycle: the SharedPreferences accessors, the flag, and the old XML file for migrated users (see Security checklist). In Mode B, delete the old file only now.

## Pitfalls

- Single-writer rule: there must be exactly one DataStore instance per file in a process. Creating a second one for the same file throws an `IllegalStateException`; declare it with the property delegate at top level, not inside a class that is constructed repeatedly.
- Dual-write does not work with the built-in migration: it clears migrated keys from the old file, so the old file can no longer serve as a fallback. Choose Mode B if a rollback window is needed.
- Reading the old file directly after a Mode A migration returns nothing, because the migration clears migrated keys (and `SharedPreferencesMigration.cleanUp` deletes the file once it is empty); remove all direct readers first.
- A custom migration without a marker re-runs and overwrites newer DataStore values on every start. With the marker (Mode B), values written to the old file during a rollback are lost when rolling forward again, because the marker already exists and the migration does not run again.
- `SharedPreferencesMigration` migrates types it knows; `Set<String>` and `Float` map to `stringSetPreferencesKey` and `floatPreferencesKey`, and keys must be declared with the matching type or the value is not found.
- Blocking reads with `runBlocking` on the main thread negate the benefit and can cause ANRs; load startup values once, asynchronously, and cache.
- Backup and restore: restoring an old `shared_prefs` file after migration can bring back stale values; check backup rules.
- A corrupted file throws `CorruptionException`; set a `corruptionHandler` with sane defaults.
- Multi-process access needs `MultiProcessDataStoreFactory`, not the default.

## Tests

- Migration test: create a SharedPreferences file with legacy values of every type, build the DataStore with the migration, read each key, and assert the values and that the old file is deleted (the built-in cleanup removes the migrated keys and deletes the file once it is empty).
- Upgrade test on a device or emulator image: install the old build, set values, update to the new build, assert the values.
- Contract tests on the seam against both implementations during the side-by-side phase.
- A test that two instances for the same file are not created (DI graph test).
- Corruption test: write an invalid file and assert the handler returns defaults.

## Security checklist

- The old SharedPreferences XML file is deleted after migration: the built-in migration only empties it, so call `Context.deleteSharedPreferences(name)` once the migration is verified (in Mode B, in the deletion release), and check the file under the app's `shared_prefs` folder is gone.
- Sensitive values (tokens, identifiers, flags that gate security) are not placed in DataStore as plain text: Preferences DataStore stores plaintext on disk, so such values stay in an encrypted store or are encrypted before writing (see the EncryptedSharedPreferences playbook).
- Backup rules: `android:allowBackup`, `dataExtractionRules` and `fullBackupContent` are reviewed so the new `datastore` folder is excluded if the old file was excluded, and so a restored old file cannot re-trigger a Mode B migration with stale values.
- Values are not logged by migration or debug code.

## Rollback

Decide before the first release. In Mode A the migration moves values out of the old file, so a rollback release (a new release that contains the old code) that reads SharedPreferences sees only defaults: rollback is then not possible without losing the settings, and the file should be treated as one-way once shipped. In Mode B the old file keeps the values as of the migration, so the flag or a rollback release can read them (changes made since the migration are lost); keep the old file and the legacy code until the deletion release. Never make the rolled-back code read defaults silently: if a rollback is possible, ship the reader that checks the old file first. After deletion of the old implementation and file there is no reverse migration, so treat the move as one-way.
