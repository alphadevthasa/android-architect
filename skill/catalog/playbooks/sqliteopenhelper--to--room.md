---
id: sqliteopenhelper--to--room
dimension: persistence
from: sqliteopenhelper
to: room
title: SQLiteOpenHelper or ContentProvider to Room
irreversible: true
kmpOnly: false
asOf: 2026-11-20
verified: false
---

Moves a hand-written SQLiteOpenHelper database (and the ContentProvider that exposes it, if any) to Room on the same database file. Written from memory of https://developer.android.com/training/data-storage/room and https://developer.android.com/training/data-storage/room/migrating-db-versions; check the current docs before relying on a detail. A standalone ContentProvider to Room playbook is deferred: the provider handling is in Steps 9 and 10 here.

## When it is worth it

The app owns a SQLite database through `SQLiteOpenHelper`, raw cursors and string SQL. Room adds compile-time query checks, typed DAOs, Flow and coroutine support and a tested migration path. It pays off when the schema keeps changing, when queries are error-prone, or before adding features that need reactive queries.

## When not to

The database is tiny, stable and rarely touched, and no feature work is planned around it. Also not while the schema has unknown history: if some installed versions have schema states you cannot reproduce, stabilize that first. A database that other apps read through an exported ContentProvider needs the provider contract kept, so plan for it (see Steps).

## Preconditions

- Data access is reachable through a Repository or DataSource interface (the seam), or can be put behind one first as its own change.
- The current schema is written down: `CREATE TABLE` statements for every released database version, indexes, triggers, views and the `PRAGMA user_version` history.
- Real database files from old released versions are collected (from test devices or a debug backup), with no personal data.
- A decision is made on encryption: if the database uses SQLCipher today, the Room setup must use the SQLCipher open helper factory from the start.
- The release plan has two releases: a preparation release (legacy code only) and the first Room release. See Steps 1 and 7.

## Steps

One safe ordering applies to the whole move: (1) a verified backup exists before any release that opens the file with Room; (2) exactly one connection writes to the file at any time; (3) the old code is deleted only after verification and a full release cycle; (4) rollback is possible without data loss until then.

1. Preparation release (legacy code only): override `onDowngrade` in the legacy helper so an older build tolerates a database whose `user_version` is higher (accept it as a no-op instead of throwing or dropping tables). This must ship before the first Room release, because rollback means reinstalling an older build, and that build must already contain the override.
2. Freeze the legacy schema: dump the `CREATE` statements for each released version and note `user_version`. Treat this as the source of truth.
3. Define the seam: a Repository interface in domain types. All callers of the helper, cursors and the ContentProvider internals go through it.
4. Map the schema 1:1 first. Write Room `@Entity` classes whose table names, column names, types, primary keys, foreign keys and indices match the legacy tables exactly, using `@ColumnInfo(name = ...)`, `@PrimaryKey` and `@Index`. Do not rename or normalize in this step.
5. Match nullability and defaults exactly. Room validates the schema against its own expectation: a column that is nullable in the legacy table but a non-null Kotlin property, or a legacy default that Room does not declare with `defaultValue`, makes the open fail with a schema validation error.
6. Open the existing file. Build the Room database with the same file name as the helper (`Room.databaseBuilder(context, Db::class.java, "<existing name>")`). Set `version` to the legacy `user_version` plus one, and write a Migration from the last legacy version that only brings the schema into the shape Room expects (for example, creating missing indices). Set `exportSchema = true` with a schema directory and commit the exported JSON, because the identity hash in it is what migration tests compare. Do not call any `fallbackToDestructiveMigration` variant.
7. Backup before the first Room release opens the file: on first launch of that release, before Room is built, checkpoint and close the legacy database (`PRAGMA wal_checkpoint(TRUNCATE)`, then close the helper), then copy the main file and any `-wal`, `-shm` and `-journal` files to a private folder, open the copy to check it, and only then let Room open the original. Without the checkpoint, a copy of the main file alone loses the committed data that still sits in the write-ahead log. Keep the backup for the whole rollback window.
8. Keep a single writer. Either route all legacy data-access code through Room's connection (the legacy class takes `roomDb.openHelper.writableDatabase`, a `SupportSQLiteDatabase`, instead of creating its own `SQLiteOpenHelper`), or cut the whole file over at once. Two helpers open on one production file is not allowed. Run the legacy and the Room implementations of the seam side by side behind a flag, both on that one Room connection.
9. Do the per-unit cutover: move one table or one feature at a time from the legacy class to the DAOs behind the flag, reads first, then writes. Ship each step and watch crash and error rates.
10. ContentProvider: keep the provider class, its authority, URIs and permissions, and re-implement `query`, `insert`, `update` and `delete` on the Room connection so external callers see the same contract. Room does not call `ContentResolver.notifyChange`: call it in the provider after every write, or ContentObserver clients stop seeing updates.
11. When every unit and the provider run on Room and the flag has been at 100 percent for a full release after verification, delete the old implementation: the helper class, cursor mappers, string SQL constants and the flag. Keep the backup until the rollback window ends.

