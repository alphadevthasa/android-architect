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

1. Export and commit the Room schema JSON per version (`exportSchema = true`) if not done, and collect real old-version database files.
2. Define the seam: a Repository interface in domain types, with no Room types in its signatures.
3. Write the SQLDelight `.sq` files so that table names, columns, types, nullability, defaults, indices and foreign keys match the Room schema exactly, since SQLDelight will open the same file. Write the identical queries as named SQL statements.
4. Set up the platform drivers: the Android driver on Android and the native driver on iOS. Open the existing database file name with the Android driver.
5. Handle the schema bookkeeping: Room stores its identity hash in `room_master_table` and uses `PRAGMA user_version`. SQLDelight uses `user_version` for its migrations. Align the version number and write the first `.sqm` migration file from the current Room version; the Room master table can be dropped in that migration.
6. Implement the seam on SQLDelight and keep the Room implementation side by side behind a flag. Never have two writers on the production file at once; use separate files in tests, and a switch in production.
7. Do the per-unit cutover: move one table or feature at a time, reads first, then writes. Ship each step.
8. Take a backup before the first release that opens the file with SQLDelight, and keep it for the rollback window.
9. After a full release at 100 percent, delete the old implementation: the Room entities, DAOs, database class, KSP processor and dependencies, the schema export setup, and the flag.

## Pitfalls

- Version arithmetic: Room's `version` and SQLDelight's schema version must line up, or the driver runs migrations twice or not at all.
- Type mapping: Room `TypeConverter`s become SQLDelight column adapters; mismatched encodings corrupt reads.
- Flow: Room DAOs returning Flow invalidate on table changes; SQLDelight uses `asFlow()` with the coroutines extension, and the dispatcher must be passed explicitly.
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

- Encryption driver parity: a SQLCipher-encrypted Room database stays encrypted, so the SQLDelight Android driver is created with the SQLCipher support factory and the same key, page size and KDF settings, and a test fails to open the file without the key; on iOS use a driver with equivalent encryption, or document that the target is not encrypted and why.
- Key handling: the key stays in the Android Keystore or in a Keystore-wrapped form, is not logged and does not move to preferences or shared code constants.
- The backup taken in step 8 is encrypted or deleted after the rollback window, and no plaintext export of the database is created.
- Backup and extraction rules are unchanged: the database stays excluded from backup if it was before.
- Exported schema files, `.sq` fixtures and logs contain no real row data.

## Rollback

While the flag exists and the Room code remains, flip back per unit; the migration only changes version bookkeeping, and the Room implementation must accept the changed version. After deletion, rollback means restoring the backup from step 8, which loses newer writes, so keep the Room implementation for a full release and treat the move as one-way afterwards.
