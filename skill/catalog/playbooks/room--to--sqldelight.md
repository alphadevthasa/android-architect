---
id: room--to--sqldelight
dimension: persistence
from: room
to: sqldelight
title: Room to SQLDelight
irreversible: true
kmpOnly: true
worthIf:
  - present:kmp
asOf: 2026-11-20
verified: false
---

Moves a Room database to SQLDelight so persistence can be shared across Kotlin Multiplatform targets. Written from memory of https://developer.android.com/training/data-storage/room and https://kotlinlang.org; the SQLDelight documentation is the authority for its Gradle setup, check it before relying on a detail.

## When it is worth it

Only with Kotlin Multiplatform where the database should be shared with iOS or desktop. Room's KMP support exists, so compare it first; SQLDelight is worth the move when its SQL-first model or its multiplatform drivers fit the project better.

## When not to

The app is Android-only, or Room already runs in the shared module. Room is current, so a swap alone has no user-visible benefit and carries migration risk for on-device data.

## Preconditions

- The project has a KMP shared module, or one is planned in the same change.
- Data access is reachable through a Repository interface (the seam), or can be put behind one first.
- The exported Room schema JSON for every released version and real old-version database files are available.
- The encryption setup of the current database is known.

## Steps

One safe ordering applies: (1) a verified backup exists before any release that opens the file with SQLDelight, and again before the release that makes SQLDelight the schema owner; (2) exactly one connection writes to the file; (3) Room's bookkeeping (`room_master_table`, `user_version`) is left alone until the Room code is deleted; (4) the old code is deleted only after verification and a full release cycle.

1. Export and commit the Room schema JSON per version (`exportSchema = true`) if not done, and collect real old-version database files.
2. Define the seam: a Repository interface in domain types, with no Room types in its signatures.
3. Write the SQLDelight `.sq` files so that table names, columns, types, nullability, defaults, indices and foreign keys match the Room schema exactly. Write the identical queries as named SQL statements.
4. Backup before the first release that opens the file with SQLDelight: checkpoint the write-ahead log (`PRAGMA wal_checkpoint(TRUNCATE)`), close the database, copy the main file and any `-wal`, `-shm` and `-journal` files to app-private storage, and open the copy to check it. Copying only the main file loses committed data still in the log.
5. Keep a single writer and leave Room as the schema owner for now: create the SQLDelight Android driver on Room's `SupportSQLiteOpenHelper` (`roomDb.openHelper`) instead of opening the file by name, so both libraries share one connection, and Room keeps its `room_master_table` and `user_version`. Check the SQLDelight documentation for the exact driver constructor. Two separate drivers or helpers on the production file are not allowed.
6. Implement the seam on SQLDelight and keep the Room implementation side by side behind a flag, both on that shared connection. Writes made through SQLDelight do not trigger Room's InvalidationTracker, so keep Room `Flow` readers on their own flag-controlled path or call `invalidationTracker.refreshVersionsAsync()` after SQLDelight writes.
7. Do the per-unit cutover: move one table or feature at a time, reads first, then writes. Ship each step.
8. When every unit runs on SQLDelight and the flag has been at 100 percent for a full release, delete only what is no longer used: the Room entities and DAOs. Keep the Room database class (or replace it with a plain `SupportSQLiteOpenHelper` with the same version and a no-op callback) as the owner of the shared connection, keep the rollback flag, and keep the Room `version` and `room_master_table` untouched. Nothing that the connection owner or the rollback path needs is removed yet.
9. Only after Step 8 has soaked for a full release, make SQLDelight the schema owner in a later release, after a fresh backup: let the SQLDelight driver open the file by name, align its schema version with the file's `user_version` (add a `.sqm` migration for any version gap) and drop `room_master_table` in that migration. From this point Room cannot open the file again, so rollback is by restoring the backup.
10. In the last step, after Step 9 has soaked for a full release, delete the remaining Room code: the database class or placeholder open helper, the KSP processor, the schema export setup and the flag.

## Pitfalls

- Version arithmetic: Room's `version` and SQLDelight's schema version must line up before SQLDelight becomes the owner, or the driver runs migrations twice or not at all. Do not change `user_version` while Room code can still ship.
- Dropping `room_master_table` or changing `user_version` early makes a Room rollback fail its identity check, and with a destructive fallback it would wipe the data. Never enable `fallbackToDestructiveMigration` variants during this move.
- Type mapping: Room `TypeConverter`s become SQLDelight column adapters; mismatched encodings corrupt reads.
- Flow: Room DAOs returning Flow invalidate on table changes; SQLDelight uses `asFlow()` with the coroutines extension, and the dispatcher must be passed explicitly. Cross-library writes do not notify each other.
- Transactions and threading differ; check places that relied on Room's `@Transaction`.
- Room generates SQL checks at compile time from annotations; SQLDelight verifies against the `.sq` schema, so a query that compiled under Room may need adjustment.
- Views, triggers and `FTS` tables need explicit statements in the `.sq` files.
- Multiple processes need care with the driver's connection handling.

## Tests

- Open real old-version Room database files with the SQLDelight driver and assert row counts and spot values per table.
- Migration tests for each `.sqm` file using the SQLDelight migration verification task, plus a test that opens each released `user_version` through the upgrade path.
- Contract tests on the seam against both implementations during the side-by-side phase.
- Query tests per named statement against an in-memory driver.
- Flow tests that assert re-emission after writes.

## Security checklist

- Encryption driver parity: a SQLCipher-encrypted Room database stays encrypted, so the shared connection (or, after the ownership switch, the SQLDelight Android driver) is created with the SQLCipher open helper factory (`SupportOpenHelperFactory` for `sqlcipher-android`, `SupportFactory` for the older library) with the same key, page size and KDF settings, and a test fails to open the file without the key. A SQLCipher 3 file opened by SQLCipher 4 needs the compatibility settings or `cipher_migrate` from the SQLCipher upgrade notes. On iOS use a driver with equivalent encryption, or document that the target is not encrypted and why.
- Key handling: the key stays in the Android Keystore or in a Keystore-wrapped form, is not logged and does not move to preferences or shared code constants.
- The backups from Steps 4 and 9 are the encrypted files themselves, kept in app-private storage excluded from cloud backup, and removed with `Context.deleteDatabase()` or file deletion when the rollback window ends; never keep a decrypted copy.
- Backup and extraction rules are unchanged: the database stays excluded from backup if it was before.
- Exported schema files, `.sq` fixtures and logs contain no real row data.

## Rollback

Until Step 9, rollback is flipping the flag back to Room: the Room database class, the Room `version` and `room_master_table` are all still in place, and the file was never opened by two writers, so no data is lost. Never use `fallbackToDestructiveMigration` or its variants as a rollback or recovery path. The flag and the connection owner are removed only in Step 10, the very last step, so this window lasts through Step 9's release. After Step 9 (SQLDelight owns the schema, `room_master_table` dropped), Room cannot open the file, and rollback means restoring the backup taken before that release (main file plus `-wal`, `-shm`, `-journal`), which loses newer writes. Treat Step 9 as one-way and Step 10 as cleanup only.