## Pitfalls

- Room checks the identity hash and the table shape on open. A mismatch in column type affinity, a missing index, a missing `NOT NULL`, or an extra column throws `IllegalStateException: Migration didn't properly handle` or an identity hash mismatch.
- `fallbackToDestructiveMigration` and its variants silently delete user data on a version gap. Do not enable any of them for a database that holds user data.
- Writes that go through `openHelper.writableDatabase` bypass Room's InvalidationTracker, so Room `Flow` and `LiveData` queries do not re-emit after legacy writes. Move those writes to DAOs first, or call `invalidationTracker.refreshVersionsAsync()` after them.
- Views, triggers and `WITHOUT ROWID` tables need `@DatabaseView` or a migration with raw SQL, and are easy to lose.
- Run Room queries off the main thread. Legacy code that ran on the main thread will now fail the main-thread check; fix the callers, do not call `allowMainThreadQueries`.
- Date, boolean and enum columns need explicit `TypeConverter`s that read the legacy encoding (epoch millis versus text, 0 and 1).
- `PRAGMA foreign_keys` is off in the legacy helper by default but Room enforces declared foreign keys; legacy data with dangling references can start failing.
- Two processes (a provider process, a service in another process) opening the same file need `enableMultiInstanceInvalidation`.
- Copying only the main database file as a backup is unsafe in write-ahead logging mode: include `-wal` and `-shm`, after a checkpoint.

## Tests

- `MigrationTestHelper` tests: create each real old-version database file in a test (from the committed schema JSON for known versions and from the collected real files), run the migration to the current version and call `runMigrationsAndValidate`.
- Open a real old-version database file copied from the collected set with the Room builder, then assert row counts and spot values for every table before and after.
- DAO tests with an in-memory Room database for each query.
- Contract tests on the seam: run the same test body against the legacy and the Room implementation during the side-by-side phase.
- ContentProvider tests that call the provider through `ContentResolver` and compare results with the recorded results of the old provider for each URI.
- A test that opens the database under every previously released `user_version` through the upgrade path, one by one.

## Security checklist

- Encryption is carried over: a SQLCipher database stays encrypted after the move by passing the SQLCipher open helper factory to the Room builder (`SupportOpenHelperFactory` with the `sqlcipher-android` library, `SupportFactory` with the older `android-database-sqlcipher` library) with the same key. If the file was created by SQLCipher 3 and the new library is SQLCipher 4, the compatibility settings or `cipher_migrate` from the SQLCipher upgrade notes must be applied once, or the open fails. A test opens the file with a wrong key and expects failure.
- The database key stays in the same protected place (Android Keystore wrapped key or equivalent) and is not moved into a plain preference, a constant or a log line while migrating.
- ContentProvider permissions are preserved: `android:exported`, read and write permissions, `grantUriPermissions` and path permissions in the manifest are identical after the move, and a test calls the provider without the permission and expects a security exception.
- Query parameters in the provider stay bound arguments, never concatenated into SQL, so the move does not add an injection path.
- No plaintext export: the backup of an encrypted database is the encrypted file itself (never a decrypted copy), it lives in app-private storage excluded from cloud backup, and it is removed with `Context.deleteDatabase()` or file deletion when the rollback window ends; flash storage cannot be reliably overwritten, so encryption at rest is the protection, not overwriting. `android:allowBackup` and backup rules do not include the database unless that was already intended.
- Exported schema JSON, logs and crash reports contain no row data.

## Rollback

Rollback is possible without data loss while three things hold: the preparation release with the `onDowngrade` override (Step 1) shipped before the first Room release, the flag and the legacy code still exist, and the file was never opened by two writers. Room only adds `room_master_table` and a bumped `user_version`, which the legacy helper ignores once it accepts the higher version. Flip the flag back to the legacy implementation (which now runs on the same connection) or ship the older build. Never use `fallbackToDestructiveMigration` or `fallbackToDestructiveMigrationOnDowngrade` as a rollback or recovery mechanism. If the file is damaged, restore the backup from Step 7 (main file plus `-wal`, `-shm`, `-journal`), which loses writes made since. After the old code is deleted, rollback means restoring the backup, so keep the legacy implementation for a full release and treat the move as one-way after that.
