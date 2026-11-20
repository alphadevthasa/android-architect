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

Moves a hand-written SQLiteOpenHelper database (and the ContentProvider that exposes it, if any) to Room on the same database file. Written from memory of https://developer.android.com/training/data-storage/room and https://developer.android.com/training/data-storage/room/migrating-db-versions; check the current docs before relying on a detail.

## When it is worth it

The app owns a SQLite database through `SQLiteOpenHelper`, raw cursors and string SQL. Room adds compile-time query checks, typed DAOs, Flow and coroutine support and a tested migration path. It pays off when the schema keeps changing, when queries are error-prone, or before adding features that need reactive queries.

## When not to

The database is tiny, stable and rarely touched, and no feature work is planned around it. Also not while the schema has unknown history: if some installed versions have schema states you cannot reproduce, stabilize that first. A database that other apps read through an exported ContentProvider needs the provider contract kept, so plan for it (see Steps).

## Preconditions

- Data access is reachable through a Repository or DataSource interface (the seam), or can be put behind one first as its own change.
- The current schema is written down: `CREATE TABLE` statements for every released database version, indexes, triggers, views and the `PRAGMA user_version` history.
- Real database files from old released versions are collected (from test devices or a debug backup), with no personal data.
- A decision is made on encryption: if the database uses SQLCipher today, the Room setup must use the SQLCipher open helper factory from the start.

## Steps

1. Freeze the legacy schema: dump the `CREATE` statements for each released version and note `user_version`. Treat this as the source of truth.
2. Define the seam if absent: a Repository interface in domain types. All callers of the helper, cursors and the ContentProvider internals go through it.
3. Map the schema 1:1 first. Write Room `@Entity` classes whose table names, column names, types, primary keys, foreign keys and indices match the legacy tables exactly, using `@ColumnInfo(name = ...)`, `@PrimaryKey` and `@Index`. Do not rename or normalize in this step.
4. Match nullability and defaults exactly. Room validates the schema against its own expectation: a column that is nullable in the legacy table but a non-null Kotlin property, or a legacy default that Room does not declare with `defaultValue`, makes the open fail with a schema validation error.
5. Open the existing file. Build the Room database with the same file name as the helper (`Room.databaseBuilder(context, Db::class.java, "<existing name>")`). Set `version` to the legacy `user_version` plus one, and write a Migration from the last legacy version that only brings the schema into the shape Room expects (for example, creating missing indices). Set `exportSchema = true` with a schema directory and commit the exported JSON, because the identity hash in it is what migration tests compare.
6. Implement the DAO and a Room-backed implementation of the seam. Keep the legacy implementation and run both side by side behind a flag, on the same file only in test builds; never have two writers on a production file at the same time.
7. Do the per-unit cutover: move one table or one feature at a time behind the flag, reads first, then writes. Ship each step and watch crash and error rates.
8. ContentProvider: keep the provider class, its authority, its URIs and its permissions. Re-implement its `query`, `insert`, `update` and `delete` on top of the Room DAOs (or a Room `SupportSQLiteDatabase`) so that external callers see the same contract. Convert only the internals.
9. Take a backup before the first release that opens the file with Room, and keep it for the rollback window (see Rollback).
10. When every unit and the provider run on Room and the flag is at 100 percent after a full release, delete the old implementation: the helper class, cursor mappers, string SQL constants and the flag.

## Pitfalls

- Room checks the identity hash and the table shape on open. A mismatch in column type affinity, a missing index, a missing `NOT NULL`, or an extra column throws `IllegalStateException: Migration didn't properly handle` or an identity hash mismatch.
- `fallbackToDestructiveMigration` silently deletes user data on a version gap. Do not enable it for a database that holds user data.
- Views, triggers and `WITHOUT ROWID` tables need `@DatabaseView` or a migration with raw SQL, and are easy to lose.
- Run Room queries off the main thread. Legacy code that ran on the main thread will now fail the main-thread check; fix the callers, do not call `allowMainThreadQueries`.
- Date, boolean and enum columns need explicit `TypeConverter`s that read the legacy encoding (epoch millis versus text, 0 and 1).
- `PRAGMA foreign_keys` is off in the legacy helper by default but Room enforces declared foreign keys; legacy data with dangling references can start failing.
- Two processes (a provider process, a service in another process) opening the same file need `enableMultiInstanceInvalidation`.

## Tests

- `MigrationTestHelper` tests: create each real old-version database file in a test (from the committed schema JSON for known versions and from the collected real files), run the migration to the current version and call `runMigrationsAndValidate`.
- Open a real old-version database file copied from the collected set with the Room builder, then assert row counts and spot values for every table before and after.
- DAO tests with an in-memory Room database for each query.
- Contract tests on the seam: run the same test body against the legacy and the Room implementation during the side-by-side phase.
- ContentProvider tests that call the provider through `ContentResolver` and compare results with the recorded results of the old provider for each URI.
- A test that opens the database under every previously released `user_version` through the upgrade path, one by one.

## Security checklist

- Encryption is carried over: a SQLCipher database stays encrypted after the move by passing the SQLCipher `SupportFactory` to the Room builder, with the same key derivation and page settings, and a test opens the file with a wrong key and expects failure.
- The database key stays in the same protected place (Android Keystore wrapped key or equivalent) and is not moved into a plain preference, a constant or a log line while migrating.
- ContentProvider permissions are preserved: `android:exported`, read and write permissions, `grantUriPermissions` and path permissions in the manifest are identical after the move, and a test calls the provider without the permission and expects a security exception.
- Query parameters in the provider stay bound arguments, never concatenated into SQL, so the move does not add an injection path.
- No plaintext export: temporary copies of the database for the backup, tests or debugging are encrypted or deleted, and `android:allowBackup` and backup rules do not include the database unless that was already intended.
- Exported schema JSON, logs and crash reports contain no row data.

## Rollback

Before the first Room release, rollback is flipping the flag to the legacy implementation: Room only adds indices and a bumped `user_version`, and the legacy helper must tolerate the higher version (override `onDowngrade` to accept it, or keep the version unchanged where possible). Once the file has been migrated and the old code deleted, rollback is restoring the backup taken in step 9, which loses writes made since; so keep the legacy implementation and the flag for a full release and treat this playbook as one-way after that.
